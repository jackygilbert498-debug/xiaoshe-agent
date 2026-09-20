import { randomUUID } from 'node:crypto'
import { document, state } from './schema.js'
import { identity, readSource } from './source.js'
import { ranked, render } from './selection.js'
import { fail, type Call, type Entry, type Identity, type Inspection, type Json, type Query, type QueryResult,
  type Save, type Scope, type Source, type State } from './types.js'

interface Receipt { identity: Identity; owner: string; sources: Source[]; expires: number }
const neutral = (status: 'disabled' | 'degraded'): QueryResult => ({ status, entries: [], stale: 0, omitted: 0, text: '', staleEntries: [] })
const sameIdentity = (a: Identity, b: Identity) => a.root === b.root && a.git === b.git

/** Compare source fingerprints against the actual pre-write record, never a
 * newly emitted summary. Only paths/versions leave this comparison, not stale text. */
function sourceChanges(existing: Entry | undefined, project: Identity, sources: Source[]) {
  const paths = [...new Set([...(existing?.sources ?? []), ...sources].map(source => source.path))].filter(path =>
    existing?.sources.find(source => source.path === path)?.sha256 !== sources.find(source => source.path === path)?.sha256)
  const kind = !existing ? 'new' : !sameIdentity(existing.identity, project) ? 'worktree_changed'
    : paths.length ? 'sources_changed' : 'unchanged'
  return { kind, paths }
}

