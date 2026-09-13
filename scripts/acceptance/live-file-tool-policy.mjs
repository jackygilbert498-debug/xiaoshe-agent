// Isolated acceptance only. This is an execution fence, not a catalog filter.
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { scopeOf } from '../../runtime/DSH/packages/core/scope/lib/index.js'

export const name = 'xiaoshe-acceptance-file-tool-policy'
export const inject = ['tools']
const SCHEMA = 'xiaoshe-live-file-tool-policy/v1'
// The product requires a standing plan for multi-step work. todo_write only
// appends to the owning session; allowing it does not change either file fence.
export const ALLOWED_TOOLS = Object.freeze(['read', 'write', 'xiaoshe_capability_plan', 'xiaoshe_runtime_info', 'todo_write'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/u.test(value)
const fail = code => new Error(`acceptance-file-policy: ${code}`)
const inside = (root, path) => { const value = relative(root, path); return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)) }

function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw fail('directory_must_be_canonical')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw fail('unsafe_directory')
  if (process.getuid !== undefined && stat.uid !== process.getuid()) throw fail('foreign_directory_owner')
  return stat
}

function exclusiveJson(path, value) {
  const file = openSync(path, 'wx', 0o600)
  try { writeFileSync(file, `${JSON.stringify(value)}\n`); fsyncSync(file) } finally { closeSync(file) }
}

function readJson(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65_536) throw fail('invalid_ledger')
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return JSON.parse(readFileSync(file, 'utf8')) } finally { closeSync(file) }
}

function policyFrom(config) {
  if (!object(config) || Object.keys(config).sort().join(',') !== 'ledgerDirectory,runId,sessionIds,workspaceRealPath'
    || !id(config.runId) || !Array.isArray(config.sessionIds) || config.sessionIds.length !== 1 || !id(config.sessionIds[0])) throw fail('invalid_config')
  directory(config.workspaceRealPath)
  directory(config.ledgerDirectory)
  if (inside(config.workspaceRealPath, config.ledgerDirectory) || inside(config.ledgerDirectory, config.workspaceRealPath)) throw fail('ledger_must_be_outside_workspace')
  directory(join(config.workspaceRealPath, 'output'))
  const policy = { schema: SCHEMA, runId: config.runId, workspaceRealPath: config.workspaceRealPath,
    sessionIds: [...config.sessionIds], allowedTools: [...ALLOWED_TOOLS],
    readPaths: [join(config.workspaceRealPath, 'input.jsonl'), join(config.workspaceRealPath, 'output/result.json')],
    writePaths: [join(config.workspaceRealPath, 'output/result.json')] }
  return Object.freeze({ ...policy, policyDigest: createHash('sha256').update(JSON.stringify(policy)).digest('hex') })
}

