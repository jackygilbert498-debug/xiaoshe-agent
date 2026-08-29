#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidenceDir = join(root, 'docs', 'evidence', 'native-shell-phase-7')
const approvalReportPath = join(evidenceDir, 'real-model-approval-report.json')
const reportPath = join(evidenceDir, 'real-compaction-receipt-report.json')
const baseUrl = process.env.XIAOSHE_BASE_URL ?? 'http://127.0.0.1:3080'

async function call(method, payload) {
  const rpcId = `compaction-receipt-${method}-${Date.now()}-${Math.random()}`
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  if (!response.ok) throw new Error(`${method} transport failed with HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope?.result?.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(envelope?.result?.error ?? envelope)}`)
  return envelope.result.value
}

function eventRecord(entry) {
  const value = entry?.event
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('history contains an invalid event')
  return value
}

function sameRange(left, right) {
  return left?.start === right?.start && left?.end === right?.end
}

function textContent(blocks) {
  return Array.isArray(blocks)
    ? blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
    : ''
}

async function history(sessionId) {
  return call('session.history', { sessionId, maxMessages: 1_000 })
}

const approvalReport = JSON.parse(await readFile(approvalReportPath, 'utf8'))
const sessionId = process.env.XIAOSHE_ACCEPTANCE_SESSION_ID ?? approvalReport.sessionId
if (typeof sessionId !== 'string' || sessionId === '') throw new Error('real approval report has no reusable sessionId')

let snapshot = await history(sessionId)
let events = snapshot.events.map(eventRecord)
let summary = events.findLast(event => event.type === 'compaction/summary' && event.data?.llmStreamCall === true)
let commandResult
if (summary === undefined) {
  commandResult = await call('commands/execute', { args: { agentId: sessionId, line: '/compact', images: [] } })
  if (commandResult?.result?.kind !== 'success') throw new Error(`real /compact did not succeed: ${JSON.stringify(commandResult)}`)
  snapshot = await history(sessionId)
  events = snapshot.events.map(eventRecord)
  summary = events.findLast(event => event.type === 'compaction/summary' && event.data?.llmStreamCall === true)
}
if (summary === undefined) throw new Error('real compaction summary event is missing')

const compactionId = summary.data?.compactionId
const sourceCommandId = summary.data?.sourceCommandId
const start = events.find(event => event.type === 'compaction/start' && event.data?.compactionId === compactionId)
const checkpoint = events.find(event => event.type === 'user/message' && event.data?.source?.compactionId === compactionId)
const end = events.find(event => event.type === 'compaction/end' && event.data?.compactionId === compactionId)
const done = events.find(event => event.type === 'command/done' && event.data?.commandId === sourceCommandId)
if (start === undefined || checkpoint === undefined || end === undefined || done === undefined) {
  throw new Error('compaction transaction is incomplete')
}
if (start.data?.sourceCommandId !== sourceCommandId || end.data?.sourceCommandId !== sourceCommandId
  || done.data?.sourceEventSeq !== summary.seq || done.data?.kind !== 'success') {
  throw new Error('compaction command linkage is inconsistent')
}
if (!sameRange(summary.data?.shadowedRange, checkpoint.surfaceOp)
  || checkpoint.surfaceOp?.op !== 'replace'
  || !Array.isArray(summary.data?.shadowedSeqs)
  || summary.data.shadowedSeqs.length === 0
  || !summary.data.shadowedSeqs.every(seq => checkpoint.sourceEventSeqs?.includes(seq))) {
  throw new Error('compaction checkpoint does not replace the summarized range')
}
const summaryText = textContent(summary.data?.summary)
if (summaryText === '' || !(Number(summary.data?.shadowedTokenCount) > 0)) throw new Error('compaction summary is empty')

const receipt = snapshot.projections?.values?.completionReceipt
if (receipt?.outcome !== 'verified' || !Array.isArray(receipt.unverified) || receipt.unverified.length !== 0) {
  throw new Error(`completion receipt is not verified: ${JSON.stringify(receipt)}`)
}
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  service: baseUrl,
  sessionId,
  completionReceipt: {
    schemaVersion: receipt.schemaVersion,
    turn: receipt.turn,
    outcome: receipt.outcome,
    sourceSeq: receipt.sourceSeq,
    tools: receipt.tools,
    approvals: receipt.approvals,
    requirements: receipt.requirements,
    verificationResults: receipt.verificationResults,
    unverified: receipt.unverified,
  },
  compaction: {
    compactionId,
    sourceCommandId,
    eventSeqs: { start: start.seq, summary: summary.seq, checkpoint: checkpoint.seq, end: end.seq, commandDone: done.seq },
    provider: summary.data.provider,
    model: summary.data.model,
    llmStreamCall: summary.data.llmStreamCall,
    shadowedRange: summary.data.shadowedRange,
    shadowedItems: summary.data.shadowedSeqs.length,
    shadowedTokenCount: summary.data.shadowedTokenCount,
    usage: summary.data.usage,
    summarySha256: createHash('sha256').update(summaryText).digest('hex'),
    checkpointReplacementMatches: true,
    commandText: done.data.text,
  },
  assertions: {
    realModelSummary: typeof summary.data.provider === 'string' && typeof summary.data.model === 'string',
    durableTransactionComplete: true,
    surfaceReplacementCommitted: true,
    verifiedCompletionReceipt: true,
    noUnverifiedItems: true,
  },
  execution: commandResult === undefined ? 'verified-existing-success' : 'executed-now',
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
