#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const root = resolve(new URL('..', import.meta.url).pathname)
const evidenceDir = join(root, 'docs', 'evidence', 'native-shell-phase-7')
const workspace = join(evidenceDir, 'model-session-workspace')
const outputFile = join(evidenceDir, 'model-approved-write.txt')
const reportFile = join(evidenceDir, 'real-model-approval-report.json')
const baseUrl = process.env.XIAOSHE_BASE_URL ?? 'http://127.0.0.1:3080'
const expected = 'XS_PHASE7_APPROVAL_REPLAY_OK\n'
const openSockets = new Set()

function rpcId(prefix) {
  return `${prefix}-${randomUUID()}`
}

async function call(method, payload) {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: rpcId(method), method, payload }),
  })
  if (!response.ok) throw new Error(`${method} transport failed with HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope?.result?.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(envelope?.result?.error ?? envelope)}`)
  }
  return envelope.result.value
}

function websocketUrl(pathname) {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = pathname
  return url.href
}

function openMux() {
  const socket = new WebSocket(websocketUrl('/api/events.mux'))
  openSockets.add(socket)
  const frames = []
  const waiters = []
  socket.addEventListener('message', (event) => {
    const envelope = JSON.parse(String(event.data))
    frames.push(envelope)
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i]
      if (waiter.predicate(envelope)) {
        waiters.splice(i, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(envelope)
      }
    }
  })
  const opened = new Promise((resolveOpened, reject) => {
    socket.addEventListener('open', resolveOpened, { once: true })
    socket.addEventListener('error', () => reject(new Error('mux websocket failed to open')), { once: true })
  })
  socket.addEventListener('close', () => openSockets.delete(socket), { once: true })
  return {
    socket,
    frames,
    opened,
    waitFor(predicate, timeoutMs = 45_000) {
      const existing = frames.find(predicate)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolveFrame, reject) => {
        const waiter = { predicate, resolve: resolveFrame, timer: undefined }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`mux frame timeout after ${timeoutMs}ms`))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    close() {
      socket.close()
    },
  }
}

async function respondApproval(envelope) {
  const frame = envelope.payload
  const response = await fetch(`${baseUrl}/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-response',
      rpcId: envelope.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: frame.sessionId,
          approvalId: frame.approvalId,
          outcome: 'allowed-once',
        },
      },
    }),
  })
  if (!response.ok) throw new Error(`approval response transport failed with HTTP ${response.status}`)
  const receipt = await response.json()
  if (receipt?.accepted !== true) throw new Error(`approval response rejected: ${JSON.stringify(receipt)}`)
  return receipt
}

async function waitForCompletion(sessionId) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const history = await call('session.history', { sessionId, maxMessages: 200 })
    const events = history.events.map(entry => entry.event)
    const end = events.findLast(event => event.type === 'turn/end')
    if (end !== undefined) return { history, events, end }
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  throw new Error('session did not reach turn/end within 90 seconds')
}

async function main() {
  await mkdir(workspace, { recursive: true })
  await rm(outputFile, { force: true })
  const firstMux = openMux()
  await firstMux.opened

  const { sessionId } = await call('session.create', { cwd: workspace })
  const permission = await call('commands/execute', {
    args: { agentId: sessionId, line: '/permission workspace-write', images: [] },
  })
  if (permission?.result?.kind !== 'success') {
    throw new Error(`permission switch did not complete: ${JSON.stringify(permission)}`)
  }
  const prompt = [
    '这是自动验收，只执行一个工具调用。',
    `使用 bash 执行：printf 'XS_PHASE7_APPROVAL_REPLAY_OK\\n' > '${outputFile}'`,
    '该文件位于当前工作区外；请在同一次 bash 调用中设置 sandbox_permissions 为 danger-full-access，',
    'justification 写“Phase 7 自动验收需要一次性写入受控证据文件”。不要改用其他工具，不要追加其他命令。',
    '工具成功后只回复 XS_PHASE7_APPROVAL_REPLAY_OK。',
  ].join('')
  await call('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
    clientTimeZone: 'Asia/Shanghai',
  })

  const firstApproval = await firstMux.waitFor(envelope => (
    envelope?.payload?.type === 'approval/requested' && envelope.payload.sessionId === sessionId
  ))
  firstMux.close()

  const replayMux = openMux()
  await replayMux.opened
  const replayedApproval = await replayMux.waitFor(envelope => (
    envelope?.payload?.type === 'approval/requested' && envelope.payload.sessionId === sessionId
  ))
  if (replayedApproval.rpcId !== firstApproval.rpcId
      || replayedApproval.payload.approvalId !== firstApproval.payload.approvalId) {
    throw new Error('replayed approval did not retain the original rpcId and approvalId')
  }

  await respondApproval(replayedApproval)
  const resolved = await replayMux.waitFor(envelope => (
    envelope?.payload?.type === 'approval/resolved'
      && envelope.payload.sessionId === sessionId
      && envelope.payload.approvalId === firstApproval.payload.approvalId
  ))
  replayMux.close()

  const completed = await waitForCompletion(sessionId)
  const output = await readFile(outputFile, 'utf8')
  if (output !== expected) throw new Error(`approved write mismatch: ${JSON.stringify(output)}`)

  const assistant = completed.events.findLast(event => event.type === 'assistant/message')
  const asked = completed.events.find(event => event.type === 'approval/asked')
  const decided = completed.events.find(event => event.type === 'approval/decided')
  if (asked === undefined || decided === undefined) throw new Error('durable approval audit events are missing')

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    service: baseUrl,
    sessionId,
    workspace,
    outputFile,
    model: assistant?.data?.message?.source,
    usage: assistant?.data?.usage,
    approval: {
      rpcIdStableAcrossReconnect: replayedApproval.rpcId === firstApproval.rpcId,
      approvalIdStableAcrossReconnect: replayedApproval.payload.approvalId === firstApproval.payload.approvalId,
      toolName: firstApproval.payload.toolName,
      callId: firstApproval.payload.callId,
      requestedReason: firstApproval.payload.reason,
      resolvedOutcome: resolved.payload.outcome,
      durableAskedSeq: asked.seq,
      durableDecidedSeq: decided.seq,
    },
    turnEnd: completed.end.data,
    output: { bytes: Buffer.byteLength(output), exactMatch: output === expected },
  }
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch(async (error) => {
  for (const socket of openSockets) socket.close()
  await mkdir(dirname(reportFile), { recursive: true })
  await writeFile(reportFile, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    service: baseUrl,
    status: 'failed',
    message: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`)
  process.stderr.write(`[real-model-approval] ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
