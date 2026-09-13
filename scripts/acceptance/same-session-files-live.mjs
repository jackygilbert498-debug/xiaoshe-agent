#!/usr/bin/env node
/** Explicit paid acceptance, synthetic files only. Never use a daily Profile. */
import { randomUUID, randomInt } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open, mkdir, writeFile, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as delay } from 'node:timers/promises'
import { captureCandidate } from '../quality/internal-beta.mjs'
import { createPublicProfile } from '../quality/product-lifecycle.mjs'
import { productRuntimeIdentity } from '../product-runtime-identity.mjs'
import { readBudgetLedger } from './live-request-budget.mjs'
import { finalizeLiveRun } from './live-run-finalize.mjs'
import { acceptanceRpc, ownedLoginUrl, redactLoginUrls } from './public-rpc.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const exec = promisify(execFile)
const PROVIDER = 'deepseek-official', MODEL = 'deepseek-v4-flash'
const save = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })

export function liveProfilePatch({ productRoot, acceptanceRoot, runId, sessionId }) {
  return [
    ...['credentials', 'llm-deepseek', 'llm-pi-ai', 'web-search-deepseek', 'session-title-llm', 'session-telemetry-otel']
      .map(id => ({ id, disabled: true })),
    { id: 'agent-default-model', config: { provider: PROVIDER, model: MODEL } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'agent-presets', config: { default: 'standard', includeUserRoot: false } },
    { insert: [
      { id: 'acceptance-file-policy', name: pathToFileURL(join(productRoot, 'scripts/acceptance/live-file-tool-policy.mjs')).href,
        config: { workspaceRealPath: join(acceptanceRoot, 'workspace'), ledgerDirectory: join(acceptanceRoot, 'tool-policy'), runId, sessionIds: [sessionId] } },
      { id: 'acceptance-live-budget', name: pathToFileURL(join(productRoot, 'scripts/acceptance/live-official-budget.mjs')).href,
        config: { ledgerDirectory: join(acceptanceRoot, 'budget'), runId, maxRequests: 16, provider: PROVIDER, model: MODEL, sessionIds: [sessionId] } },
    ] },
  ]
}

/** Read only the exact user-authorized credential. No secret in argv/files/logs. */
export async function selectedCredential(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 1_048_576) throw new Error('credential permissions rejected')
    const require = createRequire(join(root, 'runtime/DSH/packages/credentials/credentials-local/package.json'))
    const { parseDocument } = require('yaml')
    const document = parseDocument(await handle.readFile('utf8'))
    if (document.errors.length) throw new Error('credential document invalid')
    const data = document.toJS()
    if (!data || Array.isArray(data) || typeof data.DEEPSEEK_API_KEY !== 'string') throw new Error('selected credential missing')
    const { normalizeApiKey } = await import('../../runtime/DSH/packages/llm/llm/lib/index.js')
    const checked = normalizeApiKey(data.DEEPSEEK_API_KEY)
    if (!checked.ok) throw new Error('selected credential invalid')
    return checked.value
  } finally { await handle.close() }
}

export async function unusedPort() {
  const server = createServer()
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  const port = server.address().port
  await new Promise((done, fail) => server.close(error => error ? fail(error) : done()))
  return port === 3080 ? unusedPort() : port
}

/** Redact across chunk boundaries before applying any diagnostic size limit. */
export function secretRedactor(secret, emit) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const drain = (text, final = false) => {
    pending += text
    if (!secret) { emit(pending); pending = ''; return }
    let index
    while ((index = pending.indexOf(secret)) !== -1) {
      emit(pending.slice(0, index) + '[REDACTED]')
      pending = pending.slice(index + secret.length)
    }
    let held = 0
    if (!final) for (let length = Math.min(secret.length - 1, pending.length); length > 0; length--) {
      if (secret.startsWith(pending.slice(-length))) { held = length; break }
    }
    emit(pending.slice(0, pending.length - held)); pending = held ? pending.slice(-held) : ''
  }
  return { write: chunk => drain(decoder.write(chunk)), end: () => drain(decoder.end(), true) }
}