// Check lexical target first, then every existing ancestor and the final file.
// This keeps both reads and writes away from Profile/credentials; the built-in
// workspace-write sandbox alone does not restrict reads or all platform temp.
function pathDenial(policy, name, args) {
  if (!object(args) || typeof args.file_path !== 'string' || args.file_path.trim() === '' || args.file_path.includes('\0')) return 'invalid_file_path'
  if (Object.hasOwn(args, 'sandbox_permissions') || Object.hasOwn(args, 'justification')) return 'escalation_forbidden'
  const target = resolve(policy.workspaceRealPath, args.file_path)
  if (!(name === 'read' ? policy.readPaths : policy.writePaths).includes(target)) return 'path_not_allowed'
  try {
    directory(policy.workspaceRealPath)
    let current = dirname(target)
    while (inside(policy.workspaceRealPath, current)) {
      directory(current)
      if (current === policy.workspaceRealPath) break
      current = dirname(current)
    }
    let stat
    try { stat = lstatSync(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (stat === undefined) return name === 'write' ? undefined : 'read_target_missing'
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(target) !== target) return 'unsafe_file_target'
    return undefined
  } catch { return 'unsafe_file_ancestor' }
}

/** Install guards before recording a mount. Initialization faults latch closed. */
export function installLiveFileToolPolicy(ctx, config) {
  let policy, fatal
  const agents = new WeakMap()
  const failClosed = error => { fatal = fail(error?.message?.startsWith('acceptance-file-policy:') ? error.message.split(': ').at(-1) : 'ledger_or_policy_unavailable'); return fatal }
  const assertLedger = () => {
    if (fatal) throw fatal
    if (!policy || JSON.stringify(readJson(join(config.ledgerDirectory, 'manifest.json'))) !== JSON.stringify(policy)) throw fail('policy_identity_changed')
  }
  // No agent, an event that never reached our creation hook, or an initialization
  // failure must not bypass the per-agent fence. This never changes visibility.
  ctx.tools.guard(exec => {
    try { assertLedger() } catch (error) { return failClosed(error).message }
    return exec.agent && agents.has(exec.agent) ? undefined : 'acceptance-file-policy: unmounted_agent'
  })
  const mount = (kind, sessionId) => {
    const record = { ...policy, kind, sessionId, pid: process.pid, at: new Date().toISOString() }
    exclusiveJson(join(config.ledgerDirectory, `mounted-${process.pid}-${randomUUID()}.json`), record)
  }
  ctx.on('agent/created', ({ agent }) => {
    try {
      assertLedger()
      if (agents.has(agent)) return
      const header = agent?.session?.header
      if (!policy.sessionIds.includes(agent?.session?.id) || header?.id !== agent.session.id
        || header?.cwd !== policy.workspaceRealPath || header?.agentPreset !== 'standard'
        || header?.parentSession !== undefined || header?.origin === 'subagent') throw fail('agent_identity_not_allowed')
      if (typeof agent.ctx?.tools?.guard !== 'function' || scopeOf(agent.ctx) !== agent) throw fail('scoped_tools_unavailable')
      const dispose = agent.ctx.tools.guard(exec => {
        try { assertLedger() } catch (error) { return failClosed(error).message }
        if (exec.agent !== agent || !ALLOWED_TOOLS.includes(exec.name)) return 'acceptance-file-policy: tool_not_allowed'
        if (exec.name === 'read' || exec.name === 'write') {
          const reason = pathDenial(policy, exec.name, exec.arguments)
          if (reason) return `acceptance-file-policy: ${reason}`
        }
        return undefined
      })
      // Publish membership only after the real scope guard and its durable
      // mount are present. Failure leaves the host backstop denying this agent.
      try { mount('agent', agent.session.id) } catch (error) { dispose(); throw error }
      agents.set(agent, dispose)
    } catch (error) { throw failClosed(error) }
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => { agents.get(agent)?.(); agents.delete(agent) }, { global: true })
  try {
    policy = policyFrom(config)
    const manifest = join(config.ledgerDirectory, 'manifest.json')
    try { exclusiveJson(manifest, policy) } catch (error) { if (error.code !== 'EEXIST') throw error }
    assertLedger()
    mount('host', null)
  } catch (error) { failClosed(error) }
  return { assertReady: assertLedger }
}

/** Independent bounded reader; a manifest or host mount alone proves no agent. */
export function readLiveFileToolPolicyLedger(ledgerDirectory) {
  directory(ledgerDirectory)
  const manifest = readJson(join(ledgerDirectory, 'manifest.json'))
  const { policyDigest, ...contents } = manifest
  if (manifest.schema !== SCHEMA || !/^[a-f0-9]{64}$/u.test(policyDigest ?? '')
    || createHash('sha256').update(JSON.stringify(contents)).digest('hex') !== policyDigest
    || JSON.stringify(manifest.allowedTools) !== JSON.stringify(ALLOWED_TOOLS)) throw fail('invalid_policy_manifest')
  const expected = policyFrom({ ledgerDirectory, workspaceRealPath: manifest.workspaceRealPath,
    runId: manifest.runId, sessionIds: manifest.sessionIds })
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw fail('invalid_policy_manifest')
  const files = readdirSync(ledgerDirectory)
  if (files.length > 1_000) throw fail('ledger_too_large')
  const mounts = files.filter(file => file.startsWith('mounted-')).sort().map(file => {
    const match = /^mounted-([1-9]\d*)-[a-f0-9-]{36}\.json$/u.exec(file)
    if (!match) throw fail('invalid_mount_name')
    const row = readJson(join(ledgerDirectory, file))
    const { kind, sessionId, pid, at, ...observed } = row
    if (JSON.stringify(observed) !== JSON.stringify(manifest) || pid !== Number(match[1])
      || !Number.isSafeInteger(pid) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at
      || !['host', 'agent'].includes(kind) || (kind === 'host' ? sessionId !== null : !manifest.sessionIds.includes(sessionId))) throw fail('invalid_mount_record')
    return { file, kind, sessionId, pid, at, runId: row.runId, policyDigest }
  })
  return { ...manifest, mounted: mounts.some(row => row.kind === 'agent'
    && mounts.some(host => host.kind === 'host' && host.pid === row.pid)), mounts }
}

export function apply(ctx, config) { installLiveFileToolPolicy(ctx, config) }
