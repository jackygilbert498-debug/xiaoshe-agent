/** Tool-only data view: the product disables generic chat UI, not tool evidence. */
export const WORK_SURFACE_VIEW = 'xiaoshe.work-materials'

type Row = Record<string, unknown>
interface Match { readonly event: Row; readonly view?: { readonly for: string; readonly view: unknown } }
interface State { readonly startSeq: number; readonly row: Row; readonly root?: unknown; readonly parent?: unknown; readonly args: unknown; readonly valid: boolean; readonly known: ReadonlyMap<string, { root: string; name: string }> }
interface Context { readonly key: string; readonly id: string; readonly state?: State }
interface Node { readonly key: string; readonly kind: string; readonly id: string; readonly target: string; readonly data: Row }
export interface SurfaceViewRegistrationPort {
  readonly conversationEvents: { register(definition: unknown): unknown }
  readonly conversationViews: { register(definition: unknown): unknown }
}

function record(value: unknown): Row | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined
}

function identity(event: Row): { id: string; callId: string; role: 'start' | 'update' } | null {
  const data = record(event.data)
  if (data === undefined) return null
  if (event.type === 'tool/call' && typeof data.callId === 'string') return { id: `root:${data.callId}`, callId: data.callId, role: 'start' }
  if (event.type === 'tool/result' && event.surfaceOp === 'append') {
    const callId = record(record(data.message)?.source)?.callId
    return typeof callId === 'string' ? { id: `root:${callId}`, callId, role: 'update' } : null
  }
  if ((event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch' || event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch')
    && typeof data.rootCallId === 'string' && typeof data.parentCallId === 'string' && typeof data.subCallId === 'string') {
    return { id: `child:${JSON.stringify([data.rootCallId, data.parentCallId, data.subCallId])}`, callId: data.subCallId,
      role: String(event.type).endsWith('-start') ? 'start' : 'update' }
  }
  return null
}

