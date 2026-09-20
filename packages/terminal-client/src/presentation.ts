import { basename } from 'node:path'
import { parseTaskGraphView } from '@xiaoshe/runtime-contract'
import type { ModelSelection, QuestionAnswer, QuestionItem, SessionEvent, SessionProjectionBlock, SessionSummary } from './protocol.js'
import { isRecord } from './protocol.js'

export interface Palette {
  readonly reset: string
  readonly dim: string
  readonly user: string
  readonly assistant: string
  readonly tool: string
  readonly warning: string
  readonly success: string
  readonly heading: string
}

const ANSI: Palette = {
  reset: '\u001B[0m', dim: '\u001B[38;5;245m', user: '\u001B[38;5;108m', assistant: '\u001B[38;5;108m',
  tool: '\u001B[38;5;245m', warning: '\u001B[38;5;179m', success: '\u001B[38;5;108m', heading: '\u001B[1;38;5;108m',
}

const PLAIN: Palette = { reset: '', dim: '', user: '', assistant: '', tool: '', warning: '', success: '', heading: '' }

export function palette(enabled: boolean): Palette {
  return enabled ? ANSI : PLAIN
}

export function oneLine(value: string, max = 72): string {
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(1, max - 1))}…`
}

export function sessionTitle(session: SessionSummary): string {
  const title = session.projections?.values.title
  if (typeof title === 'string' && title.trim() !== '') return oneLine(title, 48)
  if (session.cwd !== undefined) {
    const candidate = basename(session.cwd)
    if (candidate !== '') return candidate
  }
  return '未命名会话'
}

export function modelLabel(model: ModelSelection): string {
  return `${model.model}${model.reasoningEffort === undefined ? '' : ` · ${model.reasoningEffort}`}`
}

function textBlocks(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('')
}

/** Extract final/user text across current and pre-react-loop durable shapes. */
export function eventText(event: SessionEvent): string {
  if (!isRecord(event.data)) return ''
  if (Array.isArray(event.data.stream)) return event.data.stream.flatMap(record => {
    if (!isRecord(record)) return []
    if (record.type === 'text-chunks' && Array.isArray(record.texts)) return record.texts.filter((text): text is string => typeof text === 'string')
    if (record.type === 'chunk' && isRecord(record.chunk) && record.chunk.type === 'text-delta' && typeof record.chunk.text === 'string') return [record.chunk.text]
    return []
  }).join('')
  if (isRecord(event.data.message)) return textBlocks(event.data.message.content)
  return textBlocks(event.data.content)
}

export function eventUsage(event: SessionEvent): Record<string, number> | undefined {
  if (!isRecord(event.data) || !isRecord(event.data.usage)) return undefined
  const result: Record<string, number> = {}
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const value = event.data.usage[key]
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
  }
  return Object.keys(result).length === 0 ? undefined : result
}

export function eventTurn(event: SessionEvent): number | undefined {
  if (!isRecord(event.data)) return undefined
  const turn = event.data.turn
  return typeof turn === 'number' && Number.isInteger(turn) && turn >= 0 ? turn : undefined
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function projectionStatus(projections: SessionProjectionBlock | undefined): readonly string[] {
  if (projections === undefined) return ['上下文：尚无可用量']
  const values = projections.values
  const pressure = isRecord(values.contextPressure) ? values.contextPressure : undefined
  const usage = isRecord(values.tokenUsage) ? values.tokenUsage : undefined
  const projected = numeric(pressure?.projectedTokens) ?? numeric(pressure?.pressureTokens)
  const window = numeric(pressure?.contextWindow)
  const used = projected === undefined || window === undefined || window <= 0 ? undefined : Math.min(999, projected / window * 100)
  const uncached = numeric(usage?.uncachedInputTokens) ?? 0
  const cached = numeric(usage?.cacheReadTokens) ?? 0
  const output = numeric(usage?.outputTokens) ?? 0
  const cacheRate = uncached + cached === 0 ? undefined : cached / (uncached + cached) * 100
  const context = projected === undefined || window === undefined
    ? '上下文：尚无可用量'
    : `上下文：${formatNumber(projected)} / ${formatNumber(window)}${used === undefined ? '' : `（${used.toFixed(1)}%）`}`
  const cumulative = `会话累计：输入 ${formatNumber(uncached)} · 缓存读取 ${formatNumber(cached)} · 输出 ${formatNumber(output)}`
  return [context, `${cumulative}${cacheRate === undefined ? '' : ` · 缓存命中 ${cacheRate.toFixed(1)}%`}`]
}

/** Render the same strictly parsed taskGraph view used by desktop, without creating scheduler state. */
export function taskGraphStatusLines(projections: SessionProjectionBlock | undefined, sessionId: string): readonly string[] {
  const graph = parseTaskGraphView(projections?.values.taskGraph, sessionId)
  if (graph === undefined) return []
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const completed = new Set(graph.nodes.filter(node => node.status === 'completed').map(node => node.id))
  const gated = graph.status === 'waiting' || graph.durability === 'pending' || graph.stale || graph.recoveryRequired
  const graphLabels = { ready: '可开始', active: '进行中', waiting: '等待检查', completed: '已完成' } as const
  const lines = [graph.status === 'waiting'
    ? `任务图：节点记录 ${completed.size} / ${graph.nodes.length} 已完成 · 等待检查`
    : `任务图：${completed.size} / ${graph.nodes.length} 完成 · ${graphLabels[graph.status]}`]
  if (graph.status === 'waiting') lines.push('  注意：任务状态等待检查；节点状态为最近记录')
  if (graph.durability === 'pending') lines.push('  注意：任务图变更尚未持久化')
  if (graph.stale) lines.push('  注意：任务定义已过期，等待刷新')
  if (graph.recoveryRequired) lines.push('  注意：运行实例已变化，需要恢复检查')
  const latestFeedback = graph.feedback.at(-1)?.text
  if (latestFeedback !== undefined) lines.push(`  图的最近反馈：${oneLine(latestFeedback, 120)}`)
  for (const node of graph.nodes) {
    const ready = node.status === 'pending' && !gated && node.dependencies.every(id => completed.has(id))
    const baseStatus = node.status === 'pending' ? (ready ? '可开始' : node.dependencies.every(id => completed.has(id)) ? '等待中' : '等待依赖') : ({
      running: '进行中', verifying: '待验收', completed: '已完成', blocked: '已阻塞', interrupted: '已中断 · 待检查',
    } as const)[node.status]
    const status = graph.status !== 'waiting' ? baseStatus
      : node.status === 'running' ? '上次记录：进行中'
        : node.status === 'verifying' ? '上次记录：待验收'
          : node.status === 'completed' ? '节点记录：已完成' : baseStatus
    const attempt = node.attempt < 1 ? '' : ` · 第 ${node.attempt} 次`
    lines.push(`  - ${oneLine(node.title, 72)} · ${status}${attempt}`)
    if (node.dependencies.length > 0) lines.push(`    依赖：${node.dependencies.map(id => oneLine(byId.get(id)?.title ?? id, 40)).join('、')}`)
    const feedback = node.feedback.at(-1)?.text
    if (feedback !== undefined) lines.push(`    最新反馈：${oneLine(feedback, 100)}`)
    const assessments = node.evidence.filter(item => item.kind === 'reviewer-assessment').length
    const executions = node.evidence.filter(item => item.kind === 'execution').length
    if (assessments + executions > 0) lines.push(`    依据：执行记录 ${executions} · 验收评估 ${assessments}`)
  }
  return lines
}

export function formatNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.00$/u, '')}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, '')}K`
  return String(Math.round(value))
}

/** Parse a numbered/custom answer without inventing an option label. */
export function parseQuestionAnswer(question: QuestionItem, raw: string): QuestionAnswer | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  const options = question.options ?? []
  if (options.length === 0) return { id: question.id, selected: [], custom: value }
  const pieces = question.multiSelect === true ? value.split(/[，,\s]+/u).filter(Boolean) : [value]
  const selected: string[] = []
  for (const piece of pieces) {
    const index = Number(piece)
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      const label = options[index - 1]?.label
      if (label !== undefined && !selected.includes(label)) selected.push(label)
      continue
    }
    if (question.multiSelect !== true && pieces.length === 1) return { id: question.id, selected: [], custom: value }
    return undefined
  }
  return { id: question.id, selected }
}

export function turnReason(event: SessionEvent): string {
  if (!isRecord(event.data) || !isRecord(event.data.reason) || typeof event.data.reason.kind !== 'string') return '结束'
  const kind = event.data.reason.kind
  const labels: Record<string, string> = {
    completed: '完成', interrupted: '已中断', aborted: '已取消', error: '失败', rejected: '已拒绝', 'max-tokens': '达到词元上限', disposed: '已停止',
  }
  return labels[kind] ?? kind
}
