// Isolated model acceptance only: a monotonic execution fence, never a catalog filter.
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { scopeOf } from '../../runtime/DSH/packages/core/scope/lib/index.js'
import { installExecutionPolicyFacts } from './execution-policy-facts.mjs'

export const name = 'xiaoshe-acceptance-material-policy'
export const inject = ['tools', 'systemPrompt']
export const ALLOWED_TOOLS = Object.freeze(['read', 'write', 'todo_write', 'xiaoshe_runtime_info', 'xiaoshe_capability_plan',
  'browser_status', 'browser_open', 'browser_snapshot', 'browser_type', 'browser_click', 'browser_verify',
  'browser_press', 'browser_scroll', 'browser_close'])
const SCHEMA = 'xiaoshe-live-material-policy/v2'
const LEGACY_SCHEMA = 'xiaoshe-live-material-policy/v1'
const MATERIAL_SCENARIOS = Object.freeze(['normal', 'missing_input', 'response_lost', 'takeover'])
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
const uuid = new RegExp(`^${UUID}$`, 'u')
const mountName = new RegExp(`^mounted-([1-9][0-9]*)-(${UUID})\\.json$`, 'u')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = code => new Error(`acceptance-material-policy: ${code}`)
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const inside = (root, path) => { const value = relative(root, path); return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)) }

function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw fail('directory_must_be_canonical')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw fail('unsafe_directory')
  if (process.getuid !== undefined && stat.uid !== process.getuid()) throw fail('foreign_directory_owner')
}

function exclusiveJson(path, value) {
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
}

function readJson(path) {
  const before = lstatSync(path)
  const valid = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 65_536
    && (process.getuid === undefined || stat.uid === process.getuid())
  if (!valid(before)) throw fail('invalid_ledger')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!valid(opened) || opened.dev !== before.dev || opened.ino !== before.ino) throw fail('ledger_changed_during_read')
    const bytes = readFileSync(fd, 'utf8')
    const after = fstatSync(fd)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw fail('ledger_changed_during_read')
    return JSON.parse(bytes)
  } finally { closeSync(fd) }
}

function loopbackUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.trim() !== value || /[\x00-\x20\\]/u.test(value)) throw fail('invalid_fixture_url')
  let url
  try { url = new URL(value) } catch { throw fail('invalid_fixture_url') }
  const port = Number(url.port)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535
    || port === 3080 || url.username || url.password || url.hash || value.includes('#')) throw fail('invalid_fixture_url')
  return url
}

function policyFrom(config, legacyReadOnly = false) {
  if (!object(config) || Object.values(Object.getOwnPropertyDescriptors(config)).some(row => !Object.hasOwn(row, 'value'))
    || !uuid.test(config.runId ?? '') || !Array.isArray(config.sessionIds) || config.sessionIds.length !== 1
    || !['material', 'batch'].some(kind => config.sessionIds[0] === `xiaoshe-${kind}-${config.runId}`)) throw fail('invalid_config')
  const batch = config.sessionIds[0] === `xiaoshe-batch-${config.runId}`
  const needsScenario = !batch && !legacyReadOnly
  const keys = ['fixtureUrl', 'ledgerDirectory', 'runId', 'sessionIds', 'workspaceRealPath', ...(needsScenario ? ['scenario'] : [])].sort()
  if (Reflect.ownKeys(config).length !== keys.length || Object.keys(config).sort().join(',') !== keys.join(',')
    || needsScenario && !MATERIAL_SCENARIOS.includes(config.scenario)) throw fail('invalid_config')
  directory(config.workspaceRealPath)
  directory(config.ledgerDirectory)
  directory(join(config.workspaceRealPath, 'output'))
  if (inside(config.workspaceRealPath, config.ledgerDirectory) || inside(config.ledgerDirectory, config.workspaceRealPath)) throw fail('ledger_must_be_outside_workspace')
  const fixture = loopbackUrl(config.fixtureUrl)
  if (fixture.search || !fixture.pathname.endsWith('/') || fixture.pathname === '/' || /%(?:2e|2f|5c)/iu.test(fixture.pathname)
    || fixture.href !== config.fixtureUrl) throw fail('invalid_fixture_base')
  // Two fixed acceptance workflows, not caller-supplied path expansion. The
  // same ledger survives seed/resume; changing identity never refills scope.
  if (batch && fixture.pathname !== `/${config.runId}/`) throw fail('invalid_batch_fixture_base')
  const pairs = [1, 2, 3].map(index => [`input-${index}.jsonl`, `output/item-${index}.json`])
  const browserPaths = batch ? [1, 2, 3].flatMap(index => [`${fixture.pathname}item-${index}/`, `${fixture.pathname}item-${index}/record`]) : [fixture.pathname, `${fixture.pathname}record`]
  // Legacy scope is reconstructed only by the historical reader below. Every
  // new material mount binds exactly the task's input, never both scenarios.
  const readPaths = batch ? pairs.flat() : legacyReadOnly ? ['input.jsonl', 'missing.jsonl', 'output/result.json']
    : [config.scenario === 'missing_input' ? 'missing.jsonl' : 'input.jsonl', 'output/result.json']
  const writePaths = batch ? pairs.map(pair => pair[1]) : ['output/result.json']
  const policy = { schema: legacyReadOnly ? LEGACY_SCHEMA : SCHEMA, runId: config.runId, workspaceRealPath: config.workspaceRealPath,
    ...(needsScenario ? { scenario: config.scenario } : {}),
    sessionIds: Object.freeze([...config.sessionIds]), allowedTools: ALLOWED_TOOLS, fixtureUrl: fixture.href,
    browserOrigin: fixture.origin, browserPaths: Object.freeze(browserPaths),
    readPaths: Object.freeze(readPaths.map(path => join(config.workspaceRealPath, path))),
    writePaths: Object.freeze(writePaths.map(path => join(config.workspaceRealPath, path))) }
  return Object.freeze({ ...policy, policyDigest: hash(policy) })
}

