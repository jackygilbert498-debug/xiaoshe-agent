#!/usr/bin/env node

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  DshApiClient, MuxConnection, eventText, eventTurn, eventUsage,
} from '../packages/terminal-client/lib/index.js'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const DEFAULT_REPORT = resolve(ROOT, 'docs/evidence/terminal-client/shared-runtime-report.json')
const EXPECTED = 'XS_TERMINAL_SHARED_RUNTIME_OK'

function options(argv) {
  const result = {
    baseUrl: process.env.XIAOSHE_BASE_URL ?? 'http://127.0.0.1:3080',
    output: DEFAULT_REPORT,
    timeoutMs: 90_000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg === '--url' && value !== undefined) { result.baseUrl = value; index += 1; continue }
    if (arg === '--output' && value !== undefined) { result.output = resolve(value); index += 1; continue }
    if (arg === '--timeout-ms' && value !== undefined) {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1_000) throw new Error('--timeout-ms 必须是不小于 1000 的整数')
      result.timeoutMs = parsed
      index += 1
      continue
    }
    throw new Error(`未知或缺值参数：${arg}`)
  }
  return result
}

async function nextWithin(mux, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      mux.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`等待共享 Runtime 事件超过 ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitForSubscription(mux, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!mux.hasSubscription(sessionId)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('等待新会话订阅超时')
    const envelope = await nextWithin(mux, remaining)
    if (envelope.payload.type === 'stream/error') throw new Error(envelope.payload.error.message)
  }
}

async function writeReport(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, path)
}

async function main() {
  const config = options(process.argv.slice(2))
  const api = new DshApiClient(config.baseUrl)
  const mux = new MuxConnection(api.muxUrl())
  let sessionId
  try {
    await mux.opened
    sessionId = await api.createSession(ROOT)
    await waitForSubscription(mux, sessionId, config.timeoutMs)
    const model = await api.models(sessionId)
    const before = await api.history(sessionId, 1)
    let floorSeq = before.events.at(-1)?.event.seq ?? -1
    const promptResult = await api.prompt(
      sessionId,
      `这是共享 Runtime 自动验收。不要调用工具，只输出唯一一行：${EXPECTED}`,
      'Asia/Shanghai',
    )
    if (promptResult.commandText !== undefined) throw new Error('真实模型提示被误识别为斜杠命令')

    const deadline = Date.now() + config.timeoutMs
    const eventTypes = []
    const unexpectedInteractions = []
    let startedTurn
    let assistantText = ''
    let usage
    let turnEnd
    while (turnEnd === undefined) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('真实模型回合未在时限内完成')
      const envelope = await nextWithin(mux, remaining)
      const frame = envelope.payload
      if (frame.type === 'stream/error') throw new Error(frame.error.message)
      if (!('sessionId' in frame) || frame.sessionId !== sessionId) continue
      if (frame.type === 'approval/requested') {
        unexpectedInteractions.push('approval/requested')
        await api.respond(envelope.rpcId, {
          sessionId, approvalId: frame.approvalId, outcome: 'rejected',
        })
        continue
      }
      if (frame.type === 'question/requested') {
        unexpectedInteractions.push('question/requested')
        await api.respondCancelled(envelope.rpcId, '自动验收不回答交互问题')
        continue
      }
      if (frame.type !== 'session/event' || frame.event.seq <= floorSeq) continue
      floorSeq = frame.event.seq
      const event = frame.event
      eventTypes.push(event.type)
      if (event.type === 'turn/start') startedTurn = eventTurn(event)
      if (event.type === 'assistant/message') {
        const text = eventText(event)
        if (text !== '') assistantText = text.trim()
        usage = eventUsage(event) ?? usage
      }
      if (event.type === 'turn/end' && startedTurn !== undefined && eventTurn(event) === startedTurn) {
        turnEnd = event.data
      }
    }

    const recovered = await new DshApiClient(config.baseUrl).history(sessionId, 200)
    const recoveredTypes = recovered.events.map(entry => entry.event.type)
    const requiredTypes = ['turn/start', 'user/message', 'assistant/message', 'turn/end']
    const missingTypes = requiredTypes.filter(type => !recoveredTypes.includes(type))
    const listed = (await api.listSessions()).some(session => session.sessionId === sessionId)
    const exactOutput = assistantText === EXPECTED
    const passed = exactOutput && listed && missingTypes.length === 0 && unexpectedInteractions.length === 0
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: passed ? 'passed' : 'failed',
      service: config.baseUrl,
      sessionId,
      model,
      assistantText,
      expected: EXPECTED,
      exactOutput,
      usage,
      eventTypes,
      durableRecovery: { listed, recoveredEventCount: recovered.events.length, missingTypes },
      unexpectedInteractions,
      turnEnd,
      noUiAutomation: true,
    }
    await writeReport(config.output, report)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!passed) throw new Error('共享 Runtime 验收未满足全部断言')
  } catch (error) {
    const failed = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: 'failed',
      service: config.baseUrl,
      ...(sessionId === undefined ? {} : { sessionId }),
      message: error instanceof Error ? error.message : String(error),
      noUiAutomation: true,
    }
    await writeReport(config.output, failed)
    throw error
  } finally {
    mux.close()
  }
}

main().catch((error) => {
  process.stderr.write(`[terminal-shared-runtime] ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
