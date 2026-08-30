import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

interface JournalDocument { readonly schemaVersion: 1; readonly bundleHash: string; readonly completed: readonly string[]; readonly updatedAt: number }

/** Atomic idempotence journal for one import transaction. */
export class MigrationJournal {
  #document: JournalDocument | undefined
  constructor(private readonly path: string) { if (!isAbsolute(path)) throw new TypeError('migration journal path must be absolute') }
  open(bundleHash: string): ReadonlySet<string> {
    if (this.#document === undefined && existsSync(this.path)) {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.bundleHash !== 'string' || !Array.isArray(parsed.completed)) throw new Error('migration journal is unreadable')
      this.#document = { schemaVersion: 1, bundleHash: parsed.bundleHash, completed: parsed.completed.filter((row): row is string => typeof row === 'string'), updatedAt: Number(parsed.updatedAt) || 0 }
    }
    if (this.#document !== undefined && this.#document.bundleHash !== bundleHash) throw new Error('migration journal belongs to another bundle')
    this.#document ??= { schemaVersion: 1, bundleHash, completed: [], updatedAt: Date.now() }
    return new Set(this.#document.completed)
  }
  async mark(bundleHash: string, key: string): Promise<void> {
    const completed = this.open(bundleHash)
    if (completed.has(key)) return
    this.#document = { schemaVersion: 1, bundleHash, completed: [...completed, key].sort(), updatedAt: Date.now() }
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, `${JSON.stringify(this.#document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, this.path)
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
