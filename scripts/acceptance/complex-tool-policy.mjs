/** Five original complex scenarios: constrain dispatch, without hiding the catalog.
 * File guards protect host secrets; the separate kernel sandbox protects npm's
 * loaded JavaScript. Neither a command allow-list nor a mount substitutes for it.
 */
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { scopeOf } from '../../runtime/DSH/packages/core/scope/lib/index.js'
import { assertComplexSandboxProvider } from './complex-execution-sandbox.mjs'

export const name = 'xiaoshe-complex-tool-policy'
export const inject = ['tools', 'sandbox', 'sandboxPolicy']
const SCHEMA = 'xiaoshe-complex-tool-policy/v1'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
export const COMPLEX_SCENARIOS = Object.freeze(['code-repair', 'conflict-research', 'offline-to-online-topic-switch', 'failure-recovery', 'user-steer'])
const COMMON = ['read', 'todo_write', 'xiaoshe_capability_plan', 'xiaoshe_runtime_info']
const FILE_TOOLS = ['read', 'write', 'edit']
const fail = code => new Error(`complex-tool-policy: ${code}`)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }
export const complexSessionIds = runId => COMPLEX_SCENARIOS.map(id => `xiaoshe-harness-${id}-${runId}`)

function directory(path, privateMode = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw fail('noncanonical_directory')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
    || stat.uid !== process.getuid() || (privateMode && (stat.mode & 0o077))) throw fail('unsafe_directory')
}
function save(path, value) {
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
}
function readJson(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
    || (stat.mode & 0o077) || stat.size > 65_536) throw fail('invalid_ledger')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return JSON.parse(readFileSync(fd, 'utf8')) } finally { closeSync(fd) }
}

export function complexPolicy(config) {
  if (!object(config) || Object.keys(config).sort().join(',') !== 'acceptanceRoot,nodePath,npmPath,runId'
    || !UUID.test(config.runId ?? '')
    || config.acceptanceRoot !== join(realpathSync(tmpdir()), `xiaoshe-product-acceptance-${config.runId}`)
    || !isAbsolute(config.nodePath ?? '') || !isAbsolute(config.npmPath ?? '')) throw fail('invalid_config')
  directory(config.acceptanceRoot, true)
  const fixtureRoot = join(config.acceptanceRoot, 'workspace'), ledgerDirectory = join(config.acceptanceRoot, 'tool-policy')
  directory(fixtureRoot, true); directory(ledgerDirectory, true)
  const codeRoot = join(fixtureRoot, 'code-repair'), researchRoot = join(fixtureRoot, 'research')
  const recoveryRoot = join(fixtureRoot, 'recovery'), steerRoot = join(fixtureRoot, 'steer')
  for (const path of [codeRoot, researchRoot, recoveryRoot, steerRoot]) directory(path)
  const codeFiles = ['requirements.md', 'test/normalize.test.mjs', 'package.json', 'src/normalize.mjs'].map(p => join(codeRoot, p))
  const sources = ['2025-01-release.md', '2025-06-security.md', '2025-09-authority.md'].map(p => join(researchRoot, 'sources', p))
  const rows = [
    { id: 'code-repair', cwd: codeRoot, readPaths: codeFiles, writePaths: [join(codeRoot, 'src/normalize.mjs')], allowedTools: [...COMMON, 'write', 'edit', 'bash'] },
    { id: 'conflict-research', cwd: researchRoot, readPaths: sources, writePaths: [], allowedTools: COMMON },
    { id: 'offline-to-online-topic-switch', cwd: researchRoot, readPaths: sources, writePaths: [], allowedTools: [...COMMON, 'web_search', 'web_fetch'] },
    { id: 'failure-recovery', cwd: recoveryRoot, readPaths: ['missing-note.md', 'recovery-note.md'].map(p => join(recoveryRoot, 'sources', p)), writePaths: [], allowedTools: COMMON },
    { id: 'user-steer', cwd: steerRoot, readPaths: ['initial-a.md', 'initial-b.md', 'initial-c.md', 'steer-note.md'].map(p => join(steerRoot, 'sources', p)), writePaths: [], allowedTools: COMMON },
  ].map(row => ({ ...row, sessionId: `xiaoshe-harness-${row.id}-${config.runId}` }))
  const policy = { schema: SCHEMA, acceptanceRoot: config.acceptanceRoot, nodePath: config.nodePath,
    npmPath: config.npmPath, runId: config.runId, fixtureRoot, ledgerDirectory,
    temporaryRoot: join(config.acceptanceRoot, 'execution-temp'), scenarios: rows }
  return { ...policy, policyDigest: createHash('sha256').update(JSON.stringify(policy)).digest('hex') }
}