/** Source knowledge is a rebuildable, bounded Settings projection, never an execution authority. */
export function createKnowledgeService(scope: Scope, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now
  const receipts = new Map<string, Receipt>()
  let writes: Promise<unknown> = Promise.resolve()
  function observed() {
    const snapshot = scope.getSnapshot()
    if (snapshot.status !== 'ready' || !Number.isSafeInteger(snapshot.revision)) return fail('STORAGE_DEGRADED')
    return { state: state(snapshot.value), revision: snapshot.revision }
  }
  function enabled(): void { if (!observed().state.enabled) fail('DISABLED') }
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = writes.then(operation, operation)
    writes = pending.then(() => undefined, () => undefined)
    return pending
  }
  async function checkSources(call: Call, expected: Identity, sources: Source[]): Promise<void> {
    if (!sameIdentity(await identity(call), expected)) return fail('SOURCE_CHANGED')
    for (const source of sources) {
      if ((await readSource(expected.root, source.path, call.signal)).sha256 !== source.sha256) return fail('SOURCE_CHANGED')
    }
    if (!sameIdentity(await identity(call), expected)) return fail('SOURCE_CHANGED')
  }
  /** Rebase only independent edits on namespace CAS conflicts; same-entry version conflicts surface. */
  async function mutate<T>(call: Call, transform: (current: State) => Promise<{ state: State; result: T }>): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      call.signal?.throwIfAborted()
      const current = observed()
      if (!current.state.enabled) return fail('DISABLED')
      const next = await transform(current.state)
      call.signal?.throwIfAborted()
      try {
        await scope.replace(next.state as unknown as Record<string, Json>, current.revision)
        return next.result
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'SETTINGS_CONFLICT') return fail('STORAGE_WRITE_FAILED')
      }
    }
    return fail('STORAGE_CONFLICT')
  }
  return {
    enabled(): boolean { try { return observed().state.enabled } catch { return false } },
    async inspect(call: Inspection) {
      enabled()
      if (typeof call.owner !== 'string' || !call.owner || call.owner.length > 240
        || !Array.isArray(call.paths) || !call.paths.length || call.paths.length > 8) return fail('INVALID_INSPECTION')
      const project = await identity(call)
      const sources: Array<Source & { text: string }> = []
      let totalBytes = 0
      for (const path of call.paths) {
        const source = await readSource(project.root, path, call.signal)
        totalBytes += Buffer.byteLength(source.text)
        if (totalBytes > 262_144) return fail('SOURCE_LIMIT')
        sources.push(source)
      }
      if (new Set(sources.map(source => source.path)).size !== sources.length) return fail('INVALID_INSPECTION')
      if (!sameIdentity(await identity(call), project)) return fail('SOURCE_CHANGED')
      // Expiring, owner-bound receipts certify an actual bounded tool read, not summary truth.
      for (const [id, receipt] of receipts) if (receipt.expires <= now()) receipts.delete(id)
      while (receipts.size >= 128) receipts.delete(receipts.keys().next().value!)
      const receipt = randomUUID()
      receipts.set(receipt, { identity: project, owner: call.owner, sources: sources.map(({ path, sha256 }) => ({ path, sha256 })), expires: now() + 900_000 })
      const existing = observed().state.entries.find(item => item.identity.root === project.root && item.sources[0]!.path === sources[0]!.path)
      enabled()
      const changes = sourceChanges(existing, project, sources)
      return { receipt, identity: project, sources, existing: existing ? { id: existing.id, version: existing.version } : null,
        changes,
        saveArgs: { receipt, expectedVersion: existing?.version ?? 0 },
        note: '摘要应由当前任务模型根据以上正文撰写；来源匹配不等于语义已验证。首个文件作为条目主键，其他文件是显式依赖；更新时使用 saveArgs。changes 比较的是更新前的持久版本：保存后新注入的知识不能反过来证明旧版本原本就正确。' }
    },
    save(call: Save) {
      return serialize(async () => {
        enabled()
        const receipt = receipts.get(call.receipt)
        if (!receipt || receipt.owner !== call.owner || receipt.expires <= now()) return fail('READ_REQUIRED')
        const parsed = document(call.document)
        if (!Number.isSafeInteger(call.expectedVersion) || call.expectedVersion < 0) return fail('INVALID_VERSION')
        const saved = await mutate(call, async current => {
          await checkSources(call, receipt.identity, receipt.sources)
          const existing = current.entries.find(item => item.identity.root === receipt.identity.root && item.sources[0]!.path === receipt.sources[0]!.path)
          if (call.id !== undefined && existing?.id !== call.id) return fail('NOT_FOUND')
          if ((existing?.version ?? 0) !== call.expectedVersion) return fail('VERSION_CONFLICT')
          if (!existing && current.entries.length >= 500) return fail('ENTRY_LIMIT')
          const entry: Entry = { id: existing?.id ?? randomUUID(), identity: receipt.identity, sources: receipt.sources,
            document: parsed, version: (existing?.version ?? 0) + 1, validatedAt: new Date(now()).toISOString() }
          const changes = sourceChanges(existing, receipt.identity, receipt.sources)
          const provenance = { kind: 'written_now' as const, previousVersion: existing?.version ?? 0, savedVersion: entry.version,
            priorSourceMatched: changes.kind === 'unchanged', changedSources: changes.paths }
          return { state: { ...current, entries: [...current.entries.filter(item => item.id !== entry.id), entry] }, result: { ...entry, provenance } }
        })
        receipts.delete(call.receipt)
        return structuredClone(saved)
      })
    },
    forget(call: Call & { id: string; expectedVersion: number }): Promise<{ forgotten: true }> {
      return serialize(async () => {
        const project = await identity(call)
        return mutate(call, async current => {
          const existing = current.entries.find(item => item.id === call.id && item.identity.root === project.root)
          if (!existing) return fail('NOT_FOUND')
          if (existing.version !== call.expectedVersion) return fail('VERSION_CONFLICT')
          return { state: { ...current, entries: current.entries.filter(item => item !== existing) }, result: { forgotten: true as const } }
        })
      })
    },
    async query(call: Query): Promise<QueryResult> {
      try {
        const snapshot = observed(), current = snapshot.state
        if (!current.enabled) return neutral('disabled')
        if (!current.entries.length) return { ...neutral('degraded'), status: 'ready' }
        const project = await identity(call)
        const relevant = ranked(current.entries.filter(item => item.identity.root === project.root
          && (!call.contextOnly || call.query?.trim() || item.document.overview)), call.query ?? '')
        const fresh: Entry[] = []
        const staleEntries: QueryResult['staleEntries'] = []
        const markStale = (item: Entry) => staleEntries.push({ id: item.id, version: item.version, path: item.sources[0]!.path })
        let stale = 0
        // Bound work before file IO; query again with a narrower topic for unexamined records.
        for (const item of relevant.slice(0, 12)) {
          if (!sameIdentity(item.identity, project)) { stale++; markStale(item); continue }
          try {
            for (const source of item.sources) {
              if ((await readSource(project.root, source.path, call.signal)).sha256 !== source.sha256) fail('SOURCE_CHANGED')
            }
            fresh.push(item)
          } catch { call.signal?.throwIfAborted(); stale++; markStale(item) }
        }
        if (!sameIdentity(await identity(call), project)) return neutral('degraded')
        const latest = observed()
        if (!latest.state.enabled) return neutral('disabled')
        if (latest.revision !== snapshot.revision) return neutral('degraded')
        if (!relevant.length) return { ...neutral('degraded'), status: 'ready' }
        return { ...render(fresh, stale, Math.max(0, relevant.length - 12), call.maxChars), staleEntries }
      } catch { return neutral('degraded') }
    },
  }
}
export type KnowledgeService = ReturnType<typeof createKnowledgeService>
