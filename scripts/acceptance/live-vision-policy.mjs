// Acceptance-only monotonic execution fence. No catalog filtering, model/CLI
// dispatch, clipboard access, credential access or alternate image readers.
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { scopeOf } from '../../runtime/DSH/packages/core/scope/lib/index.js'
import { installExecutionPolicyFacts } from './execution-policy-facts.mjs'

export const name = 'xiaoshe-acceptance-vision-policy'
export const inject = ['tools', 'systemPrompt']
export const META_TOOLS = Object.freeze(['xiaoshe_runtime_info', 'xiaoshe_capability_plan'])
export const PATH_TOOLS = Object.freeze([...META_TOOLS, 'modlens_read_image'])
const SCHEMA = 'xiaoshe-live-vision-policy/v1'
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
const uuid = new RegExp(`^${UUID}$`, 'u')
const mountName = new RegExp(`^mounted-([1-9][0-9]*)-(${UUID})\\.json$`, 'u')
const fail = code => new Error(`acceptance-vision-policy: ${code}`)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => sha(JSON.stringify(value))
const object = value => value && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
const inside = (root, path) => { const value = relative(root, path); return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)) }

function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw fail('directory_must_be_canonical')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw fail('unsafe_directory')
  if (process.getuid && stat.uid !== process.getuid()) throw fail('foreign_directory_owner')
  return stat
}

function readOwnedFile(path, limit) {
  const valid = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= limit
    && (!process.getuid || stat.uid === process.getuid())
  const before = lstatSync(path)
  if (!valid(before)) throw fail('unsafe_file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!valid(opened) || opened.dev !== before.dev || opened.ino !== before.ino) throw fail('file_changed_during_read')
    const bytes = readFileSync(fd), after = fstatSync(fd), named = lstatSync(path)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || named.dev !== opened.dev || named.ino !== opened.ino || !valid(named)) throw fail('file_changed_during_read')
    return bytes
  } finally { closeSync(fd) }
}
const readJson = path => JSON.parse(readOwnedFile(path, 65_536).toString('utf8'))
function exclusiveJson(path, value) {
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
}
function assertImage(path, imageSha256) {
  if (realpathSync(path) !== path || sha(readOwnedFile(path, 20 * 1024 * 1024)) !== imageSha256) throw fail('image_identity_mismatch')
}

function policyFrom(config) {
  if (!object(config) || Object.keys(config).sort().join(',') !== 'imageSha256,inputKind,ledgerDirectory,runId,sessionId,workspaceRealPath'
    || !uuid.test(config.runId ?? '') || config.sessionId !== `xiaoshe-vision-${config.runId}`
    || !['path', 'attachment'].includes(config.inputKind) || !/^[a-f0-9]{64}$/u.test(config.imageSha256 ?? '')) throw fail('invalid_config')
  directory(config.workspaceRealPath); directory(config.ledgerDirectory)
  if (inside(config.workspaceRealPath, config.ledgerDirectory) || inside(config.ledgerDirectory, config.workspaceRealPath)) throw fail('ledger_must_be_outside_workspace')
  const imagePath = join(config.workspaceRealPath, 'input.png')
  assertImage(imagePath, config.imageSha256)
  const policy = { schema: SCHEMA, runId: config.runId, workspaceRealPath: config.workspaceRealPath,
    sessionIds: Object.freeze([config.sessionId]), inputKind: config.inputKind, imagePath, imageSha256: config.imageSha256,
    allowedTools: config.inputKind === 'path' ? PATH_TOOLS : META_TOOLS }
  return Object.freeze({ ...policy, policyDigest: digest(policy) })
}

/** Validate the complete immutable ledger, not only a caller-supplied pass bit.
 * A matching host + agent mount is required; image bytes are rechecked too. */
export function readLiveVisionPolicyLedger(ledgerDirectory) {
  directory(ledgerDirectory)
  const manifest = readJson(join(ledgerDirectory, 'manifest.json'))
  if (!object(manifest)) throw fail('invalid_policy_manifest')
  const { policyDigest, ...contents } = manifest
  if (manifest.schema !== SCHEMA || !/^[a-f0-9]{64}$/u.test(policyDigest ?? '') || digest(contents) !== policyDigest) throw fail('invalid_policy_manifest')
  const expected = policyFrom({ ledgerDirectory, runId: manifest.runId, workspaceRealPath: manifest.workspaceRealPath,
    sessionId: manifest.sessionIds?.[0], inputKind: manifest.inputKind, imageSha256: manifest.imageSha256 })
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw fail('invalid_policy_manifest')
  const files = readdirSync(ledgerDirectory)
  if (files.length > 1000 || files.some(file => file !== 'manifest.json' && !mountName.test(file))) throw fail('invalid_ledger_files')
  const mounts = files.filter(file => file !== 'manifest.json').sort().map(file => {
    const match = mountName.exec(file), row = readJson(join(ledgerDirectory, file))
    if (!object(row)) throw fail('invalid_mount_record')
    const { kind, sessionId, pid, at, ...observed } = row
    if (JSON.stringify(observed) !== JSON.stringify(manifest) || pid !== Number(match[1]) || !Number.isSafeInteger(pid)
      || typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at
      || !['host', 'agent'].includes(kind) || (kind === 'host' ? sessionId !== null : sessionId !== manifest.sessionIds[0])) throw fail('invalid_mount_record')
    return { file, kind, sessionId, pid, at, runId: row.runId, policyDigest }
  })
  const matched = row => row.kind === 'agent' && mounts.some(host => host.kind === 'host' && host.pid === row.pid && Date.parse(host.at) <= Date.parse(row.at))
  return { ...manifest, mounted: mounts.some(matched), mounts }
}

