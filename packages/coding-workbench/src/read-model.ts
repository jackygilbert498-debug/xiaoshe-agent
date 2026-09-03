import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', '.pnpm-store', '.DS_Store'])
export interface TreeEntry { readonly path: string; readonly kind: 'file' | 'directory'; readonly size?: number }
export interface TreeResult { readonly entries: readonly TreeEntry[]; readonly truncated: boolean }
export interface TextFileResult { readonly text: string; readonly bytes: number; readonly truncated: boolean; readonly totalBytes: number }

/** Iterative bounded tree scan; it never follows symlinks. */
export async function scanWorkspaceTree(root: string, options: { readonly maxEntries?: number; readonly maxDepth?: number } = {}): Promise<TreeResult> {
  const maxEntries = bounded(options.maxEntries ?? 2_000, 1, 20_000, 'maxEntries')
  const maxDepth = bounded(options.maxDepth ?? 12, 1, 64, 'maxDepth')
  const output: TreeEntry[] = []; const queue = [{ path: root, depth: 0 }]; let truncated = false
  while (queue.length > 0) {
    const current = queue.shift()!
    const rows = (await readdir(current.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const row of rows) {
      if (DEFAULT_IGNORES.has(row.name)) continue
      if (output.length >= maxEntries) { truncated = true; queue.length = 0; break }
      const absolute = join(current.path, row.name); const path = relative(root, absolute).split(sep).join('/')
      if (row.isSymbolicLink()) continue
      if (row.isDirectory()) {
        output.push({ path, kind: 'directory' })
        if (current.depth + 1 < maxDepth) queue.push({ path: absolute, depth: current.depth + 1 }); else truncated = true
      } else if (row.isFile()) {
        const stat = await lstat(absolute); output.push({ path, kind: 'file', size: stat.size })
      }
    }
  }
  return Object.freeze({ entries: Object.freeze(output), truncated })
}

/** Read UTF-8-ish text without sending an unbounded file into memory or the browser. */
export async function readTextFile(path: string, options: { readonly maxBytes?: number } = {}): Promise<TextFileResult> {
  const maxBytes = bounded(options.maxBytes ?? 512 * 1024, 1, 4 * 1024 * 1024, 'maxBytes')
  const stat = await lstat(path)
  if (!stat.isFile()) throw new TypeError('read target must be a regular file')
  const handle = await import('node:fs/promises').then(module => module.open(path, 'r'))
  try {
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, Math.max(1, stat.size)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.includes(0)) throw new TypeError(`${basename(path)} appears to be binary`)
    const body = bytes.subarray(0, maxBytes)
    return Object.freeze({ text: body.toString('utf8'), bytes: body.byteLength, truncated: stat.size > maxBytes, totalBytes: stat.size })
  } finally { await handle.close() }
}
function bounded(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${label} is out of range`)
  return value
}
