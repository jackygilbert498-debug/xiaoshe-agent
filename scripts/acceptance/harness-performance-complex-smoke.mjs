#!/usr/bin/env node
/**
 * Live complex-task acceptance for the local Xiaoshe RPC runtime.
 *
 * The script creates fixtures only in the operating system temporary directory,
 * archives only the sessions it created, and writes its sole retained artifact
 * below output/acceptance. One scenario deliberately exercises the configured
 * public web-search provider; every other transport is the local Xiaoshe RPC.
 * The search is read-only and does not authenticate or mutate an external site.
 * Optional owned mode uses an explicit isolated manifest, retains complete raw
 * histories/fixtures, and leaves that private root for its outer owner to clean.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import {
  canonicalVerificationLink,
  claimsSourceRead,
  completionReceiptMatchesEvents,
  currentCompletionReceiptContract,
  onlineResearchEvidence,
  researchNetworkAttemptSafe,
  researchNetworkRoute,
  runtimeRootMatches,
  syntheticPreflightDenials,
} from './harness-performance-policy.mjs'
import {
  buildHarnessToolRecords,
  callUsesSessionDirectory,
  harnessTurnDiagnostics,
  latestVisibleAssistantAnswer,
  successfulCallsSettledAfterBoundary,
} from './harness-performance-event-proof.mjs'
import { resolveLocalAcceptanceBase } from './local-acceptance-base.mjs'
import { acceptanceRpc } from './public-rpc.mjs'
import { eventText } from '../../packages/terminal-client/lib/presentation.js'
import { assertComplexProtectedInputs, collectCompleteComplexHistory, loadComplexRunBinding } from './complex-run-binding.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const ownedRun = await loadComplexRunBinding(process.env.XIAOSHE_COMPLEX_RUN_CONFIG)
const expectedRuntimeRoot = ownedRun?.config.expectedHostCwd ?? resolve(root, 'runtime/DSH')
const stamp = Date.now()
const base = ownedRun?.config.endpoint ?? resolveLocalAcceptanceBase()
const fixtureRoot = ownedRun?.config.fixtureRoot ?? await mkdtemp(join(tmpdir(), 'xiaoshe-harness-performance-'))
// The internal candidate gate supplies a unique owned evidence path. Standalone
// use retains the original report directory and never changes runtime settings.
const reportPath = ownedRun?.config.reportPath ?? (process.env.XIAOSHE_HARNESS_REPORT_PATH
  ? resolve(process.env.XIAOSHE_HARNESS_REPORT_PATH)
  : resolve(root, `output/acceptance/harness-performance-complex-${stamp}.json`))
const createdSessions = new Set()
const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  acceptanceBinding: process.env.XIAOSHE_ACCEPTANCE_BINDING ? JSON.parse(process.env.XIAOSHE_ACCEPTANCE_BINDING) : null,
  fixtureRoot: ownedRun ? fixtureRoot : 'system-temp (removed after run)',
  ...(ownedRun ? { ownedRun: { runId: ownedRun.config.runId, manifest: ownedRun.manifest, fixturesRetainedForOuterCleanup: true }, completeHistories: [] } : {}),
  runtime: null,
  scenarios: [],
  cleanup: [],
  transportRetries: [],
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
}

function contentText(event) {
  if (event?.type === 'assistant/message' && Array.isArray(event.data?.stream)) return eventText(event)
  const message = event?.data?.message ?? event?.data
  const content = message?.content
  return Array.isArray(content)
    ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
    : ''
}

function toolResultText(event) {
  const visit = value => Array.isArray(value)
    ? value.flatMap(item => [typeof item?.text === 'string' ? item.text : '', ...visit(item?.content)]).filter(Boolean)
    : []
  return visit(event?.data?.message?.content ?? event?.data?.content).join('\n')
}

function callsFrom(events) { return buildHarnessToolRecords(events) }

function isWriteTool(name) {
  // Planning/todo updates are not fixture mutations. Treating todo_write as a
  // file write would make the allow-list test fail even when no protected file
  // was touched.
  if (/(?:todo|memory|goal)/iu.test(name)) return false
  return /(?:write|edit|patch|delete|remove|move|rename|create_file|apply_patch)/iu.test(name)
}

function isShellTool(name) {
  return /^(?:bash|pwsh|powershell|shell|exec_command|run_command|cmd|terminal_send)$/iu.test(name)
}

function isReadOrSearchTool(name) {
  return !isNetworkTool(name) && /(?:read|glob|grep|search|find|list_files)/iu.test(name)
}

function isNetworkTool(name) {
  if (/(?:^|__|[_.:-])(?:filesystem|local|workspace)(?:__|[_.:-])/iu.test(name)) return false
  return /(?:^|[_.:-])(?:web|browser|http|url)(?:[_.:-]|$)|^(?:web_|browser_)|^(?:mcp__|app__|connector__)/iu.test(name)
}

function verificationCommandKind(call) {
  if (!isShellTool(call.name)) return undefined
  const command = [call.arguments.command, call.arguments.cmd, call.arguments.script]
    .find(value => typeof value === 'string')
  if (typeof command !== 'string') return undefined
  const match = command.trim().match(/^(?:npm(?:\.cmd)?)\s+run\s+(typecheck|test|build)$/iu)
  return match?.[1]?.toLowerCase()
}

function callMentions(call, path) {
  const normalizePath = value => String(value).replaceAll('\\', '/').replace(/\/+/gu, '/').toLowerCase()
  const expected = normalizePath(path)
  const pathFields = ['file_path', 'filePath', 'path', 'source_path', 'sourcePath', 'target_path', 'targetPath']
  return pathFields.some(key => typeof call.arguments?.[key] === 'string'
    && normalizePath(call.arguments[key]) === expected)
}

function resultEventsByCallId(events) {
  const grouped = new Map()
  for (const call of callsFrom(events)) {
    if (call.result === undefined) continue
    const bucket = grouped.get(call.callId) ?? []
    bucket.push(call.result)
    grouped.set(call.callId, bucket)
  }
  return new Map([...grouped].flatMap(([callId, results]) => results.length === 1 ? [[callId, results[0]]] : []))
}

function successfulCalls(events) {
  const records = new Map(callsFrom(events).map(call => [`${call.eventType}:${call.seq}:${call.callId}`, call]))
  return call => {
    return records.get(`${call.eventType}:${call.seq}:${call.callId}`)?.succeeded === true
  }
}

function resultMatchesCall(call, result) {
  return call.result === result && call.settled === true
}

function verificationLinkReport(events, calls, receipt) {
  const callsById = new Map(calls.map(call => [call.callId, call]))
  const resultsById = resultEventsByCallId(events)
  const succeeded = successfulCalls(events)
  const mutations = calls.filter(call => isWriteTool(call.name) && succeeded(call))
  const requiredGates = Array.isArray(receipt?.requirements) ? receipt.requirements : []
  const verificationEvents = events.filter(event => event?.type === 'verification/result'
    && event.data?.status === 'passed')
  const link = event => {
    const mutation = callsById.get(event.data?.mutationCallId)
    const verifier = callsById.get(event.data?.verifierCallId)
    const mutationResult = resultsById.get(event.data?.mutationCallId)
    const verifierResult = resultsById.get(event.data?.verifierCallId)
    const expectedGate = verifier === undefined ? undefined : verificationCommandKind(verifier)
    const evidence = event.data?.evidence
    const valid = mutation !== undefined && verifier !== undefined
      && mutationResult !== undefined && verifierResult !== undefined
      && resultMatchesCall(mutation, mutationResult) && resultMatchesCall(verifier, verifierResult)
      && canonicalVerificationLink({
        fact: {
          seq: event.seq,
          turn: event.data?.turn,
          mutationCallId: event.data?.mutationCallId,
          verifierCallId: event.data?.verifierCallId,
          gate: event.data?.gate,
          status: event.data?.status,
          evidence,
        },
        mutation: {
          callId: mutation.callId,
          callSeq: mutation.seq,
          resultSeq: mutationResult.seq,
          isMutation: isWriteTool(mutation.name),
          succeeded: succeeded(mutation),
        },
        verifier: {
          callId: verifier.callId,
          callSeq: verifier.seq,
          resultSeq: verifierResult.seq,
          expectedGate,
          succeeded: succeeded(verifier),
        },
        receiptTurn: receipt?.turn,
      })
    return {
      mutationCallId: event.data?.mutationCallId,
      verifierCallId: event.data?.verifierCallId,
      gate: event.data?.gate,
      expectedGate,
      verificationSeq: event.seq,
      mutationResultSeq: mutationResult?.seq,
      verifierResultSeq: verifierResult?.seq,
      valid,
    }
  }
  const links = verificationEvents.map(link)
  const coverage = mutations.flatMap(mutation => requiredGates.map(gate => ({
    mutationCallId: mutation.callId,
    gate,
    covered: links.some(candidate => candidate.valid
      && candidate.mutationCallId === mutation.callId && candidate.gate === gate),
  })))
  return {
    mutations: mutations.map(call => call.callId),
    requiredGates,
    links,
    coverage,
    complete: mutations.length > 0 && requiredGates.length > 0
      && coverage.every(item => item.covered) && links.every(item => item.valid),
  }
}

async function walk(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) output.push(...await walk(path))
    else output.push(path)
  }
  return output.sort()
}

function completionReceipt(history) {
  const receipt = history?.projections?.values?.completionReceipt
  return receipt && typeof receipt === 'object' ? receipt : null
}

function assertCheck(target, id, pass, detail) {
  target.checks.push({ id, state: pass ? 'pass' : 'fail', detail })
  return pass
}

async function persist() {
  if (ownedRun) {
    report.ownedRun.rawResponses = ownedRun.retainedResponses()
    return ownedRun.writeReport(report)
  }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}

const invoke = acceptanceRpc(base, { onResponse: ownedRun ? async record => {
  if (['session/follow', 'session/page'].includes(record.endpoint)) await ownedRun.retainResponse({
    method: record.endpoint, rpcId: record.rpcId, payload: { args: record.args }, status: record.status, bytes: Buffer.from(record.bytes),
  })
} : undefined })
async function rpc(method, payload) {
  const retryable = ['session.history', 'session.list', 'session.models'].includes(method) && payload.beforeSeq === undefined
  let lastError
  for (let attempt = 1; attempt <= (retryable ? 3 : 1); attempt++) {
    try { return await invoke(method, payload) }
    catch (error) {
      lastError = error
      if (error?.code === 'COMPLEX_RUN_BINDING' || !retryable || attempt === 3) break
      report.transportRetries.push({ method, attempt, error: error instanceof Error ? error.message : String(error) })
      await delay(200 * attempt)
    }
  }
  throw lastError
}

async function waitForIdle(sessionId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await rpc('session.list', {})
    const session = list.items.find(item => item.sessionId === sessionId)
    if (session !== undefined && !session.running) return { settled: true }
    await delay(2_000)
  }
  await rpc('session.cancel', { sessionId }).catch(() => {})
  return { settled: false }
}

async function waitForFirstToolCall(sessionId, previousSeq, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [history, list] = await Promise.all([
      rpc('session.history', { sessionId, maxMessages: 200 }),
      rpc('session.list', {}),
    ])
    const observed = history.events.some(row => row.event.seq > previousSeq && row.event.type === 'tool/call')
    if (observed) return { observed: true, running: list.items.find(item => item.sessionId === sessionId)?.running === true }
    await delay(250)
  }
  return { observed: false, running: false }
}

async function openScenario(id, cwd) {
  const sessionId = ownedRun ? ownedRun.sessionId(id) : `xiaoshe-harness-${id}-${stamp}`
  await rpc('session.create', { sessionId, cwd })
  createdSessions.add(sessionId)
  await rpc('session.rename', { sessionId, title: `小蛇 Harness 复杂任务验收：${id}` })
  const before = await rpc('session.history', { sessionId, maxMessages: 1 })
  return { sessionId, previousSeq: before.events.at(-1)?.event?.seq ?? -1 }
}

async function runScenario(id, cwd, prompt, evaluate) {
  const scenario = { id, state: 'fail', checks: [] }
  report.scenarios.push(scenario)
  let sessionId
  try {
    const opened = await openScenario(id, cwd)
    sessionId = opened.sessionId
    scenario.sessionId = sessionId
    await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] })
    const waiting = await waitForIdle(sessionId)
    const history = await rpc('session.history', { sessionId, maxMessages: 200 })
    const events = history.events.map(row => row.event).filter(event => event.seq > opened.previousSeq)
    const calls = callsFrom(events)
    const callSucceeded = successfulCalls(events)
    const answer = events.filter(event => event.type === 'assistant/message').map(contentText).filter(Boolean).join('\n')
    const turnEnd = events.findLast(event => event.type === 'turn/end')?.data?.reason?.kind ?? 'missing'
    const receipt = completionReceipt(history)
    scenario.runtime = {
      settled: waiting.settled,
      turnEnd,
      calls: calls.map(call => ({ name: call.name, fingerprint: call.fingerprint, succeeded: callSucceeded(call) })),
      answer: answer.slice(0, 8_000),
      receipt: receipt === null ? null : {
        schemaVersion: receipt.schemaVersion,
        outcome: receipt.outcome,
        unverified: receipt.unverified,
        toolStatuses: Array.isArray(receipt.tools) ? receipt.tools.map(tool => ({ name: tool.name, status: tool.status })) : [],
      },
    }
    assertCheck(scenario, 'turn-settled', waiting.settled, waiting.settled ? 'session became idle' : 'timeout caused cancellation')
    assertCheck(scenario, 'turn-end-completed', turnEnd === 'completed', turnEnd)
    assertCheck(scenario, 'completion-receipt-contract-v2', currentCompletionReceiptContract(receipt), receipt ?? 'missing')
    assertCheck(scenario, 'completion-receipt-bound-to-current-turn', completionReceiptMatchesEvents(receipt, events), {
      receiptTurn: receipt?.turn, receiptSourceSeq: receipt?.sourceSeq,
      latestTurnEnd: events.findLast(event => event.type === 'turn/end')?.seq,
    })
    assertCheck(scenario, 'no-synthetic-preflight-deny', syntheticPreflightDenials(events).length === 0, syntheticPreflightDenials(events))
    await evaluate({ scenario, events, calls, callSucceeded, answer, receipt, settled: waiting.settled, turnEnd })
    scenario.state = scenario.checks.every(check => check.state === 'pass') ? 'pass' : 'fail'
  } catch (error) {
    scenario.checks.push({ id: 'live-run', state: 'fail', detail: error instanceof Error ? error.message : String(error) })
    if (sessionId !== undefined) await rpc('session.cancel', { sessionId }).catch(() => {})
  }
  await persist()
}

async function createCodeFixture() {
  const directory = resolve(fixtureRoot, 'code-repair')
  await mkdir(resolve(directory, 'src'), { recursive: true })
  await mkdir(resolve(directory, 'test'), { recursive: true })
  await writeFile(resolve(directory, 'package.json'), `${JSON.stringify({
    name: 'xiaoshe-code-repair-acceptance-fixture',
    private: true,
    type: 'module',
    scripts: {
      typecheck: 'node --check src/normalize.mjs',
      // Node's --test coordinator creates another child process per file. The
      // real workspace-write sandbox intentionally blocks that grandchild on
      // Windows, while a direct node:test module still executes the same tests
      // and emits the canonical TAP summary without requesting escalation.
      test: 'node test/normalize.test.mjs',
      build: 'node --check src/normalize.mjs',
    },
  }, null, 2)}\n`)
  await writeFile(resolve(directory, 'requirements.md'), [
    '# 任务',
    '修复 `src/normalize.mjs` 的 `normalizePluginName`。',
    '仅接受非空字符串；去除首尾空格；转为小写；任意连续空白或下划线转为一个连字符。',
    '只允许修改 `src/normalize.mjs`。先阅读需求和测试，再修改，运行测试，并重新读取修改后的文件。',
  ].join('\n'))
  await writeFile(resolve(directory, 'src/normalize.mjs'), "export function normalizePluginName(value) {\n  return String(value).toLowerCase()\n}\n")
  await writeFile(resolve(directory, 'test/normalize.test.mjs'), [
    "import assert from 'node:assert/strict'",
    "import test from 'node:test'",
    "import { normalizePluginName } from '../src/normalize.mjs'",
    "test('normalizes spaces and underscores', () => {",
    "  assert.equal(normalizePluginName('  Agent__ Tools  '), 'agent-tools')",
    "})",
    "test('rejects non-string or blank inputs', () => {",
    "  assert.throws(() => normalizePluginName('   '), TypeError)",
    "  assert.throws(() => normalizePluginName(null), TypeError)",
    "})",
  ].join('\n'))
  return directory
}

async function createResearchFixture() {
  const directory = resolve(fixtureRoot, 'research')
  await mkdir(resolve(directory, 'sources'), { recursive: true })
  const sourceA = resolve(directory, 'sources/2025-01-release.md')
  const sourceB = resolve(directory, 'sources/2025-06-security.md')
  const sourceC = resolve(directory, 'sources/2025-09-authority.md')
  await writeFile(sourceA, '# Release note\nVersion 1.4 says the export retention period is 30 days.\n')
  await writeFile(sourceB, '# Security advisory\nVersion 1.5 changed export retention to 14 days.\n')
  await writeFile(sourceC, '# Policy authority\nEffective 2025-09-01: the authoritative export retention period is 7 days. Earlier release notes are superseded.\n')
  return { directory, sources: [sourceA, sourceB, sourceC] }
}

async function createRecoveryFixture() {
  const directory = resolve(fixtureRoot, 'recovery')
  await mkdir(resolve(directory, 'sources'), { recursive: true })
  const existing = resolve(directory, 'sources/recovery-note.md')
  const missing = resolve(directory, 'sources/missing-note.md')
  await writeFile(existing, '# Recovery evidence\nRECOVERY-ALPHA: the fallback source was read after the missing input failed.\n')
  return { directory, existing, missing }
}

async function createSteerFixture() {
  const directory = resolve(fixtureRoot, 'steer')
  await mkdir(resolve(directory, 'sources'), { recursive: true })
  const initial = ['a', 'b', 'c'].map(name => resolve(directory, `sources/initial-${name}.md`))
  const target = resolve(directory, 'sources/steer-note.md')
  await writeFile(initial[0], `# Initial source 1\nNEXT: ${initial[1]}\n`)
  await writeFile(initial[1], `# Initial source 2\nNEXT: ${initial[2]}\n`)
  await writeFile(initial[2], '# Initial source 3\nEND\n')
  await writeFile(target, '# Steered result\nSTEER-BRAVO: the user changed scope and this is the only final evidence.\n')
  return { directory, initial, target }
}

async function runSteerScenario(steer) {
  const scenario = { id: 'user-steer', state: 'fail', checks: [] }
  report.scenarios.push(scenario)
  let sessionId
  try {
    const opened = await openScenario('user-steer', steer.directory)
    sessionId = opened.sessionId
    scenario.sessionId = sessionId
    await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: `从 ${steer.initial[0]} 开始读取；每份正文会给出下一份的 NEXT 绝对路径，请逐步跟随至 END，暂时不要给结论。不得联网、不得写入文件、不得执行 shell。` }],
    })
    const activity = await waitForFirstToolCall(sessionId, opened.previousSeq)
    const beforeSteer = await rpc('session.history', { sessionId, maxMessages: 200 })
    const steerBoundary = Math.max(opened.previousSeq, ...beforeSteer.events.map(row => row.event.seq))
    const beforeEvents = beforeSteer.events.map(row => row.event).filter(event => event.seq > opened.previousSeq)
    const beforeCalls = callsFrom(beforeEvents)
    const beforeSucceeded = successfulCalls(beforeEvents)
    const oldRouteIncomplete = !beforeCalls.some(call => callMentions(call, steer.initial[2]) && beforeSucceeded(call))
      && !beforeEvents.some(event => event.type === 'tool/result' && /(?:^|\n)END(?:\n|$)/u.test(toolResultText(event)))
    const steerText = `用户改向：立即停止原比较任务。现在只读取 ${steer.target}，并以 STEER-BRAVO 作为最终证据回复；不要写文件、不要执行 shell、不要联网。`
    const steerResult = await rpc('session.prompt', { sessionId, mode: 'steer', content: [{ type: 'text', text: steerText }] })
    const waiting = await waitForIdle(sessionId)
    const history = await rpc('session.history', { sessionId, maxMessages: 200 })
    const events = history.events.map(row => row.event).filter(event => event.seq > opened.previousSeq)
    const calls = callsFrom(events)
    const callSucceeded = successfulCalls(events)
    const steerEvent = events.find(event => (event?.data?.message?.role ?? event?.data?.role) === 'user'
      && contentText(event).includes('用户改向') && contentText(event).includes(steer.target))
    const effectiveSteerBoundary = steerEvent?.seq ?? steerBoundary
    const postSteerCalls = calls.filter(call => call.seq > effectiveSteerBoundary)
    const answer = events.filter(event => event.type === 'assistant/message').map(contentText).filter(Boolean).join('\n')
    const postSteerAnswer = events.filter(event => event.seq > effectiveSteerBoundary && event.type === 'assistant/message')
      .map(contentText).filter(Boolean).join('\n')
    const receipt = completionReceipt(history)
    scenario.runtime = {
      settled: waiting.settled,
      activity,
      steerBoundary: effectiveSteerBoundary,
      steerEventObserved: steerEvent !== undefined,
      oldRouteIncomplete,
      steerAccepted: steerResult.accepted === true,
      calls: calls.map(call => ({ name: call.name, fingerprint: call.fingerprint, phase: call.seq > effectiveSteerBoundary ? 'after-steer' : 'before-steer' })),
      answer: answer.slice(0, 8_000),
      receipt: receipt === null ? null : { schemaVersion: receipt.schemaVersion, outcome: receipt.outcome, unverified: receipt.unverified },
    }
    const noUnsafeAction = !calls.some(call => isWriteTool(call.name) || isShellTool(call.name))
    const noNetwork = !calls.some(call => isNetworkTool(call.name))
    const steeredRead = postSteerCalls.some(call => isReadOrSearchTool(call.name)
      && callMentions(call, steer.target) && callSucceeded(call))
    const lateOldRouteSuccesses = successfulCallsSettledAfterBoundary(calls, effectiveSteerBoundary)
      .filter(call => steer.initial.some(path => callMentions(call, path)))
    const abandonedOldRoute = !postSteerCalls.some(call => steer.initial.some(path => callMentions(call, path)))
      && lateOldRouteSuccesses.length === 0
    assertCheck(scenario, 'turn-settled', waiting.settled, waiting.settled ? 'session became idle' : 'timeout caused cancellation')
    assertCheck(scenario, 'completion-receipt-contract-v2', currentCompletionReceiptContract(receipt), receipt ?? 'missing')
    assertCheck(scenario, 'completion-receipt-bound-to-current-turn', completionReceiptMatchesEvents(receipt, events), {
      receiptTurn: receipt?.turn, receiptSourceSeq: receipt?.sourceSeq,
      latestTurnEnd: events.findLast(event => event.type === 'turn/end')?.seq,
    })
    assertCheck(scenario, 'real-tool-activity-before-steer', activity.observed && activity.running, activity)
    assertCheck(scenario, 'old-route-incomplete-before-steer', oldRouteIncomplete, beforeCalls.map(call => ({ name: call.name, arguments: call.arguments })))
    assertCheck(scenario, 'steer-rpc-accepted', steerResult.accepted === true, steerResult)
    assertCheck(scenario, 'steer-instruction-effective', steeredRead && /STEER-BRAVO/u.test(postSteerAnswer), { calls: postSteerCalls.map(call => call.name), answer: postSteerAnswer.slice(0, 2_000) })
    assertCheck(scenario, 'old-route-abandoned-after-steer', abandonedOldRoute, {
      callsStartedAfterSteer: postSteerCalls.map(call => ({ name: call.name, arguments: call.arguments })),
      successfulOldResultsSettledAfterSteer: lateOldRouteSuccesses.map(call => ({
        name: call.name, arguments: call.arguments, callSeq: call.seq, resultSeq: call.resultSeq,
      })),
    })
    assertCheck(scenario, 'no-write-or-shell-during-steer', noUnsafeAction, calls.map(call => call.name))
    assertCheck(scenario, 'no-network-during-steer', noNetwork, calls.map(call => call.name))
    assertCheck(scenario, 'no-synthetic-preflight-deny', syntheticPreflightDenials(events).length === 0, syntheticPreflightDenials(events))
    scenario.state = scenario.checks.every(check => check.state === 'pass') ? 'pass' : 'fail'
  } catch (error) {
    scenario.checks.push({ id: 'live-run', state: 'fail', detail: error instanceof Error ? error.message : String(error) })
    if (sessionId !== undefined) await rpc('session.cancel', { sessionId }).catch(() => {})
  }
  await persist()
}

async function runOfflineToOnlineScenario(research) {
  const scenario = { id: 'offline-to-online-topic-switch', state: 'fail', checks: [] }
  report.scenarios.push(scenario)
  let sessionId
  try {
    const opened = await openScenario('offline-to-online-topic-switch', research.directory)
    sessionId = opened.sessionId
    scenario.sessionId = sessionId

    await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: `只读取本地文件 ${research.sources[0]}，用一句话报告其中的版本和保留天数。不得联网、不得写文件、不得执行 shell。` }],
    })
    const firstWaiting = await waitForIdle(sessionId)
    const firstHistory = await rpc('session.history', { sessionId, maxMessages: 200 })
    const firstEvents = firstHistory.events.map(row => row.event).filter(event => event.seq > opened.previousSeq)
    const firstBoundary = Math.max(opened.previousSeq, ...firstEvents.map(event => event.seq))
    const firstCalls = callsFrom(firstEvents)
    const firstSucceeded = successfulCalls(firstEvents)
    const firstTurnEnd = firstEvents.findLast(event => event.type === 'turn/end')?.data?.reason?.kind ?? 'missing'

    // This is a new topic, but intentionally contains no "允许联网" or other
    // explicit reset phrase. The Harness must derive current web needs from the
    // newest user request instead of leaking the previous turn's offline scope.
    await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '另外，查一下今天上海的天气预报。从公开搜索结果取得可核验的来源摘要后再综合回答，并附上来源网址。' }],
    })
    const secondWaiting = await waitForIdle(sessionId)
    const history = await rpc('session.history', { sessionId, maxMessages: 300 })
    const events = history.events.map(row => row.event).filter(event => event.seq > opened.previousSeq)
    const secondEvents = events.filter(event => event.seq > firstBoundary)
    const secondCalls = callsFrom(secondEvents)
    const secondSucceeded = successfulCalls(secondEvents)
    const secondResults = resultEventsByCallId(secondEvents)
    const routeFor = call => researchNetworkRoute(call.name, call.arguments, secondResults.get(call.callId))
    const successfulSearches = secondCalls.filter(call => routeFor(call) === 'search' && secondSucceeded(call))
    const sourceBodies = successfulSearches.map(call => toolResultText(secondResults.get(call.callId))).filter(Boolean)
    const bodyRouteCalls = secondCalls.filter(call => routeFor(call) === 'body')
    const successfulBodyReads = bodyRouteCalls.filter(call => secondSucceeded(call)).map(call => ({
      name: call.name, arguments: call.arguments, result: secondResults.get(call.callId),
    }))
    const bodyRouteFailed = bodyRouteCalls.some(call => !secondSucceeded(call))
    const answer = latestVisibleAssistantAnswer(secondEvents)
    const secondTurnEnd = secondEvents.findLast(event => event.type === 'turn/end')?.data?.reason?.kind ?? 'missing'
    const receipt = completionReceipt(history)
    const sourceProof = onlineResearchEvidence(successfulSearches.map(call => ({
      name: call.name,
      arguments: call.arguments,
      result: secondResults.get(call.callId),
    })), answer, new Date(), successfulBodyReads)
    const firstRead = firstCalls.some(call => isReadOrSearchTool(call.name)
      && callMentions(call, research.sources[0]) && firstSucceeded(call))
    const firstNoNetwork = !firstCalls.some(call => isNetworkTool(call.name))
    const noUnsafeAction = !secondCalls.some(call => isWriteTool(call.name) || isShellTool(call.name))
    const networkCalls = secondCalls.filter(call => isNetworkTool(call.name))
    const researchNetworkSafe = networkCalls.every(call => researchNetworkAttemptSafe(
      call.name,
      call.arguments,
      secondResults.get(call.callId),
      secondSucceeded(call),
    ))

    scenario.runtime = {
      firstTurn: {
        settled: firstWaiting.settled,
        turnEnd: firstTurnEnd,
        calls: firstCalls.map(call => ({ name: call.name, succeeded: firstSucceeded(call) })),
      },
      secondTurn: {
        settled: secondWaiting.settled,
        turnEnd: secondTurnEnd,
        diagnostics: harnessTurnDiagnostics(secondEvents),
        calls: secondCalls.map(call => ({ name: call.name, succeeded: secondSucceeded(call) })),
        searchResultPreviews: sourceBodies.map(body => body.slice(0, 1_000)),
        bodyRouteCalls: bodyRouteCalls.map(call => ({ name: call.name, succeeded: secondSucceeded(call) })),
        sourceProof,
        answer: answer.slice(0, 4_000),
        receipt: receipt === null ? null : { schemaVersion: receipt.schemaVersion, outcome: receipt.outcome },
      },
    }
    assertCheck(scenario, 'first-turn-settled', firstWaiting.settled, firstWaiting)
    assertCheck(scenario, 'first-turn-end-completed', firstTurnEnd === 'completed', firstTurnEnd)
    assertCheck(scenario, 'first-turn-local-source-read', firstRead, firstCalls.map(call => ({ name: call.name, arguments: call.arguments })))
    assertCheck(scenario, 'first-turn-offline-honored', firstNoNetwork, firstCalls.map(call => call.name))
    assertCheck(scenario, 'second-turn-settled', secondWaiting.settled, secondWaiting)
    assertCheck(scenario, 'second-turn-end-completed', secondTurnEnd === 'completed', secondTurnEnd)
    assertCheck(scenario, 'completion-receipt-contract-v2', currentCompletionReceiptContract(receipt), receipt ?? 'missing')
    assertCheck(scenario, 'completion-receipt-bound-to-current-turn', completionReceiptMatchesEvents(receipt, events), {
      receiptTurn: receipt?.turn, receiptSourceSeq: receipt?.sourceSeq,
      latestTurnEnd: events.findLast(event => event.type === 'turn/end')?.seq,
    })
    assertCheck(scenario, 'new-topic-restores-relevant-web-search', sourceProof.relevantSearchCount > 0, {
      calls: secondCalls.map(call => ({ name: call.name, arguments: call.arguments, succeeded: secondSucceeded(call) })),
      sourceProof,
    })
    assertCheck(scenario, 'search-returned-verifiable-source-list', sourceProof.sourceListReady, {
      previews: sourceBodies.map(body => body.slice(0, 2_000)), sourceUrls: sourceProof.sourceUrls,
    })
    assertCheck(scenario, 'research-body-or-honest-source-only-partial', sourceProof.bodyReady
      || (sourceProof.sourceOnlyPartialReady && (bodyRouteFailed || sourceProof.staleBodyCount > 0)), { sourceProof, bodyRouteFailed,
      bodyRouteCalls: bodyRouteCalls.map(call => ({ name: call.name, succeeded: secondSucceeded(call) })) })
    assertCheck(scenario, 'current-answer-has-no-explicit-stale-date', !sourceProof.answerTemporalMismatch, sourceProof)
    assertCheck(scenario, 'answer-cites-a-returned-public-source', sourceProof.passed, sourceProof)
    assertCheck(scenario, 'online-research-remains-read-only', noUnsafeAction, secondCalls.map(call => call.name))
    assertCheck(scenario, 'online-network-execution-contained-by-public-read-only-routes', researchNetworkSafe,
      networkCalls.map(call => ({
        name: call.name,
        route: routeFor(call),
        succeeded: secondSucceeded(call),
        contained: researchNetworkAttemptSafe(call.name, call.arguments, secondResults.get(call.callId), secondSucceeded(call)),
        arguments: call.arguments,
      })))
    assertCheck(scenario, 'no-synthetic-preflight-deny', syntheticPreflightDenials(events).length === 0, syntheticPreflightDenials(events))
    scenario.state = scenario.checks.every(check => check.state === 'pass') ? 'pass' : 'fail'
  } catch (error) {
    scenario.checks.push({ id: 'live-run', state: 'fail', detail: error instanceof Error ? error.message : String(error) })
    if (sessionId !== undefined) await rpc('session.cancel', { sessionId }).catch(() => {})
  }
  await persist()
}

try {
  if (ownedRun) {
    report.ownedRun.runtimeBefore = await ownedRun.verifyRuntime()
    if (report.acceptanceBinding?.runtimeIdentity !== ownedRun.config.runtimeIdentity
      || !/^[0-9a-f]{64}$/u.test(report.acceptanceBinding?.sourceSha256 ?? '')) throw new Error('owned-run requires the matching source/runtime acceptance binding')
  }
  if (!ownedRun) throw new Error('complex acceptance requires the owned complex-live entry and independent process/source evidence; host.describe was removed')
  const host = await ownedRun.verifyProcess()
  const matchesCheckout = runtimeRootMatches(host?.cwd, expectedRuntimeRoot)
  report.runtime = {
    endpoint: base,
    expectedRoot: expectedRuntimeRoot,
    reportedRoot: host?.cwd ?? null,
    hostVersion: host?.version ?? null,
    matchesCheckout,
  }
  if (!matchesCheckout) {
    throw new Error(`the service at ${base} is not running from this checkout: expected ${expectedRuntimeRoot}, received ${String(host?.cwd)}`)
  }
  const code = await createCodeFixture()
  const codeTarget = resolve(code, 'src/normalize.mjs')
  const codeTest = resolve(code, 'test/normalize.test.mjs')
  const requirements = resolve(code, 'requirements.md')
  const packageManifest = resolve(code, 'package.json')
  const protectedBefore = Object.fromEntries(await Promise.all([requirements, codeTest, packageManifest].map(async path => [relative(code, path), createHash('sha256').update(await readFile(path)).digest('hex')])))
  const codeBefore = createHash('sha256').update(await readFile(codeTarget)).digest('hex')
  const codeFilesBefore = (await walk(code)).map(path => relative(code, path))
  await runScenario('code-repair', code, [
    `在隔离目录 ${code} 完成代码修复。`,
    `必须先逐一读取需求 ${requirements}、测试 ${codeTest}、脚本清单 ${packageManifest} 和当前实现 ${codeTarget}，再决定改法。`,
    `只允许修改 ${codeTarget}；不得修改测试、需求或目录外文件。`,
    '完成修改后，必须在该隔离目录中依次单独运行 `npm run typecheck`、`npm run test`、`npm run build`，三项全部成功后再重新读取实现文件。不要合并命令，不要只描述方案，实际完成修复。',
  ].join('\n'), async ({ scenario, events, calls, callSucceeded, receipt, settled }) => {
    const resultsByCallId = resultEventsByCallId(events)
    const mutationCall = calls.find(call => isWriteTool(call.name) && callSucceeded(call))
    const mutation = mutationCall === undefined ? -1 : calls.indexOf(mutationCall)
    const mutationResultSeq = mutationCall === undefined ? -1 : resultsByCallId.get(mutationCall.callId)?.seq ?? -1
    const requiredEvidence = [requirements, codeTest, packageManifest, codeTarget]
    const evidenceCalls = Object.fromEntries(requiredEvidence.map(path => [relative(code, path), calls.find(call => isReadOrSearchTool(call.name)
      && callMentions(call, path) && callSucceeded(call))]))
    const evidenceResultSeqs = Object.fromEntries(Object.entries(evidenceCalls).map(([path, call]) => [path,
      call === undefined ? -1 : resultsByCallId.get(call.callId)?.seq ?? -1]))
    const evidenceComplete = mutationCall !== undefined && Object.values(evidenceResultSeqs)
      .every(seq => seq >= 0 && seq < mutationCall.seq)
    const verificationCalls = Object.fromEntries(['typecheck', 'test', 'build'].map(kind => [kind,
      calls.find(call => verificationCommandKind(call) === kind && callSucceeded(call)
        && callUsesSessionDirectory(call, code)
        && (resultsByCallId.get(call.callId)?.seq ?? -1) > mutationResultSeq)]))
    const verificationResultSeqs = Object.fromEntries(Object.entries(verificationCalls).map(([kind, call]) => [kind,
      call === undefined ? -1 : resultsByCallId.get(call.callId)?.seq ?? -1]))
    const verificationOrder = mutationResultSeq >= 0
      && verificationResultSeqs.typecheck > mutationResultSeq
      && verificationResultSeqs.test > verificationResultSeqs.typecheck
      && verificationResultSeqs.build > verificationResultSeqs.test
    const readBackCall = calls.find(call => isReadOrSearchTool(call.name)
      && callMentions(call, codeTarget) && callSucceeded(call)
      && (resultsByCallId.get(call.callId)?.seq ?? -1) > verificationResultSeqs.build)
    const readBackResultSeq = readBackCall === undefined ? -1 : resultsByCallId.get(readBackCall.callId)?.seq ?? -1
    const independent = await (async () => {
      if (!ownedRun) return execFileAsync(process.execPath, ['--test', codeTest], { cwd: code, timeout: 30_000, windowsHide: true })
      await ownedRun.assertCurrent()
      await assertComplexProtectedInputs(code, protectedBefore)
      // Parent-side testing imports model-editable code too; it must use the
      // same read-confined, network-denied launcher as the model's npm gates.
      const { createComplexSandboxInvocation } = await import('./complex-execution-sandbox.mjs')
      const { nodePath, npmPath, temporaryRoot } = ownedRun.config
      const invocation = createComplexSandboxInvocation({ nodePath, npmPath, temporaryRoot, fixtureRoot, command: 'node', args: ['--test', codeTest] })
      let result, execution
      try {
        result = await execFileAsync(invocation.command, invocation.args, { cwd: code, env: invocation.env, timeout: 30_000, maxBuffer: 1_048_576, windowsHide: true })
        execution = { code: 0, signal: null, stdout: result.stdout, stderr: result.stderr }
      } catch (error) {
        execution = { code: error.code ?? null, signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error: error.message }
        await ownedRun.retainResponse({ method: 'independent.node-test', rpcId: null, payload: { cwd: code, nodePath, npmPath, test: codeTest }, status: null, bytes: Buffer.from(`${JSON.stringify(execution)}\n`) })
        throw error
      }
      await ownedRun.retainResponse({ method: 'independent.node-test', rpcId: null, payload: { cwd: code, nodePath, npmPath, test: codeTest }, status: null, bytes: Buffer.from(`${JSON.stringify(execution)}\n`) })
      return result
    })()
      .then(result => ({ ok: true, output: result.stdout.slice(-2_000) }))
      .catch(error => ({ ok: false, output: `${error.stdout ?? ''}\n${error.stderr ?? error.message}`.slice(-2_000) }))
    const protectedAfter = Object.fromEntries(await Promise.all([requirements, codeTest, packageManifest].map(async path => [relative(code, path), createHash('sha256').update(await readFile(path)).digest('hex')])))
    const codeAfter = createHash('sha256').update(await readFile(codeTarget)).digest('hex')
    const codeFilesAfter = (await walk(code)).map(path => relative(code, path))
    assertCheck(scenario, 'decision-evidence-complete-before-mutation', evidenceComplete, {
      evidenceResultSeqs, mutationCallSeq: mutationCall?.seq ?? -1,
    })
    const fileWrites = calls.filter(call => isWriteTool(call.name))
    assertCheck(scenario, 'only-allowed-write', fileWrites.every(call => callMentions(call, codeTarget)), fileWrites)
    const shellCalls = calls.filter(call => isShellTool(call.name))
    assertCheck(scenario, 'shell-only-runs-required-verifiers', shellCalls.length >= 3
      && shellCalls.every(call => verificationCommandKind(call) !== undefined
        && callUsesSessionDirectory(call, code)), shellCalls.map(call => ({ name: call.name, kind: verificationCommandKind(call), arguments: call.arguments })))
    assertCheck(scenario, 'no-unnecessary-network-tools', !calls.some(call => isNetworkTool(call.name)), calls.map(call => call.name))
    assertCheck(scenario, 'verification-commands-after-mutation-in-order', verificationOrder, {
      mutationResultSeq, verificationResultSeqs,
    })
    assertCheck(scenario, 'readback-after-verification', readBackResultSeq > verificationResultSeqs.build, {
      verificationResultSeqs, readBackResultSeq,
    })
    assertCheck(scenario, 'evidence-action-verification-chain', evidenceComplete && verificationOrder
      && readBackResultSeq > verificationResultSeqs.build, {
      evidenceResultSeqs, mutationResultSeq, verificationResultSeqs, readBackResultSeq,
    })
    assertCheck(scenario, 'independent-fixture-test', independent.ok, independent.output)
    assertCheck(scenario, 'protected-inputs-unchanged', stable(protectedBefore) === stable(protectedAfter), { protectedBefore, protectedAfter })
    assertCheck(scenario, 'no-extra-files', stable(codeFilesBefore) === stable(codeFilesAfter), { before: codeFilesBefore, after: codeFilesAfter })
    assertCheck(scenario, 'allowed-implementation-changed', codeBefore !== codeAfter, 'fixture implementation digest changed')
    const linkReport = verificationLinkReport(events, calls, receipt)
    const expectedCodeGates = ['typecheck', 'test', 'build']
    assertCheck(scenario, 'receipt-required-code-gates', stable(receipt?.requirements ?? []) === stable(expectedCodeGates), receipt?.requirements ?? 'missing')
    assertCheck(scenario, 'verification-links-complete', linkReport.complete, linkReport)
    assertCheck(scenario, 'receipt-outcome-verified', receipt?.outcome === 'verified', receipt === null ? 'missing' : {
      outcome: receipt.outcome,
      unverified: receipt.unverified,
      verificationResults: receipt.verificationResults,
    })
    assertCheck(scenario, 'task-evidence-closure', evidenceComplete && mutation >= 0 && verificationOrder
      && readBackResultSeq > verificationResultSeqs.build && independent.ok && stable(protectedBefore) === stable(protectedAfter)
      && stable(codeFilesBefore) === stable(codeFilesAfter) && codeBefore !== codeAfter
      && linkReport.complete && receipt?.outcome === 'verified', {
      mutationResultSeq, verificationResultSeqs, readBackResultSeq, linkReport,
    })
    assertCheck(scenario, 'settled-before-evaluation', settled, 'receipt evaluated only after idle')
  })

  const research = await createResearchFixture()
  await runScenario('conflict-research', research.directory, [
    `只使用以下三个本地来源做版本化冲突研究：${research.sources.join('；')}。`,
    '逐一读取全部正文，说明三个日期、30/14/7 天之间的冲突，并明确指出哪一份为权威与为何。',
    '不得联网、不得写入文件、不得执行 shell；无法读取时应如实报告而非猜测。',
  ].join('\n'), async ({ scenario, calls, callSucceeded, answer, receipt }) => {
    const readEachSource = research.sources.every(path => calls.some(call => isReadOrSearchTool(call.name)
      && callMentions(call, path) && callSucceeded(call)))
    const noMutation = !calls.some(call => isWriteTool(call.name))
    const noShell = !calls.some(call => isShellTool(call.name))
    const noNetwork = !calls.some(call => isNetworkTool(call.name))
    const conflictExplicit = /冲突|不一致|supersed|取代/iu.test(answer) && /30/u.test(answer) && /14/u.test(answer) && /7/u.test(answer)
    const authorityCorrect = /权威|authoritative|最终/iu.test(answer) && /7\s*天/u.test(answer) && /2025-09-01/u.test(answer)
    assertCheck(scenario, 'all-three-bodies-read', readEachSource, calls.map(call => ({ name: call.name, arguments: call.arguments })))
    assertCheck(scenario, 'explicit-conflict', conflictExplicit, answer.slice(0, 2_000))
    assertCheck(scenario, 'authority-conclusion', authorityCorrect, answer.slice(0, 2_000))
    assertCheck(scenario, 'no-write-tools', noMutation, calls.map(call => call.name))
    assertCheck(scenario, 'no-shell-tools', noShell, calls.map(call => call.name))
    assertCheck(scenario, 'no-network-tools', noNetwork, calls.map(call => call.name))
    assertCheck(scenario, 'research-receipt-not-false-verified', receipt?.outcome !== 'verified' || (noMutation && noShell), receipt?.outcome ?? 'missing')
  })

  await runOfflineToOnlineScenario(research)

  const recovery = await createRecoveryFixture()
  await runScenario('failure-recovery', recovery.directory, [
    `先读取 ${recovery.missing}。它不存在时，不要反复调用同一失败路径。`,
    `改为读取 ${recovery.existing} 并仅报告其中的恢复证据。`,
    '禁止写文件、禁止 shell、禁止联网；错误后应收敛为诊断结果，不得声称原缺失文件已经读取或任务完全验证。',
  ].join('\n'), async ({ scenario, events, calls, callSucceeded, answer, receipt }) => {
    const resultEvents = resultEventsByCallId(events)
    const missingReads = calls.filter(call => isReadOrSearchTool(call.name) && callMentions(call, recovery.missing))
    const missingResult = missingReads.length === 1 ? resultEvents.get(missingReads[0].callId) : undefined
    const missingFailed = missingReads.length === 1 && missingReads[0].failed === true
    const recoveredCall = calls.find(call => isReadOrSearchTool(call.name) && callMentions(call, recovery.existing)
      && callSucceeded(call) && missingResult !== undefined && call.seq > missingResult.seq)
    const recovered = recoveredCall !== undefined && /RECOVERY-ALPHA/u.test(answer)
    const repeated = new Map()
    for (const call of calls) repeated.set(call.fingerprint, (repeated.get(call.fingerprint) ?? 0) + 1)
    const boundedRepeats = [...repeated.values()].every(count => count <= 2) && calls.length <= 8
    const noUnsafeAction = !calls.some(call => isWriteTool(call.name) || isShellTool(call.name))
    const noNetwork = !calls.some(call => isNetworkTool(call.name))
    assertCheck(scenario, 'attempted-missing-input-once', missingReads.length === 1, { count: missingReads.length, calls: missingReads })
    assertCheck(scenario, 'missing-input-call-failed', missingFailed, missingResult?.data?.error ?? missingResult?.data?.message ?? 'missing result')
    assertCheck(scenario, 'changed-to-fallback-route', recovered, { calls: calls.map(call => call.name), answer: answer.slice(0, 2_000) })
    assertCheck(scenario, 'bounded-repeat-calls', boundedRepeats, { total: calls.length, repetitions: [...repeated.values()] })
    assertCheck(scenario, 'no-write-or-shell-after-failure', noUnsafeAction, calls.map(call => call.name))
    assertCheck(scenario, 'no-network-after-failure', noNetwork, calls.map(call => call.name))
    const falseMissingClaim = claimsSourceRead(answer, recovery.missing)
    assertCheck(scenario, 'does-not-claim-missing-source-read', !falseMissingClaim, answer.slice(0, 2_000))
    assertCheck(scenario, 'does-not-claim-verified', receipt?.outcome !== 'verified', receipt?.outcome ?? 'missing')
  })

  await runSteerScenario(await createSteerFixture())
} catch (error) {
  report.scenarios.push({ id: 'setup', state: 'fail', checks: [{ id: 'fixture-or-runtime', state: 'fail', detail: error instanceof Error ? error.message : String(error) }] })
} finally {
  if (ownedRun) {
    for (const sessionId of createdSessions) {
      try {
        report.completeHistories.push(await collectCompleteComplexHistory(sessionId, rpc))
        report.cleanup.push({ id: `retain-full-history:${sessionId}`, state: 'pass' })
      } catch (error) {
        report.cleanup.push({ id: `retain-full-history:${sessionId}`, state: 'fail', detail: error instanceof Error ? error.message : String(error) })
      }
    }
    try {
      report.ownedRun.runtimeAfter = await ownedRun.verifyRuntime()
      const host = await ownedRun.verifyProcess()
      if (!runtimeRootMatches(host?.cwd, expectedRuntimeRoot)) throw new Error('owned host cwd changed')
      report.cleanup.push({ id: 'owned-runtime-after', state: 'pass' })
    } catch (error) {
      report.cleanup.push({ id: 'owned-runtime-after', state: 'fail', detail: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const sessionId of createdSessions) {
    try {
      await rpc('workspace.archiveSession', { sessionId })
      report.cleanup.push({ id: `archive:${sessionId}`, state: 'pass' })
    } catch (error) {
      report.cleanup.push({ id: `archive:${sessionId}`, state: 'fail', detail: error instanceof Error ? error.message : String(error) })
    }
  }
  try {
    if (ownedRun) {
      report.ownedRun.fixtures = await ownedRun.retainFixtures()
      report.cleanup.push({ id: 'retain-owned-fixtures-for-outer-cleanup', state: 'pass' })
    } else {
      await rm(fixtureRoot, { recursive: true, force: true })
      report.cleanup.push({ id: 'remove-temp-fixtures', state: 'pass' })
    }
  } catch (error) {
    report.cleanup.push({ id: ownedRun ? 'retain-owned-fixtures-for-outer-cleanup' : 'remove-temp-fixtures', state: 'fail', detail: error instanceof Error ? error.message : String(error) })
  }
  report.finishedAt = new Date().toISOString()
  await persist()
  process.stdout.write(`报告：${reportPath}\n`)
  if (report.scenarios.some(scenario => scenario.state !== 'pass') || report.cleanup.some(check => check.state !== 'pass')) process.exitCode = 1
}
