import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_RECORD_BYTES = 16 * 1024
const STORE_NAME = '.xiaoshe-file-proofs'
const HEX = /^[a-f0-9]{64}$/u

export interface OutputIdentity {
  readonly path: string
  readonly workspace: string
  readonly dev: string
  readonly ino: string
  readonly birthtimeNs: string
  readonly mtimeNs: string
  readonly ctimeNs: string
  readonly size: number
  readonly contentSha256: string
}

export interface OutputObservation {
  readonly identity: OutputIdentity
  readonly content: string
  readonly targetKey: string
}

export interface WriteProofBinding {
  readonly sessionId: string
  readonly sessionCreatedAt: number
  readonly generation: number
  readonly callId: string
  readonly callSeq: number
  readonly resultSeq: number
  readonly argumentsSha256: string
  readonly contentSha256: string
  readonly shapeSha256: string
}

type IdentityStat = ReturnType<typeof identityStat>
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const inside = (root: string, target: string): boolean => {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function identityStat(path: string) { return lstatSync(path, { bigint: true }) }
function sameFile(a: IdentityStat, b: IdentityStat): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs
}
function owned(stat: IdentityStat): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())
}
function regular(stat: IdentityStat, limit: number, privateMode: boolean): boolean {
  return stat.isFile() && stat.nlink === 1n && owned(stat) && stat.size >= 0n
    && stat.size <= BigInt(limit)
    && (!privateMode || (stat.mode & 0o777n) === 0o600n)
}

/** Bounded FD read with no-follow and both descriptor/current-path identity checks. */
function readRegular(path: string, limit: number, privateMode = false): { bytes: Buffer; stat: IdentityStat } {
  const before = identityStat(path)
  if (!regular(before, limit, privateMode)) throw new Error('untrusted file identity')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!sameFile(before, fstatSync(fd, { bigint: true }))) throw new Error('file changed before read')
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    const after = identityStat(path)
    if (length !== Number(before.size) || !regular(after, limit, privateMode)
      || !sameFile(before, fstatSync(fd, { bigint: true })) || !sameFile(before, after)) {
      throw new Error('file changed during read')
    }
    return { bytes: bytes.subarray(0, length), stat: before }
  } finally { closeSync(fd) }
}

function assertOutputPath(path: string, workspace: string): void {
  if (!inside(workspace, path)) throw new Error('output is outside workspace')
  const segments = relative(workspace, path).split(/[\\/]/u)
  if (segments.length < 2 || segments[0]?.toLowerCase() !== 'output') throw new Error('not an output file')
  let current = workspace
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    const stat = identityStat(current)
    if (stat.isSymbolicLink() || (index < segments.length - 1 && !stat.isDirectory())) {
      throw new Error('linked output ancestor')
    }
  }
  if (realpathSync.native(path) !== path) throw new Error('noncanonical output')
}

/** Never manufactures an old identity: this only observes the file at this call boundary. */
export function observeOutputFile(target: string, cwd: string | undefined): OutputObservation | undefined {
  if (cwd === undefined) return undefined
  try {
    const workspace = realpathSync.native(resolve(cwd))
    const requested = resolve(target)
    const rel = relative(resolve(cwd), requested)
    if (rel.startsWith('..') || isAbsolute(rel)) return undefined
    const path = resolve(workspace, rel)
    assertOutputPath(path, workspace)
    const { bytes, stat } = readRegular(path, MAX_OUTPUT_BYTES)
    assertOutputPath(path, workspace)
    const content = bytes.toString('utf8')
    if (!Buffer.from(content).equals(bytes)) return undefined
    const identity: OutputIdentity = {
      path, workspace, dev: String(stat.dev), ino: String(stat.ino),
      birthtimeNs: String(stat.birthtimeNs), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
      size: bytes.length, contentSha256: sha(bytes),
    }
    return { identity, content, targetKey: outputTargetKey(identity) }
  } catch { return undefined }
}

export function outputTargetKey(identity: OutputIdentity): string {
  return JSON.stringify([identity.path, identity.dev, identity.ino, identity.birthtimeNs])
}

/** Observe one already-authorized data target, including files outside the
 * session cwd. No glob, traversal, symlink following, or recursive discovery.
 * The caller must bind this to an actual first-party tool invocation. */
