import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { auditCandidateManifest, candidateIdentityFromManifest, type CandidateAudit, type CandidateIdentity } from './audit.js'

export interface TarInspectionLimits {
  readonly maxCompressedBytes?: number
  readonly maxExpandedBytes?: number
  readonly maxEntries?: number
  readonly maxManifestBytes?: number
}

export interface TarManifestInspection {
  readonly packageName: string
  readonly version: string
  readonly manifestSha256: string
  readonly identity: CandidateIdentity
  readonly audit: CandidateAudit
  readonly healthPath?: string
}

const DEFAULTS = Object.freeze({
  maxCompressedBytes: 16 * 1024 * 1024,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxEntries: 2_048,
  maxManifestBytes: 256 * 1024,
})

/** Inspect only package/package.json without extracting attacker-controlled paths. */
export function inspectCandidateTarball(compressed: Uint8Array, limits: TarInspectionLimits = {}): TarManifestInspection {
  const bounded = { ...DEFAULTS, ...limits }
  if (compressed.byteLength > bounded.maxCompressedBytes) throw new RangeError('candidate compressed archive exceeds the byte limit')
  let archive: Buffer
  try {
    archive = compressed[0] === 0x1f && compressed[1] === 0x8b
      ? gunzipSync(compressed, { maxOutputLength: bounded.maxExpandedBytes })
      : Buffer.from(compressed)
  } catch (error) {
    throw new TypeError(`candidate gzip stream is invalid or expanded beyond its limit: ${safeMessage(error)}`)
  }
  if (archive.byteLength > bounded.maxExpandedBytes) throw new RangeError('candidate expanded archive exceeds the byte limit')

  let offset = 0
  let count = 0
  let nextPath: string | undefined
  let manifestBytes: Buffer | undefined
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    offset += 512
    if (header.every(byte => byte === 0)) break
    count += 1
    if (count > bounded.maxEntries) throw new RangeError('candidate tar entry count exceeds the limit')
    validateChecksum(header)
    const rawName = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const headerPath = prefix === '' ? rawName : `${prefix}/${rawName}`
    const size = readOctal(header, 124, 12, 'entry size')
    if (size > bounded.maxExpandedBytes || offset + size > archive.length) throw new TypeError('candidate tar entry is truncated or oversized')
    const body = archive.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    const type = String.fromCharCode(header[156] ?? 0)
    if (type === 'x' || type === 'g') {
      const pax = parsePax(body)
      if (type === 'x' && pax.path !== undefined) nextPath = pax.path
      continue
    }
    if (type === 'L') {
      nextPath = readNullTerminated(body)
      continue
    }
    const path = nextPath ?? headerPath
    nextPath = undefined
    assertSafeTarPath(path)
    if (path !== 'package/package.json') continue
    if (type !== '0' && type !== '\0') throw new TypeError('package manifest must be a regular tar entry')
    if (manifestBytes !== undefined) throw new TypeError('candidate tar must contain exactly one package manifest')
    if (body.byteLength > bounded.maxManifestBytes) throw new RangeError('candidate package manifest exceeds the byte limit')
    manifestBytes = Buffer.from(body)
  }
  if (manifestBytes === undefined) throw new TypeError('candidate tar must contain exactly one package manifest')
  let manifest: unknown
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) } catch { throw new TypeError('candidate package manifest must contain valid JSON') }
  const audit = auditCandidateManifest(manifest)
  if (!audit.valid || audit.packageName === undefined || audit.version === undefined) throw new TypeError('candidate package manifest needs a valid name and version')
  const healthPath = declaredHealthPath(manifest)
  return Object.freeze({
    packageName: audit.packageName,
    version: audit.version,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    identity: candidateIdentityFromManifest(manifest),
    audit,
    ...(healthPath === undefined ? {} : { healthPath }),
  })
}

function declaredHealthPath(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.dsh) || !isRecord(value.dsh.health)) return undefined
  const path = value.dsh.health.path
  if (path === undefined) return undefined
  if (typeof path !== 'string' || path.length > 200 || !/^\/api\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(path)
    || path.includes('..') || path.includes('//') || path.includes('?') || path.includes('#')) {
    throw new TypeError('candidate health path (dsh.health.path) must be a strict local /api/... path')
  }
  return path
}

function validateChecksum(header: Uint8Array): void {
  const recorded = readOctal(header, 148, 8, 'header checksum')
  let actual = 0
  for (let index = 0; index < 512; index += 1) actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0)
  if (recorded !== actual) throw new TypeError('candidate tar header checksum is invalid')
}

function parsePax(body: Uint8Array): Record<string, string> {
  const text = Buffer.from(body).toString('utf8')
  const result: Record<string, string> = {}
  let offset = 0
  while (offset < text.length) {
    const space = text.indexOf(' ', offset)
    if (space <= offset) throw new TypeError('candidate PAX record is malformed')
    const length = Number(text.slice(offset, space))
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > text.length) throw new TypeError('candidate PAX record length is invalid')
    const record = text.slice(space + 1, offset + length - 1)
    const equals = record.indexOf('=')
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return result
}

function assertSafeTarPath(path: string): void {
  if (path === '' || path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/u.test(path)) throw new TypeError('unsafe tar path')
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) throw new TypeError('unsafe tar path')
}

function readString(value: Uint8Array, offset: number, length: number): string {
  return readNullTerminated(value.subarray(offset, offset + length))
}
function readNullTerminated(value: Uint8Array): string {
  const end = value.indexOf(0)
  return Buffer.from(end < 0 ? value : value.subarray(0, end)).toString('utf8')
}
function readOctal(value: Uint8Array, offset: number, length: number, label: string): number {
  const text = readString(value, offset, length).trim()
  if (!/^[0-7]+$/u.test(text)) throw new TypeError(`candidate tar ${label} is invalid`)
  const result = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`candidate tar ${label} is out of range`)
  return result
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 300) }
