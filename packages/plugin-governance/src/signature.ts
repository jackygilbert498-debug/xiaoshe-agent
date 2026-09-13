import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

export interface PluginSignatureFacts { readonly packageName: string; readonly version: string; readonly tarballSha256: string }
export interface PluginSignatureEnvelope extends PluginSignatureFacts {
  readonly schemaVersion: 1
  readonly algorithm: 'Ed25519'
  readonly publicKey: string
  readonly signature: string
}
export interface TrustedPluginKey { readonly fingerprint: string; readonly publicKey: string; readonly label?: string }
export type PluginSignatureStatus = 'unsigned' | 'invalid' | 'valid-untrusted' | 'trusted'
export interface PluginSignatureVerification {
  readonly status: PluginSignatureStatus
  readonly fingerprint?: string
  readonly publisher?: string
  readonly reason: string
}

/** Canonical signed bytes. A detached envelope avoids self-referential tarball hashes. */
export function pluginSignaturePayload(facts: PluginSignatureFacts): Uint8Array {
  assertFacts(facts)
  return Buffer.from(`xiaoshe-plugin-signature-v1\n${facts.packageName}\n${facts.version}\n${facts.tarballSha256}\n`, 'utf8')
}

/** Fingerprint one exact DER SPKI public key, never a user-supplied key id. */
export function pluginKeyFingerprint(publicKey: string): string {
  const bytes = strictBase64(publicKey, 'public key', 16 * 1024)
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('plugin signing key must be Ed25519')
  const canonical = key.export({ format: 'der', type: 'spki' })
  return createHash('sha256').update(canonical).digest('hex')
}

/** Verify identity+version+full tarball digest, then separately evaluate local trust. */
export function verifyDetachedPluginSignature(input: PluginSignatureFacts & { readonly envelope?: unknown; readonly trustedKeys: readonly TrustedPluginKey[] }): PluginSignatureVerification {
  if (input.envelope === undefined) return Object.freeze({ status: 'unsigned', reason: '未提供分离式 Ed25519 签名。' })
  try {
    const envelope = parseEnvelope(input.envelope)
    if (envelope.packageName !== input.packageName || envelope.version !== input.version || envelope.tarballSha256 !== input.tarballSha256) {
      return Object.freeze({ status: 'invalid', reason: '签名绑定的包标识、版本或安装包摘要与候选不一致。' })
    }
    const publicBytes = strictBase64(envelope.publicKey, 'public key', 16 * 1024)
    const signature = strictBase64(envelope.signature, 'signature', 1_024)
    const key = createPublicKey({ key: publicBytes, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') return Object.freeze({ status: 'invalid', reason: '签名公钥不是 Ed25519。' })
    if (!verify(null, pluginSignaturePayload(input), key, signature)) return Object.freeze({ status: 'invalid', reason: 'Ed25519 签名校验失败。' })
    const fingerprint = pluginKeyFingerprint(envelope.publicKey)
    const trusted = input.trustedKeys.find(row => row.fingerprint === fingerprint && safeKeyEqual(row.publicKey, envelope.publicKey))
    return trusted === undefined
      ? Object.freeze({ status: 'valid-untrusted', fingerprint, reason: '签名有效，但发布者公钥尚未加入本机信任库。' })
      : Object.freeze({ status: 'trusted', fingerprint, ...(trusted.label === undefined ? {} : { publisher: trusted.label }), reason: '签名有效，且发布者公钥已在本机信任库中。' })
  } catch (error) {
    return Object.freeze({ status: 'invalid', reason: `签名信封无效：${safeMessage(error)}` })
  }
}

/** Read a bounded local sidecar. Network sources never get implicit trust. */
export async function readPluginSignatureEnvelope(path: string | undefined): Promise<PluginSignatureEnvelope | undefined> {
  if (path === undefined) return undefined
  if (!isAbsolute(path)) throw new TypeError('plugin signature path must be absolute')
  const exact = await realpath(resolve(path))
  const info = await lstat(exact)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new TypeError('plugin signature must be a bounded regular file')
  return parseEnvelope(JSON.parse(await readFile(exact, 'utf8')))
}

/** Load the profile-local trust store. Missing means empty; malformed fails loud. */
export async function readTrustedPluginKeys(path: string): Promise<readonly TrustedPluginKey[]> {
  if (!isAbsolute(path)) throw new TypeError('plugin trust store path must be absolute')
  let bytes: Buffer
  try { bytes = await readFile(path) } catch (error) {
    if (isMissing(error)) return Object.freeze([])
    throw error
  }
  if (bytes.byteLength > 256 * 1024) throw new RangeError('plugin trust store is too large')
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.keys) || value.keys.length > 200) throw new TypeError('plugin trust store has an unsupported schema')
  const seen = new Set<string>()
  const keys = value.keys.map((row, index): TrustedPluginKey => {
    if (!isRecord(row) || typeof row.publicKey !== 'string') throw new TypeError(`trusted key ${index} is invalid`)
    const fingerprint = pluginKeyFingerprint(row.publicKey)
    if (row.fingerprint !== undefined && row.fingerprint !== fingerprint) throw new TypeError(`trusted key ${index} fingerprint does not match its public key`)
    if (seen.has(fingerprint)) throw new TypeError(`duplicate trusted plugin key ${fingerprint}`)
    seen.add(fingerprint)
    return Object.freeze({ fingerprint, publicKey: row.publicKey, ...(typeof row.label === 'string' && row.label.trim() !== '' ? { label: row.label.trim().slice(0, 160) } : {}) })
  })
  return Object.freeze(keys)
}

function parseEnvelope(value: unknown): PluginSignatureEnvelope {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.algorithm !== 'Ed25519'
    || typeof value.publicKey !== 'string' || typeof value.signature !== 'string'
    || typeof value.packageName !== 'string' || typeof value.version !== 'string' || typeof value.tarballSha256 !== 'string') {
    throw new TypeError('unsupported plugin signature envelope')
  }
  assertFacts(value as unknown as PluginSignatureFacts)
  strictBase64(value.publicKey, 'public key', 16 * 1024)
  strictBase64(value.signature, 'signature', 1_024)
  return Object.freeze({
    schemaVersion: 1, algorithm: 'Ed25519', publicKey: value.publicKey, signature: value.signature,
    packageName: value.packageName, version: value.version, tarballSha256: value.tarballSha256,
  })
}
function assertFacts(value: PluginSignatureFacts): void {
  if (value.packageName === '' || value.packageName.length > 214 || /[\s\0]/u.test(value.packageName)) throw new TypeError('signed packageName is invalid')
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u.test(value.version)) throw new TypeError('signed version is invalid')
  if (!/^[a-f0-9]{64}$/u.test(value.tarballSha256)) throw new TypeError('signed tarballSha256 is invalid')
}
function strictBase64(value: string, label: string, maxBytes: number): Buffer {
  if (value === '' || value.length > maxBytes * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new TypeError(`${label} is not canonical base64`)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes || bytes.toString('base64') !== value) throw new TypeError(`${label} is not canonical base64`)
  return bytes
}
function safeKeyEqual(left: string, right: string): boolean {
  try { return pluginKeyFingerprint(left) === pluginKeyFingerprint(right) } catch { return false }
}
function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT' }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 300) }