/** Own process group, including grandchildren; never inspect/kill other sessions. */
export function startOwnedHost(command, args, { cwd, env, secret, authOrigin, timeoutMs = 480_000 }) {
  if (process.platform === 'win32') throw new Error('owned POSIX process-group acceptance is unsupported on Windows')
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', exited = false, spawnFailure, signalFailure, authUrl
  const append = text => { output = (output + text).slice(-1_048_576) }
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '', droppingLine = false
    const decoder = new StringDecoder('utf8')
    const accept = line => {
      if (stream === child.stdout) authUrl ??= ownedLoginUrl(line, authOrigin)
      const redactor = secretRedactor(secret, append)
      redactor.write(Buffer.from(redactLoginUrls(line))); redactor.end()
    }
    stream.on('data', chunk => {
      pending += decoder.write(chunk)
      let at
      while ((at = pending.indexOf('\n')) >= 0) {
        if (!droppingLine) accept(pending.slice(0, at + 1))
        droppingLine = false; pending = pending.slice(at + 1)
      }
      if (pending.length > 65536) { pending = ''; droppingLine = true; append('[oversized owned log line omitted]\n') }
    })
    stream.once('end', () => { pending += decoder.end(); if (pending && !droppingLine) accept(pending) })
  }
  child.once('error', () => { spawnFailure = true; exited = true })
  child.once('exit', () => { exited = true })
  const signal = value => {
    if (!child.pid) return
    try { process.kill(-child.pid, value) } catch (error) { if (error.code !== 'ESRCH') signalFailure = error.code }
  }
  const deadline = setTimeout(() => signal('SIGKILL'), timeoutMs)
  return {
    get pid() { return child.pid },
    get exited() { return exited },
    get output() { return output },
    get authUrl() { return authUrl },
    async stop() {
      clearTimeout(deadline); signal('SIGTERM')
      for (let attempt = 0; attempt < 70; attempt++) {
        if (!child.pid) {
          child.stdout.destroy(); child.stderr.destroy()
          if (spawnFailure) return { absent: true, spawnFailure: true }
        } else {
          try { process.kill(-child.pid, 0) } catch (error) {
            if (error.code === 'ESRCH') { child.stdout.destroy(); child.stderr.destroy(); return { absent: true, pid: child.pid } }
            signalFailure = error.code
          }
        }
        if (attempt === 20) signal('SIGKILL')
        await delay(100)
      }
      child.stdout.destroy(); child.stderr.destroy()
      throw new Error(`owned host cleanup unproven (${signalFailure ?? 'still-present'})`)
    },
  }
}

export function rpcClient(base, options) { return acceptanceRpc(base, options) }

export function completedNewTurn(history, previousSeq) {
  const events = history?.events?.map(row => row.event).filter(row => row.seq > previousSeq) ?? []
  const user = events.find(row => row.type === 'user/message' && row.data?.message?.source?.kind === 'user')
    ?? events.find(row => row.type === 'user/message' && row.data?.source?.kind === 'user')
  const end = events.findLast(row => row.type === 'turn/end')
  return user && end && end.seq > user.seq ? { messageId: user.data.message?.id ?? user.data.id, reason: end.data.reason.kind } : null
}