export function observeDataFile(target: string): OutputObservation | undefined {
  try {
    const path = resolve(target)
    if (!isAbsolute(target) || realpathSync.native(path) !== path) return undefined
    let ancestor = path
    while (true) {
      if (identityStat(ancestor).isSymbolicLink()) return undefined
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
    const { bytes, stat } = readRegular(path, MAX_OUTPUT_BYTES)
    if (realpathSync.native(path) !== path) return undefined
    const content = bytes.toString('utf8')
    if (!Buffer.from(content).equals(bytes)) return undefined
    const identity: OutputIdentity = {
      path, workspace: dirname(path), dev: String(stat.dev), ino: String(stat.ino),
      birthtimeNs: String(stat.birthtimeNs), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
      size: bytes.length, contentSha256: sha(bytes),
    }
    return { identity, content, targetKey: outputTargetKey(identity) }
  } catch { return undefined }
}

export function sameOutputIdentity(a: OutputIdentity, b: OutputIdentity): boolean {
  return Object.keys(a).length === Object.keys(b).length
    && Object.entries(a).every(([key, value]) => b[key as keyof OutputIdentity] === value)
}

function directory(path: string, privateMode: boolean): IdentityStat {
  const stat = identityStat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)
    || (privateMode ? (stat.mode & 0o777n) !== 0o700n : (stat.mode & 0o022n) !== 0n)
    || realpathSync.native(path) !== path) throw new Error('untrusted proof directory')
  return stat
}

function directoryIdentity(stat: IdentityStat): string {
  return [stat.dev, stat.ino, stat.birthtimeNs].join(':')
}

function currentLogIdentity(path: string): string {
  const stat = identityStat(path)
  if (!stat.isFile() || stat.nlink !== 1n || !owned(stat) || (stat.mode & 0o022n) !== 0n
    || realpathSync.native(path) !== path) throw new Error('untrusted session log')
  // JSONL append changes size/timestamps, not its physical log identity.
  return JSON.stringify([dirname(path), path.split(/[\\/]/u).at(-1), String(stat.dev), String(stat.ino), String(stat.birthtimeNs)])
}

function durableNewFile(path: string, bytes: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  const directoryFd = openSync(dirname(path), constants.O_RDONLY)
  try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
}

function validBinding(binding: WriteProofBinding): boolean {
  return Object.keys(binding).length === 9
    && typeof binding.sessionId === 'string' && binding.sessionId.length > 0 && binding.sessionId.length <= 512
    && Number.isFinite(binding.sessionCreatedAt) && binding.sessionCreatedAt >= 0
    && Number.isSafeInteger(binding.generation) && binding.generation >= 0
    && typeof binding.callId === 'string' && binding.callId.length > 0 && binding.callId.length <= 512
    && Number.isSafeInteger(binding.callSeq) && binding.callSeq >= 0
    && Number.isSafeInteger(binding.resultSeq) && binding.resultSeq > binding.callSeq
    && [binding.argumentsSha256, binding.contentSha256, binding.shapeSha256].every(value => HEX.test(value))
}

/**
 * Private, per-session sealed facts. This is not a defence against a fully
 * compromised same-UID host: the host and its configured persistence locator
 * are trusted. No key or record is copied to Session events or model context.
 * Windows private ACL verification is not available here, so cold proofs stay
 * unavailable there instead of pretending POSIX mode bits provide protection.
 */
export class VerificationFileProofStore {
  private constructor(
    private readonly path: string,
    private readonly parentIdentity: string,
    private readonly storeIdentity: string,
    private readonly logPath: string,
    private readonly logIdentity: string,
    private readonly key: Buffer,
  ) {}

