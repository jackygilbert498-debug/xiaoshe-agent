export interface ContextBudget {
  readonly source: 'dsh-token-meter'
  readonly usedTokens?: number
  readonly capacityTokens?: number
  /** Presentation ratio clamped to 0..1; raw DSH values remain in pressure. */
  readonly ratio?: number
  readonly level: 'unknown' | 'normal' | 'elevated' | 'critical'
}

export interface CompactionCheckpoint {
  readonly key: string
  readonly seq: number
  readonly summary: string
}

export interface ContextGovernanceEntry {
  readonly sessionId: string
  /** Canonical DSH token-meter projection. Its schema remains owned by DSH. */
  readonly pressure?: unknown
  /** Canonical DSH context-breakdown projection. */
  readonly breakdown?: unknown
  /** Canonical DSH token-usage projection. */
  readonly usage?: unknown
  readonly budget: ContextBudget
  readonly compactions: readonly CompactionCheckpoint[]
}

export interface ContextGovernanceSnapshot {
  readonly currentSessionId?: string
  readonly sessions: Readonly<Record<string, ContextGovernanceEntry>>
}

export interface ContextGovernance {
  getSnapshot(): ContextGovernanceSnapshot
  subscribe(listener: () => void): () => void
}

export function parseContextGovernanceSnapshot(value: unknown): ContextGovernanceSnapshot {
  if (!isRecord(value) || !isRecord(value.sessions)) throw new TypeError('ContextGovernanceSnapshot.sessions must be an object')
  const sessions: Record<string, ContextGovernanceEntry> = {}
  for (const [id, row] of Object.entries(value.sessions)) {
    if (!isRecord(row) || row.sessionId !== id) throw new TypeError(`invalid context governance row: ${id}`)
    sessions[id] = {
      sessionId: id,
      ...('pressure' in row ? { pressure: row.pressure } : {}),
      ...('breakdown' in row ? { breakdown: row.breakdown } : {}),
      ...('usage' in row ? { usage: row.usage } : {}),
      budget: deriveContextBudget(row.pressure),
      compactions: parseCompactionCheckpoints(row.compactions),
    }
  }
  return {
    ...(typeof value.currentSessionId === 'string' ? { currentSessionId: value.currentSessionId } : {}),
    sessions,
  }
}

/** Derive only presentation facts documented by DSH's token-meter projection. */
export function deriveContextBudget(value: unknown): ContextBudget {
  const pressure = isRecord(value) ? value : {}
  const projected = nonNegativeFinite(pressure.projectedTokens)
  const sampled = nonNegativeFinite(pressure.pressureTokens)
  const usedTokens = projected ?? sampled
  const capacityTokens = positiveFinite(pressure.contextWindow)
  const rawRatio = usedTokens === undefined || capacityTokens === undefined
    ? undefined
    : usedTokens / capacityTokens
  const ratio = rawRatio === undefined ? undefined : Math.min(1, Math.max(0, rawRatio))
  const level: ContextBudget['level'] = ratio === undefined
    ? 'unknown'
    : ratio >= 0.9
      ? 'critical'
      : ratio >= 0.7
        ? 'elevated'
        : 'normal'
  return {
    source: 'dsh-token-meter',
    ...(usedTokens === undefined ? {} : { usedTokens }),
    ...(capacityTokens === undefined ? {} : { capacityTokens }),
    ...(ratio === undefined ? {} : { ratio }),
    level,
  }
}

/** Extract Product checkpoints only from the canonical taskTimeline projection. */
export function deriveCompactionCheckpoints(value: unknown): readonly CompactionCheckpoint[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return []
  return value.items.flatMap((item): CompactionCheckpoint[] => {
    if (!isRecord(item) || item.kind !== 'compaction' || typeof item.key !== 'string'
      || typeof item.text !== 'string' || !isNonNegativeInteger(item.seq)) return []
    return [{ key: item.key, seq: item.seq, summary: item.text }]
  })
}

function parseCompactionCheckpoints(value: unknown): readonly CompactionCheckpoint[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('ContextGovernanceEntry.compactions must be an array')
  return value.map((item) => {
    if (!isRecord(item) || typeof item.key !== 'string' || typeof item.summary !== 'string'
      || !isNonNegativeInteger(item.seq)) throw new TypeError('invalid compaction checkpoint')
    return { key: item.key, seq: item.seq, summary: item.summary }
  })
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