export async function runSameSessionFiles({ onProgress = value => process.stdout.write(`${JSON.stringify(value)}\n`) } = {}) {
  const runId = randomUUID(), sessionId = `xiaoshe-files-live-${runId}`, createdAt = new Date().toISOString()
  const acceptanceRoot = join(await realpath(tmpdir()), `xiaoshe-files-live-${runId}`)
  const outputDirectory = join(root, 'output/stabilization', `same-session-files-${runId}`)
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 })
  if (await realpath(dirname(outputDirectory)) !== dirname(outputDirectory)) throw new Error('unsafe output parent')
  await exec('git', ['check-ignore', '--quiet', '--no-index', outputDirectory], { cwd: root })
  await mkdir(outputDirectory, { mode: 0o700 })
  const failures = [], cleanup = [], messages = []
  let interrupted = false
  const interrupt = () => { interrupted = true }
  const assertNotInterrupted = () => { if (interrupted) throw new Error('acceptance interrupted; owned cleanup required') }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  let sourceBefore, sourceAfter, runtimeIdentity, host, rootOwned = false, rpc, budget, proof, model, history, port
  const recordFailure = (stage, error) => failures.push(`${stage}: ${error.message}`)
  try {
    await mkdir(acceptanceRoot, { mode: 0o700 }); rootOwned = true
    for (const name of ['workspace', 'dsh-home', 'home', 'state', 'budget', 'tool-policy']) await mkdir(join(acceptanceRoot, name), { mode: 0o700 })
    const workspaceRoot = join(acceptanceRoot, 'workspace')
    await mkdir(join(workspaceRoot, 'output'), { mode: 0o700 })
    const input = [
      { project: `alpha-${randomUUID().slice(0, 8)}`, amount: randomInt(100, 900) / 10, quantity: randomInt(1, 7), owner: '林' },
      { project: `beta-${randomUUID().slice(0, 8)}`, amount: randomInt(100, 900) / 10, quantity: 0 },
      { project: `gamma-${randomUUID().slice(0, 8)}`, amount: 0, quantity: randomInt(1, 7), owner: '周' },
    ]
    await writeFile(join(workspaceRoot, 'input.jsonl'), input.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
    const { captureSameSessionFileBaseline, proveSameSessionFileRun } = await import('./same-session-file-proof.mjs')
    const baseline = await captureSameSessionFileBaseline({ workspaceRoot })
    await save(join(outputDirectory, 'baseline.json'), baseline)
    port = await unusedPort()
    const env = { PATH: process.env.PATH, HOME: join(acceptanceRoot, 'home'), TMPDIR: await realpath(tmpdir()),
      DSH_HOME: join(acceptanceRoot, 'dsh-home'), DSH_TELEMETRY_DISABLED: '1',
      XIAOSHE_PRODUCT_ROOT: root, XIAOSHE_DSH_ROOT: join(root, 'runtime/DSH'),
      XIAOSHE_LEGACY_ROOT: join(root, 'runtime/xiaoshe-legacy'), XIAOSHE_STATE_ROOT: join(acceptanceRoot, 'state'),
      XIAOSHE_DSH_HOST: '127.0.0.1', XIAOSHE_DSH_PORT: String(port),
      XIAOSHE_NODE: process.execPath, XIAOSHE_DESKTOP_ACTIONS: 'off',
      XIAOSHE_ACCEPTANCE_WORKSPACE: workspaceRoot }
    const profileRoot = await createPublicProfile({ productRoot: root, acceptanceRoot, runId, environment: env })
    await writeFile(join(profileRoot, 'cordis.patch.yml'), JSON.stringify(liveProfilePatch({ productRoot: root, acceptanceRoot, runId, sessionId }), null, 2))
    await exec(process.execPath, [join(root, 'runtime/DSH/apps/cli/lib/bin.js'), '--profile', 'web', '--dump-config'], { cwd: workspaceRoot, env, timeout: 30_000 })
    sourceBefore = await captureCandidate(root)
    runtimeIdentity = await productRuntimeIdentity({ root, dshRoot: env.XIAOSHE_DSH_ROOT, profileRoot })
    assertNotInterrupted()
    const key = await selectedCredential('/Users/zfy/.dsh/.credentials.yaml')
    host = startOwnedHost(process.execPath, [join(root, 'runtime/DSH/apps/cli/lib/bin.js'), 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)],
      { cwd: workspaceRoot, env: { ...env, XIAOSHE_PROFILE_ROOT: profileRoot, XIAOSHE_RUNTIME_IDENTITY: runtimeIdentity,
        DEEPSEEK_API_KEY: key, DEEPSEEK_BASE_URL: 'https://api.deepseek.com' }, secret: key, authOrigin: `http://127.0.0.1:${port}` })
    onProgress({ stage: 'isolated-host', pid: host.pid, port, outputDirectory })
    const base = `http://127.0.0.1:${port}`; rpc = rpcClient(base, { authUrl: () => host.authUrl })
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      assertNotInterrupted()
      if (host.exited) throw new Error('isolated host exited during startup; see redacted host log')
      const status = await fetch(`${base}/xiaoshe/desktop/status`, { signal: AbortSignal.timeout(1000) }).then(r => r.json()).catch(() => null)
      if (status?.bridge?.state === 'ready' && status.runtime_identity === runtimeIdentity) {
        budget = await readBudgetLedger(join(acceptanceRoot, 'budget')).catch(() => null)
        if (budget?.mounted && budget.mounts.some(row => row.pid === host.pid && row.runId === runId)) { ready = true; break }
      }
      await delay(500)
    }
    if (!ready) throw new Error('host /status identity or budget guard not ready')
    const created = await rpc('session.create', { sessionId, cwd: workspaceRoot, agentPreset: 'standard' })
    if (created.sessionId !== sessionId) throw new Error('session identity mismatch')
    const { readLiveFileToolPolicyLedger } = await import('./live-file-tool-policy.mjs')
    const policy = await readLiveFileToolPolicyLedger(join(acceptanceRoot, 'tool-policy'))
    if (!policy.mounted || policy.workspaceRealPath !== workspaceRoot || !policy.mounts.some(row => row.kind === 'agent' && row.pid === host.pid
      && row.sessionId === sessionId && row.runId === runId
      && Date.parse(row.at) >= Date.parse(createdAt))) throw new Error('same-session execution guard not mounted')
    await save(join(outputDirectory, 'tool-policy-before.json'), policy)
    await rpc('session.selectModel', { sessionId, provider: PROVIDER, model: MODEL, reasoningEffort: 'off' })
    model = await rpc('session.models', { sessionId })
    if (model.routable !== true || model.current?.provider !== PROVIDER || model.current?.model !== MODEL
      || model.current?.reasoningEffort !== 'off') throw new Error('model selection or routability mismatch')
    // No answer values appear in the task. Every expected field comes from input.
    const prompts = [
      '请调用 xiaoshe_runtime_info，告诉我当前是否注册了浏览器能力。只转述结果，不执行其他工具。',
      `在本会话继续完成本地文件任务，工作目录是 ${workspaceRoot}。本次仅使用 xiaoshe_capability_plan、xiaoshe_runtime_info、todo_write、read、write 工具，禁止使用终端命令。读取当前工作目录 input.jsonl。按原行序提取每行 project、amount、quantity、owner，保留值与类型；缺少 owner 时置为 null，不猜测或补造。写入 output/result.json，顶层只含 items 数组，各项只含上述四字段。写完再用读取工具回读实际结果并核对。输入文件必须保持原样；只能新增 output/result.json。全部完成后告诉我真实保存位置及核验结果。`,
    ]
    for (let index = 0; index < prompts.length; index++) {
      const before = await rpc('session.history', { sessionId, maxMessages: 200 })
      const previous = before.events.at(-1)?.event.seq ?? -1
      await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: prompts[index] }] })
      onProgress({ stage: `turn-${index + 1}`, status: 'running' })
      let result
      for (let tick = 0; tick < 180; tick++) {
        await delay(1000)
        assertNotInterrupted()
        if (host.exited) throw new Error('isolated host exited mid-turn')
        history = await rpc('session.history', { sessionId, maxMessages: 200 })
        result = completedNewTurn(history, previous)
        if (result) break
        if (tick > 0 && tick % 20 === 0) onProgress({ stage: `turn-${index + 1}`, status: 'running', seconds: tick })
      }
      await save(join(outputDirectory, `turn-${index + 1}-history.json`), history)
      if (!result || result.reason !== 'completed' || !result.messageId) throw new Error(`turn ${index + 1} did not complete (${result?.reason ?? 'timeout'})`)
      messages.push(result.messageId)
      onProgress({ stage: `turn-${index + 1}`, status: 'completed' })
    }
    proof = await proveSameSessionFileRun({ sessionId, history, baseline, userMessageIds: messages, toolPolicy: 'continuous-availability' })
    await save(join(outputDirectory, 'proof.json'), proof)
    if (proof.tasks.some(task => task.state !== 'pass') || proof.regression.state !== 'pass') throw new Error('independent same-session/file proof failed')
    if (runtimeIdentity !== await productRuntimeIdentity({ root, dshRoot: env.XIAOSHE_DSH_ROOT, profileRoot })) throw new Error('runtime changed during acceptance')
  } catch (error) { recordFailure('execution', error) }
  finally {
    try { budget = await finalizeLiveRun({ acceptanceRoot, outputDirectory, rootOwned, host, rpc, sessionId, recordFailure, cleanup }) }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt) }
  }
  sourceAfter = await captureCandidate(root)
  if (!sourceBefore || sourceBefore.sha256 !== sourceAfter.sha256) failures.push('candidate source changed or was not captured')
  if (!budget?.mounted || !budget.reservedRequests || budget.deniedRequests || budget.requests.some(row => row.outcome !== 'finished')) failures.push('model dispatch/finish ledger incomplete')
  const report = { schema: 'xiaoshe-same-session-files-live/v1', runId, createdAt, finishedAt: new Date().toISOString(),
    sessionId, sourceBefore, sourceAfter, runtimeIdentity, executionKind: 'live_model',
    model: model?.current ?? null, budget, proof, cleanup, failures, status: failures.length ? 'fail' : 'pass',
    scope: 'isolated-official-text-api-not-modlens-or-native-launcher',
    retainedRoot: cleanup.some(row => row.state === 'fail') ? acceptanceRoot : null }
  await save(join(outputDirectory, 'report.json'), report)
  if (report.status === 'pass') {
    await save(join(outputDirectory, 'task-run.json'), { schema: 'xiaoshe-task-run/v1', runId, createdAt, finishedAt: report.finishedAt,
      binding: { sourceSha256: sourceBefore.sha256, runtimeIdentity }, executionKind: 'live_model', cleanup,
      // Two overlapping catalog contracts share ONE end-to-end journey. Never
      // publish its billable tokens twice as if independently measured tasks.
      sharedJourneyMetrics: { durationMs: Date.parse(report.finishedAt) - Date.parse(createdAt),
        retryCount: proof.recovery?.retriedWriteCalls ?? null, humanInterventions: 0,
        inputTokens: budget.usage.totalUsage?.inputTokens ?? null, cacheReadTokens: budget.usage.totalUsage?.cacheReadTokens ?? null,
        outputTokens: budget.usage.totalUsage?.outputTokens ?? null, cost: null },
      tasks: proof.tasks.map(task => ({ ...task, metrics: { durationMs: null, retryCount: null, humanInterventions: 0,
        inputTokens: null, outputTokens: null, cost: null } })) })
  }
  onProgress({ status: report.status, failures, outputDirectory, modelRequests: budget?.reservedRequests ?? null })
  return { report, outputDirectory }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(' ') !== '--live-authorized') throw new Error('Paid API access requires explicit --live-authorized')
  runSameSessionFiles().then(({ report }) => { if (report.status !== 'pass') process.exitCode = 1 }, error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1
  })
}
