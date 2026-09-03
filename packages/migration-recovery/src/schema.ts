import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { normalizeBundlePath } from './path-map.js'

export interface MigrationFileEntry { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface MigrationManifest {
  readonly schemaVersion: 1
  readonly product: 'xiaoshe'
  readonly exportedAt: number
  readonly source?: { readonly platform?: string; readonly productVersion?: string; readonly dshVersion?: string }
  readonly files: readonly MigrationFileEntry[]
}
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_FILES = 20_000
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

/** Stable JSON used for hashing and identical-resource comparison. */
export function canonicalJson(value: unknown): string { return JSON.stringify(sortJson(value)) }
export function sha256Bytes(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }

/** Re-read every declared file and fail closed on traversal, symlinks or hash drift. */
export async function verifyMigrationDirectory(root: string): Promise<MigrationManifest> {
  if (!isAbsolute(root)) throw new TypeError('migration directory must be absolute')
  const canonicalRoot = await realpath(root)
  const manifestBytes = await readFile(resolve(canonicalRoot, 'manifest.json'))
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new RangeError('migration manifest is too large')
  const manifest = parseManifest(JSON.parse(manifestBytes.toString('utf8')))
  let total = 0
  for (const entry of manifest.files) {
    const target = resolve(canonicalRoot, ...entry.path.split('/'))
    if (!contained(canonicalRoot, target)) throw new TypeError('unsafe bundle path')
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) throw new TypeError(`migration file is not a regular file: ${entry.path}`)
    const canonicalTarget = await realpath(target)
    if (!contained(canonicalRoot, canonicalTarget)) throw new TypeError(`migration file escapes bundle: ${entry.path}`)
    const bytes = await readFile(canonicalTarget)
    if (bytes.byteLength !== entry.bytes || sha256Bytes(bytes) !== entry.sha256) throw new Error(`migration hash mismatch: ${entry.path}`)
    total += bytes.byteLength
    if (total > MAX_TOTAL_BYTES) throw new RangeError('migration bundle exceeds total size limit')
  }
  return manifest
}

export function parseManifest(value: unknown): MigrationManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.product !== 'xiaoshe' || !nonNegative(value.exportedAt) || !Array.isArray(value.files)) throw new TypeError('unsupported migration schema')
  if (value.files.length > MAX_FILES) throw new RangeError('migration manifest has too many files')
  const seen = new Set<string>()
  const files = value.files.map((item): MigrationFileEntry => {
    if (!isRecord(item)) throw new TypeError('invalid migration file entry')
    const path = normalizeBundlePath(String(item.path ?? ''))
    if (path === 'manifest.json' || seen.has(path)) throw new TypeError('duplicate or reserved migration path')
    seen.add(path)
    if (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0 || Number(item.bytes) > MAX_FILE_BYTES || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new TypeError('invalid migration file metadata')
    return Object.freeze({ path, bytes: Number(item.bytes), sha256: item.sha256 })
  })
  const source = isRecord(value.source) ? parseSource(value.source) : undefined
  return Object.freeze({ schemaVersion: 1, product: 'xiaoshe', exportedAt: Number(value.exportedAt), files: Object.freeze(files), ...(source === undefined ? {} : { source }) })
}

function parseSource(value: Record<string, unknown>): NonNullable<MigrationManifest['source']> {
  const text = (input: unknown): string | undefined => typeof input === 'string' && input.trim() !== '' ? input.trim().slice(0, 200) : undefined
  const platform = text(value.platform)
  const productVersion = text(value.productVersion)
  const dshVersion = text(value.dshVersion)
  return Object.freeze({ ...(platform === undefined ? {} : { platform }), ...(productVersion === undefined ? {} : { productVersion }), ...(dshVersion === undefined ? {} : { dshVersion }) })
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('JSON value contains a non-finite number'); return value }
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isRecord(value)) throw new TypeError('JSON value contains an unsupported type')
  return Object.fromEntries(Object.keys(value).sort().flatMap(key => value[key] === undefined ? [] : [[key, sortJson(value[key])]]))
}
function contained(root: string, target: string): boolean { const rel = relative(root, target); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) }
function nonNegative(value: unknown): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
