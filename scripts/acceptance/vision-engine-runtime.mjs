/** Acceptance only. One Codex process launch, not a monetary/internal-request cap.
 * Never reads/copies auth. The actual child alone receives an existing CODEX_HOME
 * reference. A killed host cannot execute finally: the outer owner must retain
 * launch.json and independently reconcile its PID before deleting the run. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual as equal } from 'node:util'
import { releaseVisionProcessGroup } from '../modlens-vision-runtime.mjs'
import { assertCodexSchemaFile } from '../modlens-codex-schema.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const id = value => typeof value === 'string' && /^[\w.-]{1,200}$/u.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const fail = code => Object.assign(new Error(`vision-engine: ${code}`), { code })
const iso = value => typeof value === 'string' && new Date(value).toISOString() === value
const inside = (root, path) => { const part = relative(root, path); return !!part && !part.startsWith('..') && !isAbsolute(part) }
const now = () => new Date().toISOString()
// Flags were verified by the outer owner against the installed CLI and official
// documentation. They do not cap the CLI's internal HTTP requests or billing.
export const CODEX_VISION_PREFIX = Object.freeze(['exec', '--ignore-user-config', '--ignore-rules',
  '-c', 'model_reasoning_effort="low"', '-c', 'features.apps=false', '-c', 'agents.enabled=false',
  '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'web_search="disabled"',
  '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--json', '-i'])

export function validateVisionEngineConfig(config) {
  const keys = ['runId', 'sessionId', 'acceptanceRoot', 'ledgerDirectory', 'workDirectory', 'isolatedHome', 'authHome', 'executable', 'executableSha256', 'model', 'imageSha256', 'outputSchemaPath', 'outputSchemaSha256']
  if (!config || Object.keys(config).sort().join(',') !== keys.sort().join(',') || !id(config.runId) || !id(config.sessionId)
    || !id(config.model) || !digest(config.imageSha256) || !digest(config.executableSha256) || !digest(config.outputSchemaSha256)
    || ['acceptanceRoot', 'ledgerDirectory', 'workDirectory', 'isolatedHome', 'authHome', 'executable', 'outputSchemaPath'].some(key => !isAbsolute(config[key] ?? '') || resolve(config[key]) !== config[key])
    || !inside(config.acceptanceRoot, config.outputSchemaPath)
    || ['ledgerDirectory', 'workDirectory', 'isolatedHome'].some(key => !inside(config.acceptanceRoot, config[key]))
    || inside(config.acceptanceRoot, config.authHome) || config.authHome === config.acceptanceRoot
    || new Set([config.ledgerDirectory, config.workDirectory, config.isolatedHome]).size !== 3) throw fail('invalid_config')
  return Object.freeze({ ...config })
}
async function safeBytes(path, max = 2 * 1024 * 1024) {
  const stat = await fs.lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw fail('unsafe_file')
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return await file.readFile() } finally { await file.close() }
}
async function readJson(path) { return JSON.parse(await safeBytes(path)) }
async function exclusive(path, value) {
  const handle = await fs.open(path, 'wx', 0o600)
  // Partial reservations are consumed and never removed on failure/restart.
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync() } finally { await handle.close() }
}
async function directory(path) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 })
  if (await fs.realpath(path) !== path || !(await fs.lstat(path)).isDirectory()) throw fail('unsafe_directory')
}
const manifestFor = config => ({ schema: 'xiaoshe-vision-engine-budget/v1', runId: config.runId, sessionId: config.sessionId,
  maxLaunches: 1, provider: 'codex-cli', model: config.model, executable: config.executable,
  executableSha256: config.executableSha256, imageSha256: config.imageSha256,
  outputSchemaPath: config.outputSchemaPath, outputSchemaSha256: config.outputSchemaSha256,
  authReferenceSha256: sha(config.authHome), workDirectory: config.workDirectory, isolatedHome: config.isolatedHome })

/** Local child seam for real Node integration tests; production uses only the
 * fixed invocation assembled below. No shell, user env dump or stderr content. */
