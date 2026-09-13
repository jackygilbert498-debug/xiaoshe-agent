import { randomUUID } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Narrow IO seam for failure tests; production always uses the local filesystem. */
export interface AtomicFileIo {
  readonly writeFile: typeof writeFile
  readonly rename: typeof rename
  readonly unlink: typeof unlink
}
export const localAtomicFileIo: AtomicFileIo = { writeFile, rename, unlink }

/** Atomic visibility, not a cross-file transaction or a power-loss guarantee. */
export async function atomicFileReplace(path: string, bytes: Uint8Array, options: {
  readonly io?: AtomicFileIo
  readonly mode?: number
  readonly beforeRename?: () => Promise<void>
} = {}): Promise<void> {
  const io = options.io ?? localAtomicFileIo
  const temp = join(dirname(path), `.${randomUUID()}.xiaoshe.tmp`)
  let owned = true
  try {
    // wx owns this exact random path. Cleanup never scans or removes other files.
    try { await io.writeFile(temp, bytes, { flag: 'wx', mode: options.mode ?? 0o600 }) }
    catch (error) {
      // A partial write belongs to us; EEXIST is the exception.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') owned = false
      throw error
    }
    await options.beforeRename?.()
    await io.rename(temp, path)
  } finally {
    if (owned) await io.unlink(temp).catch(() => undefined)
  }
}