function pathDenial(policy, scenario, name, args) {
  if (typeof args.file_path !== 'string' || !args.file_path.trim() || args.file_path.includes('\0')) return 'invalid_file_path'
  const target = resolve(scenario.cwd, args.file_path)
  if (!(name === 'read' ? scenario.readPaths : scenario.writePaths).includes(target)) return 'path_not_allowed'
  try {
    let ancestor = dirname(target)
    while (inside(policy.fixtureRoot, ancestor)) {
      directory(ancestor)
      if (ancestor === policy.fixtureRoot) break
      ancestor = dirname(ancestor)
    }
    let stat
    try { stat = lstatSync(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
    // An allowed absent input MUST reach the real read tool. A synthetic guard
    // refusal would erase the failure-recovery scenario's required FS failure.
    if (!stat) return undefined
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
      || realpathSync(target) !== target) return 'unsafe_file_target'
  } catch { return 'unsafe_file_ancestor' }
}

export function complexCallDenial(policy, scenario, exec) {
  const args = exec.arguments
  if (!scenario.allowedTools.includes(exec.name)) return 'tool_not_allowed'
  if (!object(args)) return 'invalid_arguments'
  if (['sandbox_permissions', 'justification', 'env', 'environment'].some(key => Object.hasOwn(args, key))) return 'escalation_or_environment_forbidden'
  if (FILE_TOOLS.includes(exec.name)) return pathDenial(policy, scenario, exec.name, args)
  if (exec.name === 'bash') {
    if (Object.keys(args).some(key => !['command', 'description', 'timeoutMs', 'workdir', 'run_in_background'].includes(key))
      || typeof args.command !== 'string' || !/^npm\s+run\s+(?:typecheck|test|build)$/u.test(args.command.trim())
      || (args.run_in_background !== undefined && args.run_in_background !== false)
      || (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1))
      || (args.workdir !== undefined && (typeof args.workdir !== 'string' || resolve(scenario.cwd, args.workdir) !== scenario.cwd))) return 'verifier_not_allowed'
    try { directory(scenario.cwd) } catch { return 'unsafe_verifier_directory' }
  }
  if (exec.name === 'web_fetch') {
    if (Object.keys(args).join(',') !== 'url' || typeof args.url !== 'string') return 'public_fetch_only'
    try {
      const url = new URL(args.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'public_fetch_only'
      // The real HttpFetchProvider additionally validates and pins every DNS
      // address and redirect. This lexical check is not claimed as SSRF proof.
    } catch { return 'public_fetch_only' }
  }
}

export function installComplexToolPolicy(ctx, config, { assertSandbox = assertComplexSandboxProvider } = {}) {
  let policy, fatal
  const agents = new WeakMap()
  const latch = () => { fatal = fail('policy_unavailable'); return fatal }
  const assertReady = () => {
    if (fatal) throw fatal
    if (!policy || JSON.stringify(readJson(join(policy.ledgerDirectory, 'manifest.json'))) !== JSON.stringify(policy)) throw fail('policy_identity_changed')
    directory(policy.acceptanceRoot, true); directory(policy.ledgerDirectory, true)
  }
  const mount = (kind, sessionId) => save(join(policy.ledgerDirectory, `mounted-${process.pid}-${randomUUID()}.json`),
    { schema: SCHEMA, policyDigest: policy.policyDigest, runId: policy.runId, pid: process.pid, at: new Date().toISOString(), kind, sessionId })
  ctx.tools.guard(exec => {
    try { assertReady() } catch { return latch().message }
    return exec.agent && agents.has(exec.agent) ? undefined : 'complex-tool-policy: unmounted_agent'
  })
  ctx.on('agent/created', ({ agent }) => {
    try {
      assertReady()
      if (agents.has(agent)) return
      const scenario = policy.scenarios.find(row => row.sessionId === agent?.session?.id), header = agent?.session?.header
      if (!scenario || header?.id !== scenario.sessionId || header?.cwd !== scenario.cwd || header?.agentPreset !== 'standard'
        || header?.parentSession !== undefined || header?.origin === 'subagent'
        || scopeOf(agent.ctx) !== agent) throw fail('agent_identity_not_allowed')
      const dispose = agent.ctx.tools.guard(exec => {
        try {
          assertReady()
          if (exec.agent !== agent) return 'complex-tool-policy: wrong_agent'
          const denial = complexCallDenial(policy, scenario, exec)
          if (denial) return `complex-tool-policy: ${denial}`
          if (exec.name === 'bash') {
            if (ctx.sandboxPolicy.resolve({ session: agent.session }).mode !== 'workspace-write') return 'complex-tool-policy: unsafe_sandbox_mode'
            assertSandbox(ctx.sandbox, { nodePath: policy.nodePath, npmPath: policy.npmPath,
              fixtureRoot: policy.fixtureRoot, temporaryRoot: policy.temporaryRoot })
          }
          return undefined
        } catch { return latch().message }
      })
      try { mount('agent', scenario.sessionId) } catch (error) { dispose(); throw error }
      agents.set(agent, dispose)
    } catch (error) { fatal = error; throw error }
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => { agents.get(agent)?.(); agents.delete(agent) }, { global: true })
  try {
    policy = complexPolicy(config)
    assertSandbox(ctx.sandbox, { nodePath: policy.nodePath, npmPath: policy.npmPath,
      fixtureRoot: policy.fixtureRoot, temporaryRoot: policy.temporaryRoot })
    save(join(policy.ledgerDirectory, 'manifest.json'), policy); assertReady(); mount('host', null)
  }
  catch (error) { fatal = error }
  return { assertReady }
}

export function readComplexToolPolicy(ledgerDirectory) {
  directory(ledgerDirectory, true)
  const manifest = readJson(join(ledgerDirectory, 'manifest.json'))
  const expected = complexPolicy({ acceptanceRoot: manifest.acceptanceRoot, nodePath: manifest.nodePath, npmPath: manifest.npmPath, runId: manifest.runId })
  if (JSON.stringify(manifest) !== JSON.stringify(expected) || ledgerDirectory !== manifest.ledgerDirectory) throw fail('invalid_policy_manifest')
  const names = readdirSync(ledgerDirectory)
  if (names.length > 100 || names.some(file => file !== 'manifest.json' && !/^mounted-[1-9]\d*-[a-f0-9-]{36}\.json$/u.test(file))) throw fail('invalid_ledger_files')
  const mounts = names.filter(file => file.startsWith('mounted-')).map(file => {
    const row = readJson(join(ledgerDirectory, file))
    if (row.schema !== SCHEMA || row.policyDigest !== manifest.policyDigest || row.runId !== manifest.runId
      || row.pid !== Number(file.split('-')[1]) || !Number.isSafeInteger(row.pid) || row.pid < 1
      || !['host', 'agent'].includes(row.kind) || !Number.isFinite(Date.parse(row.at))
      || (row.kind === 'host' ? row.sessionId !== null : !complexSessionIds(row.runId).includes(row.sessionId))) throw fail('invalid_mount')
    return row
  })
  return { ...manifest, mounts, mountedSessionIds: mounts.filter(row => row.kind === 'agent'
    && mounts.some(host => host.kind === 'host' && host.pid === row.pid)).map(row => row.sessionId) }
}

export function apply(ctx, config) { installComplexToolPolicy(ctx, config) }