function pathDenial(policy, tool, args) {
  if (!object(args) || typeof args.file_path !== 'string' || !args.file_path.trim() || args.file_path.includes('\0')) return 'invalid_file_path'
  const target = resolve(policy.workspaceRealPath, args.file_path)
  if (!(tool === 'read' ? policy.readPaths : policy.writePaths).includes(target)) return 'path_not_allowed'
  try {
    let current = dirname(target)
    while (inside(policy.workspaceRealPath, current)) {
      directory(current)
      if (current === policy.workspaceRealPath) break
      current = dirname(current)
    }
    let stat
    try { stat = lstatSync(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
    // Absence is intentionally NOT a policy error. The actual file tool must
    // observe it and return its native not-found failure (FS_NOT_FOUND today).
    if (stat === undefined) return undefined
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(target) !== target) return 'unsafe_file_target'
    return undefined
  } catch { return 'unsafe_file_ancestor' }
}

function browserOpenDenial(policy, args) {
  if (!object(args)) return 'invalid_browser_url'
  try {
    const url = loopbackUrl(args.url)
    if (url.origin !== policy.browserOrigin || !policy.browserPaths.includes(url.pathname)) return 'browser_url_not_allowed'
    return undefined
  } catch { return 'invalid_browser_url' }
}

/** Independently validate the entire bounded ledger; host-only proof is not an agent mount. */
export function readLiveMaterialPolicyLedger(ledgerDirectory) {
  directory(ledgerDirectory)
  const manifest = readJson(join(ledgerDirectory, 'manifest.json'))
  if (!object(manifest)) throw fail('invalid_policy_manifest')
  const { policyDigest, ...contents } = manifest
  if (![SCHEMA, LEGACY_SCHEMA].includes(manifest.schema) || !/^[a-f0-9]{64}$/u.test(policyDigest ?? '') || hash(contents) !== policyDigest) throw fail('invalid_policy_manifest')
  // Compatibility is read-only: no public config flag selects the v1 table,
  // and install/assertLedger below always requires this implementation's v2.
  const expected = policyFrom({ ledgerDirectory, runId: manifest.runId, workspaceRealPath: manifest.workspaceRealPath,
    sessionIds: manifest.sessionIds, fixtureUrl: manifest.fixtureUrl,
    ...(Object.hasOwn(manifest, 'scenario') ? { scenario: manifest.scenario } : {}) }, manifest.schema === LEGACY_SCHEMA)
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw fail('invalid_policy_manifest')
  const files = readdirSync(ledgerDirectory)
  if (files.length > 1000 || files.some(file => file !== 'manifest.json' && !mountName.test(file))) throw fail('invalid_ledger_files')
  const rows = files.filter(file => file !== 'manifest.json').sort().map(file => {
    const match = mountName.exec(file), row = readJson(join(ledgerDirectory, file))
    if (!object(row)) throw fail('invalid_mount_record')
    const { kind, sessionId, pid, at, ...observed } = row
    if (JSON.stringify(observed) !== JSON.stringify(manifest) || pid !== Number(match[1]) || !Number.isSafeInteger(pid)
      || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at || !['host', 'agent'].includes(kind)
      || (kind === 'host' ? sessionId !== null : sessionId !== manifest.sessionIds[0])) throw fail('invalid_mount_record')
    return { file, kind, sessionId, pid, at, runId: row.runId, policyDigest }
  })
  const matched = row => row.kind === 'agent' && rows.some(host => host.kind === 'host' && host.pid === row.pid && Date.parse(host.at) <= Date.parse(row.at))
  return { ...manifest, mounted: rows.some(matched), mounts: rows }
}

/** No mask/restrict calls: inherited authorization and product tab ownership remain authoritative. */
export function installLiveMaterialPolicy(ctx, config) {
  let policy, ledgerDirectory, fatal
  const agents = new WeakMap(), ownMounts = new Map()
  let hostMountFile, policyFacts
  const failClosed = error => {
    fatal ??= fail(error?.message?.startsWith('acceptance-material-policy: ') ? error.message.slice('acceptance-material-policy: '.length) : 'ledger_or_policy_unavailable')
    return fatal
  }
  const assertLedger = () => {
    if (fatal) throw fatal
    if (!policy) throw fail('policy_unavailable')
    const current = readLiveMaterialPolicyLedger(ledgerDirectory)
    if (current.schema !== SCHEMA) throw fail('historical_policy_not_mountable')
    const { mounted: _mounted, mounts: _mounts, ...manifest } = current
    if (JSON.stringify(manifest) !== JSON.stringify(policy)) throw fail('policy_identity_changed')
    for (const [file, expected] of ownMounts) {
      if (JSON.stringify(readJson(join(ledgerDirectory, file))) !== expected) throw fail('mount_identity_changed')
    }
  }
  const ready = () => { try { assertLedger() } catch (error) { throw failClosed(error) } }
  const guardLedger = () => { try { ready() } catch (error) { return error.message } }
  const validAgent = agent => {
    const header = agent?.session?.header
    return agent?.session?.id === policy.sessionIds[0] && header?.id === policy.sessionIds[0] && header?.cwd === policy.workspaceRealPath
      && header?.agentPreset === 'standard' && header?.parentSession === undefined && header?.origin !== 'subagent'
      && typeof agent.ctx?.tools?.guard === 'function' && scopeOf(agent.ctx) === agent
  }
  ctx.tools.guard(exec => {
    const denied = guardLedger()
    if (denied) return denied
    const entry = exec.agent && agents.get(exec.agent)
    // Revalidate mutable session/scope references on every dispatch. The real
    // filesystem resolves against session.cwd, not against this policy object.
    return entry && entry.context === exec.agent.ctx && validAgent(exec.agent) ? undefined : 'acceptance-material-policy: unmounted_agent'
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
      const header = agent?.session?.header
      if (agent?.session?.id !== policy.sessionIds[0] || header?.id !== policy.sessionIds[0] || header?.cwd !== policy.workspaceRealPath
        || header?.agentPreset !== 'standard' || header?.parentSession !== undefined || header?.origin === 'subagent') throw fail('agent_identity_not_allowed')
      if (typeof agent.ctx?.tools?.guard !== 'function' || scopeOf(agent.ctx) !== agent) throw fail('scoped_tools_unavailable')
      const dispose = agent.ctx.tools.guard(exec => {
        const denied = guardLedger()
        if (denied) return denied
        if (exec.agent !== agent || !ALLOWED_TOOLS.includes(exec.name)) return 'acceptance-material-policy: tool_not_allowed'
        if (object(exec.arguments) && (Object.hasOwn(exec.arguments, 'sandbox_permissions') || Object.hasOwn(exec.arguments, 'justification'))) return 'acceptance-material-policy: escalation_forbidden'
        const reason = exec.name === 'read' || exec.name === 'write' ? pathDenial(policy, exec.name, exec.arguments)
          : exec.name === 'browser_open' ? browserOpenDenial(policy, exec.arguments) : undefined
        return reason ? `acceptance-material-policy: ${reason}` : undefined
      })
      let mountFile
      try { mountFile = mount('agent', agent.session.id) } catch (error) { dispose(); throw error }
      agents.set(agent, { context: agent.ctx, dispose, mountFile })
      policyFacts.mount(agent)
    } catch (error) { throw failClosed(error) }
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => { policyFacts?.unmount(agent); agents.get(agent)?.dispose(); agents.delete(agent) }, { global: true })
  try {
    policy = policyFrom(config)
    ledgerDirectory = config.ledgerDirectory
    try { exclusiveJson(join(ledgerDirectory, 'manifest.json'), policy) } catch (error) { if (error.code !== 'EEXIST') throw error }
    ready()
    hostMountFile = mount('host', null)
    // Disclosure must not throw before the rejecting backstop is installed.
    // It reads this owner's existing readiness and private current mount only.
    policyFacts = installExecutionPolicyFacts(ctx, { issuer: name, readCurrent: agent => {
      ready()
      const entry = agents.get(agent)
      if (!entry || entry.context !== agent.ctx || !validAgent(agent)) throw fail('facts_agent_unmounted')
      return { policy, ledger: readLiveMaterialPolicyLedger(ledgerDirectory), hostMountFile, agentMountFile: entry.mountFile }
    } })
  } catch (error) { failClosed(error) }
  return Object.freeze({ assertReady: ready })
}

export function apply(ctx, config) { installLiveMaterialPolicy(ctx, config) }