export function installLiveVisionPolicy(ctx, config) {
  let policy, ledgerDirectory, fatal, workspaceIdentity, ledgerIdentity
  const agents = new WeakMap(), ownMounts = new Map()
  let hostMountFile, policyFacts
  const failClosed = error => {
    fatal ??= fail(error?.message?.startsWith('acceptance-vision-policy: ') ? error.message.slice('acceptance-vision-policy: '.length) : 'ledger_or_policy_unavailable')
    return fatal
  }
  const ready = () => {
    try {
      if (fatal) throw fatal
      if (!policy) throw fail('policy_unavailable')
      const workspace = directory(policy.workspaceRealPath), ledger = directory(ledgerDirectory)
      if (workspace.dev !== workspaceIdentity.dev || workspace.ino !== workspaceIdentity.ino
        || ledger.dev !== ledgerIdentity.dev || ledger.ino !== ledgerIdentity.ino) throw fail('directory_identity_changed')
      const { mounted: _mounted, mounts: _mounts, ...manifest } = readLiveVisionPolicyLedger(ledgerDirectory)
      if (JSON.stringify(manifest) !== JSON.stringify(policy)) throw fail('policy_identity_changed')
      for (const [file, record] of ownMounts) if (JSON.stringify(readJson(join(ledgerDirectory, file))) !== record) throw fail('mount_identity_changed')
    } catch (error) { throw failClosed(error) }
  }
  const ledgerDenial = () => { try { ready() } catch (error) { return error.message } }
  const validAgent = agent => {
    const header = agent?.session?.header
    return agent?.session?.id === policy.sessionIds[0] && header?.id === policy.sessionIds[0]
      && header?.cwd === policy.workspaceRealPath && header?.agentPreset === 'standard'
      && header?.parentSession === undefined && header?.origin !== 'subagent'
      && typeof agent.ctx?.tools?.guard === 'function' && scopeOf(agent.ctx) === agent
  }
  ctx.tools.guard(exec => {
    const denied = ledgerDenial()
    if (denied) return denied
    const entry = exec.agent && agents.get(exec.agent)
    return entry && entry.context === exec.agent.ctx && validAgent(exec.agent) ? undefined : 'acceptance-vision-policy: unmounted_agent'
  })
  const mount = (kind, sessionId) => {
    const file = `mounted-${process.pid}-${randomUUID()}.json`
    const record = { ...policy, kind, sessionId, pid: process.pid, at: new Date().toISOString() }
    exclusiveJson(join(ledgerDirectory, file), record)
    ownMounts.set(file, JSON.stringify(record))
    return file
  }
  ctx.on('agent/created', ({ agent }) => {
    try {
      ready()
      if (agents.has(agent)) return
      if (!validAgent(agent)) throw fail('agent_identity_not_allowed')
      const dispose = agent.ctx.tools.guard(exec => {
        const denied = ledgerDenial()
        if (denied) return denied
        if (exec.agent !== agent || !policy.allowedTools.includes(exec.name)) return 'acceptance-vision-policy: tool_not_allowed'
        if (!object(exec.arguments)) return 'acceptance-vision-policy: invalid_arguments'
        if (Object.hasOwn(exec.arguments, 'sandbox_permissions') || Object.hasOwn(exec.arguments, 'justification')) return 'acceptance-vision-policy: escalation_forbidden'
        if (exec.name === 'modlens_read_image') {
          if (exec.arguments.path !== policy.imagePath || Object.keys(exec.arguments).some(key => !['path', 'prompt'].includes(key))) return 'acceptance-vision-policy: path_not_allowed'
          // ready() already checked the exact file through O_NOFOLLOW + hash.
          // The independently guarded engine rechecks before its real launch;
          // this execution guard alone is not a cross-process filesystem lock.
        }
        return undefined
      })
      let mountFile
      try { mountFile = mount('agent', agent.session.id) } catch (error) { dispose(); throw error }
      agents.set(agent, { context: agent.ctx, dispose, mountFile })
      policyFacts.mount(agent)
    } catch (error) { throw failClosed(error) }
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => { policyFacts?.unmount(agent); agents.get(agent)?.dispose(); agents.delete(agent) }, { global: true })
  try {
    policy = policyFrom(config); ledgerDirectory = config.ledgerDirectory
    workspaceIdentity = directory(policy.workspaceRealPath); ledgerIdentity = directory(ledgerDirectory)
    try { exclusiveJson(join(ledgerDirectory, 'manifest.json'), policy) } catch (error) { if (error.code !== 'EEXIST') throw error }
    ready(); hostMountFile = mount('host', null)
    // Keep setup failures behind the same host-wide rejecting backstop.
    policyFacts = installExecutionPolicyFacts(ctx, { issuer: name, readCurrent: agent => {
      ready()
      const entry = agents.get(agent)
      if (!entry || entry.context !== agent.ctx || !validAgent(agent)) throw fail('facts_agent_unmounted')
      return { policy, ledger: readLiveVisionPolicyLedger(ledgerDirectory), hostMountFile, agentMountFile: entry.mountFile }
    } })
  } catch (error) { failClosed(error) }
  return Object.freeze({ assertReady: ready })
}

export function apply(ctx, config) { installLiveVisionPolicy(ctx, config) }
