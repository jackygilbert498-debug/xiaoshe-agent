import { readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

interface JournalEntry { readonly pending: readonly string[]; readonly completed: readonly string[]; readonly updatedAt: number }
interface JournalDocument { readonly schemaVersion: 3; readonly bundles: Readonly<Record<string, JournalEntry>> }

/** Atomic, bundle-scoped intent journal for resumable import transactions. */
export class MigrationJournal {
  #document: JournalDocument | undefined
  #writeTail: Promise<void> = Promise.resolve()
  constructor(private readonly path: string) { if (!isAbsolute(path)) throw new TypeError('migration journal path must be absolute') }
  open(bundleHash: string): ReadonlySet<string> { return new Set(this.#load().bundles[bundleHash]?.completed ?? []) }
  pending(bundleHash: string): ReadonlySet<string> { return new Set(this.#load().bundles[bundleHash]?.pending ?? []) }
  async begin(bundleHash: string, key: string): Promise<void> {
    await this.#mutate(bundleHash, current => {
      if (current.completed.includes(key) || current.pending.includes(key)) return current
      return entry([...current.pending, key], current.completed, Date.now())
    })
  }
  async complete(bundleHash: string, key: string): Promise<void> {
    await this.#mutate(bundleHash, current => {
      if (current.completed.includes(key) && !current.pending.includes(key)) return current
      return entry(current.pending.filter(value => value !== key), [...current.completed, key], Date.now())
    })
  }
  async mark(bundleHash: string, key: string): Promise<void> { await this.complete(bundleHash, key) }
  #load(): JournalDocument {
    try {
      this.#document = parseDocument(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch (error) {
      // POSIX reports ENOTDIR when an ancestor is temporarily a file, while
      // Windows reports ENOENT for the same missing journal path. Preview may
      // treat both as absent; the later mkdir/lock step still fails before any
      // imported state is mutated.
      if (!isMissingPath(error)) throw error
      this.#document = emptyDocument()
    }
    return this.#document
  }

  /**
   * Serialize this object's callers, then rebase the mutation on the latest
   * on-disk document while holding the shared writer lock. The re-read belongs
   * inside the lock: otherwise two long-lived service instances can each
   * replace the other's newly written bundle with a stale snapshot.
   */
  async #mutate(bundleHash: string, transform: (current: JournalEntry) => JournalEntry): Promise<void> {
    const operation = this.#writeTail.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await withFileLock(this.path, async () => {
        const document = await loadDocument(this.path)
        const current = document.bundles[bundleHash] ?? entry([], [], 0)
        const value = transform(current)
        if (value === current) {
          this.#document = document
          return
        }
        const next: JournalDocument = {
          schemaVersion: 3,
          bundles: { ...document.bundles, [bundleHash]: value },
        }
        await writeFileAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600,
          dirMode: 0o700,
        })
        this.#document = next
      })
    })
    this.#writeTail = operation.then(() => undefined, () => undefined)
    await operation
  }
}

function emptyDocument(): JournalDocument { return { schemaVersion: 3, bundles: {} } }

async function loadDocument(path: string): Promise<JournalDocument> {
  try {
    return parseDocument(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (isMissingPath(error)) return emptyDocument()
    throw error
  }
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function parseDocument(value: unknown): JournalDocument {
  if (!isRecord(value)) throw new Error('migration journal is unreadable')
  if (value.schemaVersion === 1 && typeof value.bundleHash === 'string' && Array.isArray(value.completed)) {
    return { schemaVersion: 3, bundles: { [value.bundleHash]: entry([], value.completed, value.updatedAt) } }
  }
  if ((value.schemaVersion !== 2 && value.schemaVersion !== 3) || !isRecord(value.bundles)) throw new Error('migration journal is unreadable')
  const bundles: Record<string, JournalEntry> = {}
  for (const [hash, candidate] of Object.entries(value.bundles)) {
    if (hash.length === 0 || !isRecord(candidate) || !Array.isArray(candidate.completed)) throw new Error('migration journal is unreadable')
    const pending = value.schemaVersion === 3 && Array.isArray(candidate.pending) ? candidate.pending : []
    bundles[hash] = entry(pending, candidate.completed, candidate.updatedAt)
  }
  return { schemaVersion: 3, bundles }
}

function entry(pending: readonly unknown[], completed: readonly unknown[], updatedAt: unknown): JournalEntry {
  const done = new Set(completed.filter((row): row is string => typeof row === 'string'))
  return {
    pending: [...new Set(pending.filter((row): row is string => typeof row === 'string' && !done.has(row)))].sort(),
    completed: [...done].sort(),
    updatedAt: Number(updatedAt) || 0,
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
