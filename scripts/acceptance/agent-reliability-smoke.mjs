#!/usr/bin/env node
/** Explicit live acceptance. Creates only its own local Xiaoshe test session. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import {
  claimsCompletedModelSwitch,
  claimsUnverifiedHealth,
  describesModlensVision,
  isBoundedVisualBoundary,
  verifiesImageAnswer,
} from './agent-result-checks.mjs'
import { buildEventDiagnostics, isExternalTransportBoundary } from './agent-event-observability.mjs'
import {
  buildToolCallRecords,
  callTargetsExactPath,
  decideScenarioState,
  hasExactFailedRead,
  hasFailedReadThenRecovery,
  hasExactWriteReadback,
  parseSmokeCliArgs,
  reportExitCode,
} from './agent-reliability-smoke-policy.mjs'
import { resolveLocalAcceptanceBase } from './local-acceptance-base.mjs'
import { acceptanceRpc } from './public-rpc.mjs'
import { eventText } from '../../packages/terminal-client/lib/presentation.js'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const base = resolveLocalAcceptanceBase()
const sessionId = `xiaoshe-acceptance-${Date.now()}`
const destination = resolve(root, `output/acceptance/agent-reliability-${Date.now()}.json`)
const { allowPendingExternal, imagePath } = parseSmokeCliArgs(process.argv.slice(2))
const report = { schemaVersion: 2, createdAt: new Date().toISOString(), sessionId, allowPendingExternal, checks: [] }
let activeSessionId = sessionId
const createdSessionIds = new Set()

function mentionsIdentifier(text, identifier) {
  if (typeof identifier !== 'string' || identifier.trim() === '') return false
  const canonical = value => value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/gu, '')
  return canonical(text).includes(canonical(identifier))
}

const rpc = acceptanceRpc(base)
async function persist() {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n')
}
async function scenario(id, text, verify, { image, classifyError } = {}) {
  const started = Date.now()
  try {
    // Every check is isolated. A provider failure can leave an unanswered user
    // message in the session; sharing it would make the next check answer both
    // prompts and falsely attribute one result to another scenario.
    activeSessionId = `${sessionId}-${id}`
    await rpc('session.create', { sessionId: activeSessionId, cwd: root })
    createdSessionIds.add(activeSessionId)
    await rpc('session.rename', { sessionId: activeSessionId, title: `小蛇 Agent 验收：${id}` })
    const before = await rpc('session.history', { sessionId: activeSessionId, maxMessages: 1 })
    const previous = before.events.at(-1)?.event.seq ?? -1
    const content = [{ type: 'text', text }]
    if (image) content.push({ type: 'image', mediaType: 'image/png', data: (await readFile(image)).toString('base64'), name: 'acceptance.png' })
    await rpc('session.prompt', { sessionId: activeSessionId, mode: 'queue', content })
    process.stdout.write(`[开始] ${id}\n`)
    let settled = false
    while (Date.now() - started < 150000) {
      await delay(2000)
      const list = await rpc('session.list', {})
      if (!list.items.find(item => item.sessionId === activeSessionId)?.running) { settled = true; break }
    }
    if (!settled) await rpc('session.cancel', { sessionId: activeSessionId })
    const history = await rpc('session.history', { sessionId: activeSessionId, maxMessages: 30 })
    const events = history.events.map(row => row.event).filter(event => event.seq > previous)
    const calls = buildToolCallRecords(events)
    const answers = events.filter(event => event.type === 'assistant/message').flatMap(event => Array.isArray(event.data?.stream)
      ? [eventText(event)] : (event.data.message?.content ?? event.data.content ?? []).filter(block => block.type === 'text').map(block => block.text))
    const result = { id, sessionId: activeSessionId, settled, elapsedMs: Date.now() - started,
      calls: calls.map(call => ({ callId: call.callId, name: call.name, resultSeq: call.resultSeq, succeeded: call.succeeded })),
      answer: answers.join('\n'),
      ...buildEventDiagnostics(events),
      turnEnd: events.findLast(event => event.type === 'turn/end')?.data.reason?.kind ?? 'missing' }
    const verdict = settled ? await verify({ ...result, calls }, { events }) : false
    result.state = decideScenarioState({
      settled,
      turnEnd: result.turnEnd,
      verdict,
      externalBoundary: isExternalTransportBoundary(result, result),
    })
    report.checks.push(result)
    await persist()
    process.stdout.write(`[${result.state}] ${id}，${Math.round(result.elapsedMs / 1000)} 秒；工具=${calls.map(call => call.name).join(',') || '无'}\n${result.answer.slice(0, 1800)}\n`)
  } catch (error) {
    await rpc('session.cancel', { sessionId: activeSessionId }).catch(() => {})
    const state = decideScenarioState({
      settled: false,
      turnEnd: 'missing',
      verdict: classifyError?.(error) ?? false,
    })
    const result = { id, sessionId: activeSessionId, state, elapsedMs: Date.now() - started, detail: error.message }
    report.checks.push(result)
    await persist()
    process.stdout.write(`[${state}] ${id}，${Math.round(result.elapsedMs / 1000)} 秒；${result.detail}\n`)
  }
}

try {
  // The acceptance artifact is intentionally written below this checkout, so
  // give the test session that exact cwd instead of an unrelated loose sandbox.
  await rpc('session.create', { sessionId, cwd: root })
  createdSessionIds.add(sessionId)
  await rpc('session.rename', { sessionId, title: '小蛇 Agent 可靠性验收（自动测试）' })
  const models = await rpc('session.models', { sessionId })
  report.model = models.current
  await scenario('runtime-awareness', '当前用的是什么模型？带 modlens vision 是什么意思？需要重新配模型吗？', result =>
    mentionsIdentifier(result.answer, report.model?.model) && describesModlensVision(result.answer)
      && !claimsUnverifiedHealth(result.answer)
      && !result.calls.some(call => call.name === 'bash'))
  await scenario('capability-planning', '请调用 xiaoshe_capability_plan，为“搜索今天的最新产品消息”选择当前会话已注册的候选路线；不要执行候选工具，只报告首选工具名和能力边界。', result =>
    result.calls.some(call => call.name === 'xiaoshe_capability_plan' && call.succeeded)
      && /web_search/iu.test(result.answer)
      && !result.calls.some(call => ['bash', 'pwsh', 'shell', 'exec_command'].includes(call.name)))
  await scenario('real-document-result', `读一下 ${resolve(root, 'scripts/acceptance/fixtures/agent-brief.txt')}，告诉我验收口令、预算和下一步。`, result =>
    /PINE-7429/u.test(result.answer) && /318/u.test(result.answer) && /3\s*份/u.test(result.answer)
      && result.calls.some(call => call.name === 'read' && call.succeeded
        && callTargetsExactPath(call, resolve(root, 'scripts/acceptance/fixtures/agent-brief.txt')))
      && !result.calls.some(call => ['bash', 'pwsh', 'shell', 'exec_command'].includes(call.name)))
  await scenario('wrong-path-recovery', `先读取 ${resolve(root, 'scripts/acceptance/fixtures/missing/agent-brief.txt')}。如果路径不存在，不要停在错误里；请在 ${resolve(root, 'scripts/acceptance/fixtures')} 中查找并读取真实文件，再告诉我验收口令。`, result =>
    /PINE-7429/u.test(result.answer)
      && result.calls.length >= 2 && result.calls.length <= 6
      && hasFailedReadThenRecovery(
        result.calls,
        resolve(root, 'scripts/acceptance/fixtures/missing/agent-brief.txt'),
        resolve(root, 'scripts/acceptance/fixtures/agent-brief.txt'),
      )
      && !result.calls.some(call => ['bash', 'pwsh', 'shell', 'exec_command'].includes(call.name)))
  const artifactPath = resolve(root, `output/acceptance/${sessionId}-result.json`)
  await scenario('verified-file-delivery', `按刚才那份资料，创建 ${artifactPath}。JSON 必须严格使用这些值和类型：{"project":"松果资料助手","code":"PINE-7429","budget":318,"sampleCount":3}，其中 budget 和 sampleCount 都是数字。完成后重新读取核对，告诉我结果。只写这个新文件，不修改其他文件或配置。`, async result => {
    const artifact = await readFile(artifactPath, 'utf8').then(JSON.parse).catch(() => null)
    return artifact?.project === '松果资料助手' && artifact?.code === 'PINE-7429' && artifact?.budget === 318 && artifact?.sampleCount === 3
      && hasExactWriteReadback(result.calls, artifactPath)
  })
  await scenario('missing-input-convergence', `读取 ${resolve(root, 'scripts/acceptance/fixtures/does-not-exist-7429.txt')}，总结其中的正文。`, result =>
    /不存在|未找到|找不到|没有找到/u.test(result.answer)
      && hasExactFailedRead(result.calls, resolve(root, 'scripts/acceptance/fixtures/does-not-exist-7429.txt'))
      && result.calls.length <= 5 && result.turnEnd === 'completed')
  await scenario('model-selection-boundary', '请把当前会话切换到 DeepSeek-V4-Flash。如果当前工具里没有模型切换能力，不要声称已经切换，告诉我应该从界面哪里操作。', result =>
    /模型|输入框|选择|下拉|界面/u.test(result.answer)
      && !claimsCompletedModelSwitch(result.answer)
      && !result.calls.some(call => ['bash', 'pwsh', 'shell', 'exec_command'].includes(call.name)))
  if (imagePath) {
    await scenario('native-image-read', `图片输入框底部选中的模型是什么？读取 ${resolve(imagePath)}，只根据图中的文字回答，不要猜。`, (result, { events }) =>
      verifiesImageAnswer(result.answer, events, 'DeepSeek-V4-Pro', { targetPath: resolve(imagePath) })
        || (isBoundedVisualBoundary(result.answer, events, { targetPath: resolve(imagePath) }) ? 'pending_external' : false))
    await scenario('pasted-image-read', '图片输入框底部选中的模型是什么？只根据本次图片里的文字回答。', (result, { events }) =>
      verifiesImageAnswer(result.answer, events, 'DeepSeek-V4-Pro', { requireImageTool: false })
        && !result.calls.some(call => call.name === 'bash'), {
      image: imagePath,
      classifyError: error => /does not support image input/iu.test(error.message) ? 'pending_external' : 'fail',
    })
  } else report.checks.push({ id: 'image-read', state: 'not_run', detail: '未提供复现截图路径，不能判定读图已通过。' })
} catch (error) {
  report.checks.push({ id: 'live-run', state: 'fail', detail: error.message })
  await rpc('session.cancel', { sessionId: activeSessionId }).catch(() => {})
} finally {
  await persist()
  for (const createdSessionId of createdSessionIds) {
    try {
      await rpc('workspace.archiveSession', { sessionId: createdSessionId })
    } catch (error) {
      report.checks.push({ id: `cleanup:${createdSessionId}`, state: 'fail', detail: error.message })
    }
  }
  await persist()
  process.stdout.write(`报告：${destination}\n`)
  process.exitCode = reportExitCode(report.checks, { allowPendingExternal })
}