export async function runOwnedVisionEngine(command, args, { cwd, env, signal, timeoutMs, onSpawn = async () => {} }) {
  if (process.platform === 'win32') throw fail('posix_required')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw fail('invalid_timeout')
  if (signal?.aborted) throw fail('VISION_CANCELLED')
  const startedAt = now(), child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let error, settling = false, bytes = 0, stderrBytes = 0, killTimer, closed = false
  const stdout = [], stderrHash = createHash('sha256')
  let forceFinish
  const forced = new Promise(resolve => { forceFinish = resolve })
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', cause => { error ??= fail(cause.code ?? 'spawn_failed'); resolve({ code: null, signal: null }) })
  })
  const drained = new Promise(resolve => child.once('close', () => { closed = true; resolve() }))
  const stop = code => {
    error ??= fail(code)
    if (settling || killTimer || !child.pid) return
    // Kill immediately: acceptance cancellation does not need engine grace or
    // another model response. Independent group probing still follows.
    try { process.kill(-child.pid, 'SIGKILL') } catch (cause) { if (cause.code !== 'ESRCH') error.signalErrorCode = cause.code }
    killTimer = setTimeout(() => forceFinish({ code: null, signal: null }), 100)
  }
  const abort = () => stop('VISION_CANCELLED')
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop('VISION_TIMEOUT'), timeoutMs)
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop('VISION_OUTPUT_LIMIT'); else stdout.push(chunk) })
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; stderrHash.update(chunk); if (stderrBytes > 2 * 1024 * 1024) stop('VISION_OUTPUT_LIMIT') })
  child.stdout.on('error', () => stop('VISION_OUTPUT_ERROR')); child.stderr.on('error', () => stop('VISION_OUTPUT_ERROR'))
  if (signal?.aborted) abort()
  let launchError
  try { if (child.pid) await onSpawn({ pid: child.pid, startedAt }) } catch (cause) { launchError = cause; stop('launch_record_failed') }
  const exit = await Promise.race([exited, forced]); settling = true
  clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort)
  let cleanup, cleanupError
  try { cleanup = child.pid ? await releaseVisionProcessGroup(child.pid) : { status: 'not-started', method: 'none' } }
  catch (cause) { cleanupError = cause; cleanup = cause.cleanup }
  let drainTimer
  if (!closed) await Promise.race([drained, new Promise(resolve => { drainTimer = setTimeout(resolve, 1000) })])
  clearTimeout(drainTimer)
  if (!closed) error ??= fail('VISION_OUTPUT_DRAIN_FAILED')
  if (signal?.aborted) error ??= fail('VISION_CANCELLED')
  child.stdout.destroy(); child.stderr.destroy(); child.unref()
  const result = { pid: child.pid ?? null, startedAt, finishedAt: now(), exitCode: exit.code, signal: exit.signal,
    cleanup, stdout: Buffer.concat(stdout).toString('utf8'), stderrBytes, stderrSha256: stderrHash.digest('hex') }
  if (cleanupError || error || launchError || exit.code !== 0) {
    const rejected = fail(cleanupError ? 'VISION_CLEANUP_FAILED' : error?.code ?? 'engine_exit_failed')
    rejected.originalCode = error?.code ?? null; rejected.cause = cleanupError ?? launchError ?? error
    rejected.result = result; throw rejected
  }
  return result
}

/** Only actual JSONL engine events can produce the parsed observation. Tool
 * execution/error events are rejected; raw bytes are retained independently. */