/** Register into DSH's existing assembler; do not register or replace its chat target. */
export function registerWorkSurfaceView(scope: SurfaceViewRegistrationPort): void {
  scope.conversationEvents.register({
    kind: WORK_SURFACE_VIEW, target: WORK_SURFACE_VIEW,
    match: identity,
    start(_context: Context, match: Match, reader: { previous(kind: string): { state: State } | undefined }): State {
      const data = record(match.event.data) ?? {}
      const known = new Map(reader.previous(WORK_SURFACE_VIEW)?.state.known ?? [])
      const id = identity(match.event)?.callId ?? ''
      const nested = data.rootCallId !== undefined
      const parent = known.get(String(data.parentCallId))
      const root = known.get(String(data.rootCallId))
      const valid = !nested || (root?.name === 'run_code' && parent?.name === 'run_code'
        && parent.root === data.rootCallId && !known.has(id)
        && (id.startsWith(`${String(data.parentCallId)}:ptc:`) || id.startsWith(`${String(data.parentCallId)}:code:`)))
      if (valid) known.set(id, { root: nested ? String(data.rootCallId) : id, name: String(data.name) })
      const args = nested ? data.arguments : parseArguments(data.arguments)
      return {
        known, valid, args,
        startSeq: Number(match.event.seq), root: data.rootCallId, parent: data.parentCallId,
        row: { callId: identity(match.event)?.callId, name: data.name, time: match.event.time,
          // Call render intent is location/progress only. Requested diff text
          // and arbitrary raw arguments are never interpreted as a result.
          callView: match.view?.for === 'call' ? match.view.view : callView(data.name, args) },
      }
    },
    update(context: Context & { state: State }, match: Match): State {
      const data = record(match.event.data) ?? {}
      if (!context.state.valid || context.state.row.kind === 'tool-result' || Number(match.event.seq) <= context.state.startSeq) return context.state
      const nested = match.event.type === 'tool/code-dispatch' || match.event.type === 'tool/ptc-dispatch'
      if (nested && (data.rootCallId !== context.state.root || data.parentCallId !== context.state.parent
        || data.name !== context.state.row.name || JSON.stringify(data.arguments) !== JSON.stringify(context.state.args))) return context.state
      const result = nested ? data : record((record(data.message)?.content as unknown[] | undefined)?.[0])
      if (result === undefined) return context.state
      return { ...context.state, row: {
        kind: 'tool-result', callId: context.state.row.callId, seq: match.event.seq, time: match.event.time,
        call: { name: context.state.row.name }, content: result.content, isError: result.isError === true,
        callView: context.state.row.callView,
        resultView: match.view?.for === 'result' ? match.view.view : resultView(context.state.row.name, context.state.args, result, data.meta),
      } }
    },
    buildViewNode(context: Context): Node | null {
      // A history window lacking the actual start cannot safely reconstruct
      // call identity/intent. The host also withholds its unmatched presenter.
      return context.state === undefined || !context.state.valid ? null : {
        key: context.key, id: context.id, kind: WORK_SURFACE_VIEW, target: WORK_SURFACE_VIEW, data: context.state.row,
      }
    },
  })
  scope.conversationViews.register({
    target: WORK_SURFACE_VIEW,
    create() {
      const rows = new Map<string, Row>()
      const snapshot = () => {
        const values = [...rows.values()]
        return { nodes: values.filter(row => row.kind === 'tool-result'), runningCalls: values.filter(row => row.kind !== 'tool-result') }
      }
      return {
        empty: { nodes: [], runningCalls: [] },
        replace({ nodes }: { nodes: readonly Node[] }) {
          rows.clear()
          for (const node of nodes) rows.set(node.key, node.data)
          return snapshot()
        },
        apply({ upserts }: { upserts: readonly Node[] }) {
          for (const node of upserts) rows.set(node.key, node.data)
          return snapshot()
        },
      }
    },
  })
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

function callView(name: unknown, args: unknown): Row | null {
  const input = record(args)
  return (name === 'bash' || name === 'pwsh') && typeof input?.command === 'string'
    ? { card: 'terminal', title: input.command } : null
}

/** V3 history is raw: admit only replay-safe metadata from a paired successful result. */
function resultView(name: unknown, args: unknown, result: Row, rawMeta: unknown): Row | null {
  if (result.isError === true) return null
  const input = record(args)
  const meta = record(rawMeta)
  if (name === 'web_fetch' && typeof input?.url === 'string' && typeof meta?.url === 'string'
    && Number.isInteger(meta.statusCode) && typeof meta.truncated === 'boolean') {
    return { card: 'web', url: meta.url }
  }
  if (name === 'web_search' && Array.isArray(input?.queries) && input.queries.length > 0
    && input.queries.every(query => typeof query === 'string' && query.trim() !== '')
    && Array.isArray(meta?.sources) && typeof meta.truncated === 'boolean'
    && meta.sources.every(source => typeof record(source)?.url === 'string')) {
    return { card: 'web', sources: meta.sources }
  }
  if (name === 'read' && typeof input?.file_path === 'string' && typeof meta?.path === 'string'
    && Array.isArray(meta.lines) && Number.isSafeInteger(meta.totalLines) && Number(meta.totalLines) >= 0) {
    if (!meta.lines.every(line => { const row = record(line); return row !== undefined && Number.isSafeInteger(row.number) && Number(row.number) >= 1 && Number(row.number) <= Number(meta.totalLines) && typeof row.text === 'string' })) return null
    return { card: 'read', path: meta.path, lines: meta.lines, totalLines: meta.totalLines }
  }
  if ((name === 'edit' || name === 'write') && typeof input?.file_path === 'string' && Array.isArray(meta?.diffs)) {
    const diffs = meta.diffs
    if (!diffs.every(diff => { const row = record(diff); return row !== undefined && typeof row.path === 'string' && (row.oldText === null || typeof row.oldText === 'string') && typeof row.newText === 'string' })) return null
    // The write tool explicitly encodes successful creation as empty diffs.
    // Never use this fallback for errors, missing metadata, or edit intents.
    if (diffs.length === 0) return name === 'write' && typeof input.content === 'string'
      ? { card: 'diff', diffs: [{ path: input.file_path, oldText: null, newText: input.content }] } : null
    return { card: 'diff', diffs }
  }
  const process = record(meta?.shellProcess)
  if ((name === 'bash' || name === 'pwsh') && process?.kind === 'foreground' && Array.isArray(result.content)) {
    if (!result.content.every(block => record(block)?.type === 'text' && typeof record(block)?.text === 'string')) return null
    return { card: 'terminal', output: result.content.map(block => record(block)?.text).join('\n'),
      ...(Number.isSafeInteger(process.exitCode) ? { exitCode: process.exitCode } : {}) }
  }
  return null
}
