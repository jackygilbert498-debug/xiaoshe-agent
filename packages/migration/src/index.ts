import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface LegacyInspection {
  readonly schemaVersion: 1
  readonly sourceRoot: string
  readonly memory: { readonly present: boolean; readonly bytes?: number; readonly sha256?: string; readonly jsonKind?: 'array' | 'object' | 'other' | 'invalid' }
  readonly sessions: { readonly count: number; readonly totalBytes: number; readonly disposition: 'reference-only' }
  readonly settings: { readonly candidates: readonly { readonly relativePath: string; readonly bytes: number; readonly sha256: string }[] }
  readonly warnings: readonly string[]
}
export interface BackupManifest { readonly schemaVersion: 1; readonly createdAt: string; readonly files: readonly { readonly relativePath: string; readonly bytes: number; readonly sha256: string }[] }

/** Metadata-only inspection: legacy content and secret-bearing filenames never enter the report. */
export async function inspectLegacyRoot(sourceRoot: string): Promise<LegacyInspection> {
  const root = resolve(sourceRoot)
  const memoryPath = join(root, 'memory.json')
  const memory = await fileFact(memoryPath, true)
  const sessionDir = join(root, '.state', 'sessions')
  let sessionCount = 0; let sessionBytes = 0
  try {
    for (const entry of await readdir(sessionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const stat = await lstat(join(sessionDir, entry.name)); sessionCount += 1; sessionBytes += stat.size
    }
  } catch (error: unknown) { if (!isMissing(error)) throw error }
  const candidates = []
  for (const relativePath of ['config.json', 'settings.json', 'ui/settings.json']) {
    const fact = await fileFact(join(root, relativePath), false)
    if (fact.present && fact.bytes !== undefined && fact.sha256 !== undefined) candidates.push({ relativePath, bytes: fact.bytes, sha256: fact.sha256 })
  }
  return {
    schemaVersion: 1, sourceRoot: root,
    memory,
    sessions: { count: sessionCount, totalBytes: sessionBytes, disposition: 'reference-only' },
    settings: { candidates },
    warnings: [
      '旧会话属于旧运行时语义，只做只读参考；不得导入为第二本 DSH Session Log。',
      'memory.json 必须由用户预览来源与条目后再逐项导入；检查不会读取或输出正文。',
      '备份不包含 .env、mcp.json、SecretStore 或整个 .state。',
    ],
  }
}

/** Copy an explicit allow-list to a new backup directory and hash every exact byte. */
export async function backupFiles(sourceRoot: string, relativePaths: readonly string[], backupRoot: string): Promise<BackupManifest> {
  const source = resolve(sourceRoot); const backup = resolve(backupRoot)
  if (isWithin(source, backup)) throw new Error('backupRoot must be outside sourceRoot')
  const sourceReal = await realpath(source)
  await mkdir(backup, { recursive: false })
  const backupReal = await realpath(backup)
  const files = []
  for (const item of [...new Set(relativePaths)].sort()) {
    const normalized = safeRelative(item); const input = resolve(source, normalized)
    if (!isWithin(source, input)) throw new Error(`backup path escapes source root: ${item}`)
    const stat = await lstat(input)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`backup source must be a regular file: ${item}`)
    const inputReal = await realpath(input)
    if (!isWithin(sourceReal, inputReal)) throw new Error(`backup path crosses a linked directory outside source root: ${item}`)
    const bytes = await readFile(input); const output = resolve(backup, normalized)
    if (!isWithin(backup, output)) throw new Error(`backup path escapes backup root: ${item}`)
    await mkdir(dirname(output), { recursive: true })
    if (!isWithin(backupReal, await realpath(dirname(output)))) throw new Error(`backup output crosses a linked directory: ${item}`)
    await writeFile(output, bytes, { flag: 'wx' })
    files.push({ relativePath: normalized, bytes: bytes.length, sha256: sha256(bytes) })
  }
  const manifest: BackupManifest = { schemaVersion: 1, createdAt: new Date().toISOString(), files }
  await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' })
  return manifest
}

/** Verify all hashes before atomic per-file replacement in an explicit destination root. */
export async function restoreBackup(backupRoot: string, manifest: BackupManifest, destinationRoot: string): Promise<void> {
  if (manifest.schemaVersion !== 1) throw new Error('unsupported backup manifest')
  const backup = resolve(backupRoot); const destination = resolve(destinationRoot)
  const backupReal = await realpath(backup)
  await mkdir(destination, { recursive: true })
  const destinationReal = await realpath(destination)
  const verified: { bytes: Uint8Array; normalized: string; target: string }[] = []
  const staged: { temp: string; target: string }[] = []
  for (const item of manifest.files) {
    const normalized = safeRelative(item.relativePath); const input = resolve(backup, normalized); const target = resolve(destination, normalized)
    if (!isWithin(backup, input) || !isWithin(destination, target)) throw new Error(`restore path escapes root: ${normalized}`)
    const stat = await lstat(input); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`backup member must be a regular file: ${normalized}`)
    if (!isWithin(backupReal, await realpath(input))) throw new Error(`backup member crosses a linked directory: ${normalized}`)
    const bytes = await readFile(input)
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`backup hash mismatch: ${normalized}`)
    verified.push({ bytes, normalized, target })
  }
  try {
    for (const item of verified) {
      await mkdir(dirname(item.target), { recursive: true })
      if (!isWithin(destinationReal, await realpath(dirname(item.target)))) throw new Error(`restore target crosses a linked directory: ${item.normalized}`)
      const temp = `${item.target}.xiaoshe-restore-${process.pid}`
      await writeFile(temp, item.bytes, { flag: 'wx' }); staged.push({ temp, target: item.target })
    }
    for (const item of staged) await rename(item.temp, item.target)
  } catch (error: unknown) {
    await Promise.all(staged.map(item => rm(item.temp, { force: true })))
    throw error
  }
}

async function fileFact(path: string, parseJson: boolean): Promise<{ present: boolean; bytes?: number; sha256?: string; jsonKind?: 'array' | 'object' | 'other' | 'invalid' }> {
  try {
    const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) return { present: false }
    const bytes = await readFile(path)
    let jsonKind: 'array' | 'object' | 'other' | 'invalid' | undefined
    if (parseJson) try { const value: unknown = JSON.parse(bytes.toString('utf8')); jsonKind = Array.isArray(value) ? 'array' : typeof value === 'object' && value !== null ? 'object' : 'other' } catch { jsonKind = 'invalid' }
    return { present: true, bytes: bytes.length, sha256: sha256(bytes), ...(jsonKind === undefined ? {} : { jsonKind }) }
  } catch (error: unknown) { if (isMissing(error)) return { present: false }; throw error }
}
function safeRelative(value: string): string { if (value.trim() === '' || isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error(`unsafe relative path: ${value}`); return value.replaceAll('\\', '/') }
function isWithin(root: string, target: string): boolean { const rel = relative(root, target); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) }
function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT' }