  static open(logPath: string, cwd: string, create: boolean): VerificationFileProofStore | undefined {
    if (process.platform === 'win32') return undefined
    try {
      if (!isAbsolute(logPath) || !/^session\.jsonl(?:\.zstd)?$/u.test(logPath.split(/[\\/]/u).at(-1) ?? '')) return undefined
      const parent = realpathSync.native(dirname(logPath))
      // The locator is host supplied; reject links at its final directory/log
      // and never put a signing key below a model's working directory.
      if (identityStat(dirname(logPath)).isSymbolicLink()) return undefined
      const workspace = realpathSync.native(resolve(cwd))
      if (inside(workspace, parent)) return undefined
      const parentStat = directory(parent, false)
      const canonicalLogPath = join(parent, logPath.split(/[\\/]/u).at(-1) as string)
      const logIdentity = currentLogIdentity(canonicalLogPath)
      const path = join(parent, STORE_NAME)
      let created = false
      try { directory(path, true) } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // Exclusive directory ownership is the only authority to create a
        // fresh key. A crash/parallel opener finding a keyless directory must
        // refuse it, never mint a replacement key over historical records.
        mkdirSync(path, { mode: 0o700 })
        created = true
      }
      const store = directory(path, true)
      const keyPath = join(path, 'key')
      if (created) durableNewFile(keyPath, randomBytes(32))
      const key = readRegular(keyPath, 32, true).bytes
      if (key.length !== 32) return undefined
      const result = new VerificationFileProofStore(path, directoryIdentity(parentStat), directoryIdentity(store),
        canonicalLogPath, logIdentity, key)
      result.assertCurrent()
      return result
    } catch { return undefined }
  }

  private assertCurrent(): void {
    if (directoryIdentity(directory(dirname(this.path), false)) !== this.parentIdentity
      || directoryIdentity(directory(this.path, true)) !== this.storeIdentity
      || currentLogIdentity(this.logPath) !== this.logIdentity) throw new Error('proof store replaced')
    const currentKey = readRegular(join(this.path, 'key'), 32, true).bytes
    if (currentKey.length !== this.key.length || !timingSafeEqual(currentKey, this.key)) throw new Error('proof key changed')
  }

  private recordPath(binding: WriteProofBinding): string {
    return join(this.path, `${sha(JSON.stringify([binding.sessionId, binding.sessionCreatedAt, binding.generation, binding.callId]))}.json`)
  }

  private payload(binding: WriteProofBinding, identity: OutputIdentity): string {
    return JSON.stringify({ version: 1, logIdentity: this.logIdentity, binding, identity })
  }

  save(binding: WriteProofBinding, identity: OutputIdentity): boolean {
    try {
      this.assertCurrent()
      if (!validBinding(binding) || identity.contentSha256 !== binding.contentSha256) return false
      const existing = this.load(binding)
      if (existing !== undefined) return sameOutputIdentity(existing, identity)
      const payload = this.payload(binding, identity)
      const bytes = Buffer.from(JSON.stringify({ payload, mac: createHmac('sha256', this.key).update(payload).digest('hex') }))
      if (bytes.length > MAX_RECORD_BYTES) return false
      durableNewFile(this.recordPath(binding), bytes)
      this.assertCurrent()
      return sameOutputIdentity(this.load(binding) as OutputIdentity, identity)
    } catch { return false }
  }

  load(binding: WriteProofBinding): OutputIdentity | undefined {
    try {
      this.assertCurrent()
      if (!validBinding(binding)) return undefined
      const bytes = readRegular(this.recordPath(binding), MAX_RECORD_BYTES, true).bytes
      const record = JSON.parse(bytes.toString('utf8')) as { payload?: unknown; mac?: unknown }
      if (Object.keys(record).length !== 2 || typeof record.payload !== 'string'
        || typeof record.mac !== 'string' || !HEX.test(record.mac)) return undefined
      const expected = createHmac('sha256', this.key).update(record.payload).digest()
      if (!timingSafeEqual(Buffer.from(record.mac, 'hex'), expected)) return undefined
      const parsed = JSON.parse(record.payload) as { identity: OutputIdentity }
      if (record.payload !== this.payload(binding, parsed.identity)) return undefined
      const value = parsed.identity
      if (value === null || typeof value !== 'object' || Object.keys(value).length !== 9
        || !isAbsolute(value.path) || !isAbsolute(value.workspace)
        || ![value.dev, value.ino, value.birthtimeNs, value.mtimeNs, value.ctimeNs].every(item => /^\d+$/u.test(item))
        || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_OUTPUT_BYTES
        || value.contentSha256 !== binding.contentSha256) return undefined
      this.assertCurrent()
      return value
    } catch { return undefined }
  }
}