export function parseCodexVisionEvents(stdout) {
  const lines = stdout.trim().split('\n')
  if (!stdout.trim() || lines.length > 10000) throw fail('invalid_engine_events')
  let threadId, result, usage = null, started = false, completed = false, messages = 0
  for (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { throw fail('invalid_engine_events') }
    if (event.type === 'thread.started' && !threadId && id(event.thread_id)) threadId = event.thread_id
    else if (event.type === 'turn.started' && threadId && !started) started = true
    else if (event.type === 'item.completed' && started && !completed && ['agent_message', 'reasoning'].includes(event.item?.type)) {
      if (event.item.type === 'agent_message') {
        messages++
        try { result = JSON.parse(event.item.text) } catch { throw fail('invalid_engine_answer') }
      }
    } else if (event.type === 'turn.completed' && started && !completed) {
      completed = true
      const value = event.usage
      if (value && ['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
        && (value.cached_input_tokens === undefined || Number.isSafeInteger(value.cached_input_tokens) && value.cached_input_tokens >= 0)) {
        // Current CLI also reports cache-write and reasoning-output counters.
        // Preserve the real object rather than dropping fields the outer
        // ModLens envelope retains; absent counters must not become zeros.
        usage = structuredClone(value)
      }
    } else throw fail('unexpected_engine_event')
  }
  if (!completed || messages !== 1 || !result || typeof result !== 'object' || Array.isArray(result)) throw fail('incomplete_engine_events')
  return { conversationId: threadId, result, usage }
}

export async function readVisionEngineLedger(ledgerDirectory) {
  if (!isAbsolute(ledgerDirectory) || await fs.realpath(ledgerDirectory) !== ledgerDirectory) throw fail('unsafe_directory')
  const manifest = await readJson(join(ledgerDirectory, 'manifest.json'))
  const manifestKeys = ['schema', 'runId', 'sessionId', 'maxLaunches', 'provider', 'model', 'executable', 'executableSha256',
    'imageSha256', 'authReferenceSha256', 'workDirectory', 'isolatedHome', 'outputSchemaPath', 'outputSchemaSha256']
  if (manifest.schema !== 'xiaoshe-vision-engine-budget/v1' || manifest.maxLaunches !== 1 || manifest.provider !== 'codex-cli'
    || !id(manifest.runId) || !id(manifest.sessionId) || !id(manifest.model) || !digest(manifest.imageSha256) || !digest(manifest.executableSha256)
    || !digest(manifest.authReferenceSha256) || !isAbsolute(manifest.workDirectory ?? '') || !isAbsolute(manifest.isolatedHome ?? '')
    || !isAbsolute(manifest.outputSchemaPath ?? '') || !digest(manifest.outputSchemaSha256)
    || Object.keys(manifest).sort().join(',') !== manifestKeys.sort().join(',')) throw fail('invalid_ledger')
  const names = await fs.readdir(ledgerDirectory)
  if (names.some(name => !['manifest.json', 'reserved-1.json', 'launch-1.json', 'receipt-1.json', 'stdout-1.jsonl'].includes(name))) throw fail('unknown_ledger_file')
  const reserved = names.includes('reserved-1.json')
  if (reserved) {
    const row = await readJson(join(ledgerDirectory, 'reserved-1.json'))
    if (row.runId !== manifest.runId || row.sessionId !== manifest.sessionId || row.ordinal !== 1 || !iso(row.at)) throw fail('invalid_reservation')
  }
  let launch = null, receipt = null
  if (names.includes('launch-1.json')) {
    launch = await readJson(join(ledgerDirectory, 'launch-1.json'))
    if (!reserved || launch.runId !== manifest.runId || launch.sessionId !== manifest.sessionId || launch.ordinal !== 1
      || !Number.isSafeInteger(launch.pid) || launch.pid <= 1 || !iso(launch.startedAt)) throw fail('invalid_launch_record')
  }
  if (names.includes('receipt-1.json')) {
    receipt = await readJson(join(ledgerDirectory, 'receipt-1.json'))
    if (!reserved || receipt.runId !== manifest.runId || receipt.sessionId !== manifest.sessionId || receipt.ordinal !== 1
      || receipt.schema !== 'xiaoshe-vision-engine-process/v1' || receipt.model !== manifest.model || receipt.provider !== manifest.provider
      || receipt.executable?.path !== manifest.executable || receipt.executable?.sha256 !== manifest.executableSha256
      || receipt.outputSchema?.path !== manifest.outputSchemaPath || receipt.outputSchema?.sha256 !== manifest.outputSchemaSha256
      || receipt.inputSha256 !== manifest.imageSha256 || receipt.pid !== (launch?.pid ?? null)) throw fail('invalid_receipt')
    const raw = await safeBytes(join(ledgerDirectory, 'stdout-1.jsonl'))
    if (receipt.rawStdoutSha256 !== sha(raw)) throw fail('raw_output_changed')
    if (receipt.errorCode === null) {
      const observed = parseCodexVisionEvents(raw.toString('utf8'))
      if (!launch || receipt.exitCode !== 0 || receipt.cleanup?.status !== 'confirmed' || receipt.cleanup.confirmedBy !== 'ESRCH'
        || receipt.cleanup.groupId !== launch.pid || !iso(receipt.startedAt) || !iso(receipt.finishedAt)
        || receipt.startedAt !== launch.startedAt || receipt.finishedAt < receipt.startedAt
        || !equal(receipt.result, observed.result) || !equal(receipt.usage, observed.usage)
        || receipt.conversationId !== observed.conversationId) throw fail('receipt_observation_mismatch')
    } else if (typeof receipt.errorCode !== 'string' || !receipt.errorCode) throw fail('invalid_receipt')
  }
  return { ...manifest, reservedLaunches: reserved ? 1 : 0, remainingLaunches: reserved ? 0 : 1, launch, receipt,
    usage: !reserved ? { status: 'no_model', value: null } : { status: receipt?.usage ? 'reported' : 'unknown', value: receipt?.usage ?? null },
    monetaryHardCap: false, internalRequestCap: null }
}

export function createVisionEngineRuntime(input) {
  const config = validateVisionEngineConfig(input), manifest = manifestFor(config)
  const path = name => join(config.ledgerDirectory, name)
  let fatal
  const ready = (async () => {
    if (process.platform === 'win32') throw fail('posix_required')
    if (await fs.realpath(config.acceptanceRoot) !== config.acceptanceRoot) throw fail('unsafe_directory')
    await Promise.all([config.ledgerDirectory, config.workDirectory, config.isolatedHome].map(directory))
    assertCodexSchemaFile(config.outputSchemaPath, config.outputSchemaSha256)
    try { await exclusive(path('manifest.json'), manifest) } catch (error) { if (error.code !== 'EEXIST') throw error }
    if (JSON.stringify(await readJson(path('manifest.json'))) !== JSON.stringify(manifest)) throw fail('identity_changed')
    await readVisionEngineLedger(config.ledgerDirectory)
  })().catch(error => { fatal = error; throw error })
  ready.catch(() => {})
  return { config, ready, snapshot: () => readVisionEngineLedger(config.ledgerDirectory),
    async runCommand(provider, invocation, timeoutMs) {
      await ready; if (fatal) throw fatal
      if (provider !== 'codex-cli' || invocation.command !== config.executable || invocation.env !== undefined
        || !isAbsolute(invocation.cwd ?? '') || !inside(config.workDirectory, invocation.cwd)) throw fail('route_not_allowed')
      if (await fs.realpath(invocation.cwd) !== invocation.cwd || await fs.realpath(config.executable) !== config.executable
        || sha(await safeBytes(config.executable, 512 * 1024 * 1024)) !== config.executableSha256) throw fail('executable_changed')
      const args = invocation.args, prefix = CODEX_VISION_PREFIX
      // Read the actual -i argument after ModLens copied it into its workdir.
      const actualImage = args?.[prefix.length], tail = args?.slice(prefix.length + 1)
      if (!Array.isArray(args) || args.length !== prefix.length + 7 || !prefix.every((value, index) => args[index] === value)
        || tail[0] !== '-m' || tail[1] !== config.model || tail[2] !== '--output-schema' || tail[3] !== config.outputSchemaPath
        || tail[4] !== '--' || typeof tail[5] !== 'string' || tail[5].length > 20000
        || !isAbsolute(actualImage ?? '') || !inside(invocation.cwd, actualImage)
        || sha(await safeBytes(actualImage)) !== config.imageSha256 || await fs.realpath(actualImage) !== actualImage) throw fail('invocation_not_allowed')
      assertCodexSchemaFile(config.outputSchemaPath, config.outputSchemaSha256)
      if (JSON.stringify(await readJson(path('manifest.json'))) !== JSON.stringify(manifest)) throw fail('identity_changed')
      try { await exclusive(path('reserved-1.json'), { runId: config.runId, sessionId: config.sessionId, ordinal: 1, at: now() }) }
      catch (error) { throw fail(error.code === 'EEXIST' ? 'engine_budget_exhausted' : 'ledger_unavailable') }
      const controller = new AbortController(), cancel = () => controller.abort()
      process.once('SIGTERM', cancel); process.once('SIGINT', cancel)
      let processResult, engine, cause
      try {
        processResult = await runOwnedVisionEngine(config.executable, args, { cwd: invocation.cwd, timeoutMs,
          signal: controller.signal,
          // No inherited API keys, proxy credentials, NODE_OPTIONS or provider
          // environment. CODEX_HOME is a reference, never opened by this module.
          env: { HOME: config.isolatedHome, CODEX_HOME: config.authHome, TMPDIR: config.workDirectory,
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
          onSpawn: row => exclusive(path('launch-1.json'), { runId: config.runId, sessionId: config.sessionId, ordinal: 1, ...row }) })
        engine = parseCodexVisionEvents(processResult.stdout)
        if (sha(await safeBytes(actualImage)) !== config.imageSha256) throw fail('input_changed_during_engine')
      } catch (error) { cause = error; processResult ??= error.result }
      finally { process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel) }
      try { assertCodexSchemaFile(config.outputSchemaPath, config.outputSchemaSha256) } catch (error) {
        if (cause) { error.cause = cause; error.originalCode = cause.code ?? null }
        cause = error
      }
      const raw = processResult?.stdout ?? ''
      // Raw engine stdout is private run evidence; stderr is hash/size only.
      const handle = await fs.open(path('stdout-1.jsonl'), 'wx', 0o600)
      try { await handle.writeFile(raw); await handle.sync() } finally { await handle.close() }
      const receipt = { schema: 'xiaoshe-vision-engine-process/v1', runId: config.runId, sessionId: config.sessionId, ordinal: 1,
        provider, model: config.model, executable: { path: config.executable, sha256: config.executableSha256 },
        inputPath: actualImage, inputSha256: config.imageSha256, pid: processResult?.pid ?? null,
        outputSchema: { path: config.outputSchemaPath, sha256: config.outputSchemaSha256 },
        startedAt: processResult?.startedAt ?? null, finishedAt: processResult?.finishedAt ?? now(), exitCode: processResult?.exitCode ?? null,
        cleanup: processResult?.cleanup ?? { status: 'not-started' }, errorCode: cause?.code ?? null,
        originalCode: cause?.originalCode ?? null, rawStdoutSha256: sha(raw), stderrBytes: processResult?.stderrBytes ?? 0,
        stderrSha256: processResult?.stderrSha256 ?? sha(''), conversationId: engine?.conversationId ?? null, usage: engine?.usage ?? null,
        result: engine?.result ?? null, monetaryHardCap: false, internalRequestCap: null }
      await exclusive(path('receipt-1.json'), receipt)
      if (cause) throw cause
      return { stdout: raw, stderr: '', receipt }
    } }
}
