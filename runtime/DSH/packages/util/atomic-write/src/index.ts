/**
 * Zero-dependency atomic file replacement and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, then renames it over the target, so readers
 * observe either the old or the new complete content and a replaced file ends
 * up with exactly the stated mode. `withFileLock` serializes cross-process
 * writers of one file through an atomically installed `<file>.lock` sibling, so a
 * read-modify-write cycle can never resurrect a state another writer just
 * replaced; readers stay lock-free because the rename commit is atomic.
 * @module @deepseek-ai/dsh-atomic-write
 */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const WINDOWS_TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20
const WINDOWS_RENAME_RETRY_MAX_MS = 200
const WINDOWS_RENAME_RETRY_LIMIT = 8

/** Whether Windows reported temporary interference with an atomic replacement. */
function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  return WINDOWS_TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** Replace the target after bounded retries for transient Windows interference. */
async function renameAtomicTemp(temp: string, filename: string): Promise<void> {
  let delay = WINDOWS_RENAME_RETRY_INITIAL_MS
  for (let retries = 0;; retries += 1) {
    try {
      await rename(temp, filename)
      return
    } catch (error) {
      if (!isTransientWindowsRenameError(error)) throw error
      if (retries >= WINDOWS_RENAME_RETRY_LIMIT) throw error
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, WINDOWS_RENAME_RETRY_MAX_MS)
  }
}

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. Windows replacement retries transient `EACCES`, `EBUSY`,
 * and `EPERM` failures for a bounded interval while the complete temp file
 * remains the rename source. On any remaining failure the temp file is
 * removed and the failure rethrown. Crash durability (fsync) is out of scope.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): Use a replacement that fsyncs the file
  // and parent directory and preserves owner-only permissions on Windows.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await renameAtomicTemp(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Whether an atomic lock-directory install found an existing lock. */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return true
  if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTDIR' && code !== 'EISDIR') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    // Keep the original EPERM authoritative when lock existence is unproven.
    return false
  }
}

/**
 * Retry cadence for a contended lock. These stay robustness invariants of the
 * cross-process write protocol rather than deployment tunables: they govern how
 * often a contender asks, which no caller has a reason to vary.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200

/**
 * How long a contender waits when the caller states no limit — sized for the
 * render-and-rename cycle every call site had when this package was written.
 * Expiry fails the contender rather than guessing whether the existing lock
 * still has an owner. How long is *worth* waiting is a property of the
 * operation the lock holder runs, which is why {@link FileLockOptions.waitMs}
 * exists; the value here is the floor for an operation that does file work
 * alone.
 */
const DEFAULT_LOCK_WAIT_MS = 2_000

/** Options for one {@link withFileLock} acquisition. */
export interface FileLockOptions {
  /**
   * Maximum time to wait for the lock, in milliseconds. State one when the
   * holder's operation legitimately runs longer than file work — a credential
   * mutation that refreshes a token performs a network round trip while
   * holding the lock, and leaving the default in place would fail every other
   * writer of the same file for the duration. Waiting is productive: a
   * contender that acquires the lock afterwards re-reads the committed state.
   */
  waitMs?: number
}

const LOCK_RECORD_SCHEMA = 'dsh-file-lock/v1'
const LOCK_OWNER_SUFFIX = '.owner'

interface LockOwner {
  readonly token: string
  readonly filename: string
}

interface LockRecord {
  readonly schema: typeof LOCK_RECORD_SCHEMA
  readonly pid: number
  readonly token: string
}

/** Install a complete, non-empty lock directory in one rename operation. */
async function tryAcquireLock(lockPath: string): Promise<LockOwner | undefined> {
  const token = randomBytes(32).toString('hex')
  const filename = `${token}${LOCK_OWNER_SUFFIX}`
  const candidatePath = `${lockPath}.${token}.candidate`
  let installed = false
  try {
    await mkdir(candidatePath, { mode: 0o700 })
    const record: LockRecord = { schema: LOCK_RECORD_SCHEMA, pid: process.pid, token }
    await writeFile(join(candidatePath, filename), `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' })
    try {
      await rename(candidatePath, lockPath)
      installed = true
      return { token, filename }
    } catch (error) {
      if (!await isLockContention(error, lockPath)) throw error
      return undefined
    }
  } finally {
    if (!installed) await rm(candidatePath, { recursive: true, force: true })
  }
}

/** Treat only an OS-confirmed missing PID as dead; permission errors stay live. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== 'ESRCH'
  }
}

function parseLockRecord(text: string, expectedToken: string): LockRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockRecord> | null
    if (value?.schema !== LOCK_RECORD_SCHEMA || value.token !== expectedToken || !Number.isSafeInteger(value.pid)) {
      return undefined
    }
    return value as LockRecord
  } catch {
    return undefined
  }
}

/**
 * Remove an orphan only through its exact random owner marker. A concurrent
 * replacement has another marker name, so an old contender cannot empty it.
 */
async function tryRecoverOrphan(lockPath: string): Promise<boolean> {
  let entries: string[]
  try {
    if (!(await lstat(lockPath)).isDirectory()) return false
    entries = await readdir(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return true
    throw error
  }

  // Candidate-first acquisition never exposes an empty live lock directory.
  if (entries.length === 0) {
    try {
      await rmdir(lockPath)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') return true
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return false
      throw error
    }
  }
  if (entries.length !== 1) return false
  const filename = entries[0]!
  const match = /^([a-f0-9]{64})\.owner$/u.exec(filename)
  if (!match) return false
  const token = match[1]!
  const ownerPath = join(lockPath, filename)
  let record: LockRecord | undefined
  try {
    record = parseLockRecord(await readFile(ownerPath, 'utf8'), token)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return true
    throw error
  }
  if (!record || isProcessAlive(record.pid)) return false

  try {
    await unlink(ownerPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
  try {
    await rmdir(lockPath)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') return true
    // A replacement or unexpected entry appeared; never remove it recursively.
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false
    throw error
  }
}

/** Release only the marker bearing this owner's unguessable token. */
async function releaseLock(lockPath: string, owner: LockOwner): Promise<void> {
  const ownerPath = join(lockPath, owner.filename)
  try {
    const record = parseLockRecord(await readFile(ownerPath, 'utf8'), owner.token)
    if (!record || record.pid !== process.pid) return
    await unlink(ownerPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw error
  }
  try {
    await rmdir(lockPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
  }
}

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is an atomically installed sibling directory (`<filename>.lock`)
 * containing one random-token owner record. Paired with the rename-based
 * commit of {@link writeFileAtomic}, readers stay lock-free and only writers
 * contend. Contention backs off exponentially and fails after the deadline. A
 * contender recovers only a well-formed lock whose PID the OS confirms has
 * exited. Token-specific deletion cannot remove a live replacement, and a
 * malformed lock fails bounded rather than being guessed at. The parent
 * directory must exist.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @param options - acquisition options; omitted waits {@link DEFAULT_LOCK_WAIT_MS}.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS)
  let delay = LOCK_RETRY_INITIAL_MS
  let owner: LockOwner | undefined
  for (;;) {
    owner = await tryAcquireLock(lockPath)
    if (owner) break
    await tryRecoverOrphan(lockPath)
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await releaseLock(lockPath, owner)
  }
}
