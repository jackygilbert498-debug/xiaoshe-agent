/** Durable, session-authorized image reference. Never a URL or local path. */
export interface TaskTimelineImage {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** Copy only supported metadata; source blocks may contain unrelated fields. */
export function parseTaskTimelineImage(value: unknown): TaskTimelineImage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (typeof row.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(row.attachmentId)
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(row.mediaType))
    || ![row.bytes, row.width, row.height].every(number => typeof number === 'number' && Number.isSafeInteger(number) && number > 0)) return undefined
  return { attachmentId: row.attachmentId, mediaType: row.mediaType as TaskTimelineImage['mediaType'], bytes: row.bytes as number,
    width: row.width as number, height: row.height as number,
    ...(typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 255 && !/[\\/\u0000-\u001f\u007f]/u.test(row.name) ? { name: row.name } : {}) }
}

export interface TaskTimelineItem {
  readonly key: string
  readonly seq: number
  readonly time?: number
  readonly kind: 'user' | 'assistant' | 'tool' | 'error' | 'compaction' | 'status'
  readonly text: string
  readonly images?: readonly TaskTimelineImage[]
  /** Kept separate so consumers never mistake model reasoning for the answer. */
  readonly reasoning?: string
  readonly errorCode?: string
  readonly isError?: boolean
}
export interface TaskTimelineSnapshot {
  readonly sessionId?: string
  /** The canonical renderer has not arrived yet; absence is not an empty history. */
  readonly loading?: boolean
  readonly items: readonly TaskTimelineItem[]
  /** Complete item count in the authoritative projection. */
  readonly total: number
  /** True when the current client window has older records available. */
  readonly hasEarlier: boolean
}
export interface TaskTimeline {
  getSnapshot(): TaskTimelineSnapshot
  /** All user turns currently available in the authoritative projection, outside the display window too. */
  getOutline(): readonly { readonly key: string; readonly seq: number; readonly text: string }[]
  /** Expand this session's display window to an available sequence; invalid/missing sequences are ignored. */
  reveal(seq: number): void
  subscribe(listener: () => void): () => void
  /** Expand the current session window by one provider-owned page. */
  loadEarlier(): void
  /** Read only a displayed reference in the selected session; never resolves a path/URL. */
  readImage(input: { readonly sessionId: string; readonly attachmentId: string }): Promise<{ readonly attachment: TaskTimelineImage; readonly data: Uint8Array }>
}
