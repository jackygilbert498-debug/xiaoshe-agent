export interface TaskTimelineItem {
  readonly key: string
  readonly seq: number
  readonly time?: number
  readonly kind: 'user' | 'assistant' | 'tool' | 'error' | 'compaction' | 'status'
  readonly text: string
  /** Kept separate so consumers never mistake model reasoning for the answer. */
  readonly reasoning?: string
  readonly errorCode?: string
  readonly isError?: boolean
}
export interface TaskTimelineSnapshot {
  readonly sessionId?: string
  readonly items: readonly TaskTimelineItem[]
  /** Complete item count in the authoritative projection. */
  readonly total: number
  /** True when the current client window has older records available. */
  readonly hasEarlier: boolean
}
export interface TaskTimeline {
  getSnapshot(): TaskTimelineSnapshot
  subscribe(listener: () => void): () => void
  /** Expand the current session window by one provider-owned page. */
  loadEarlier(): void
}
