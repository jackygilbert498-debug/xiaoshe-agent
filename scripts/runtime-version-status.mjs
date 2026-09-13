import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { productRuntimeIdentity } from './product-runtime-identity.mjs'

const DIGEST = /^[a-f0-9]{64}$/u
export const CLIENT_INPUTS = ['src/client/index.ts', 'scripts/build-client.mjs', 'package.json',
  ...['tokens', 'base', 'components', 'panels', 'observatory'].map(name => `ui/styles/${name}.css`), 'src/client/adapted.css']
const digest = value => createHash('sha256').update(value).digest('hex')
const validIdentity = value => typeof value === 'string' && DIGEST.test(value) ? value : undefined

async function boundedFile(path, limit = 16 * 1024 * 1024) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('unsafe version input')
  return readFile(path)
}

/** Same ordered inputs used by the builder; excludes its generated output. */
export async function clientSourceIdentity(packageRoot) {
  const inputs = await Promise.all(CLIENT_INPUTS.map(async path => [path, digest(await boundedFile(join(packageRoot, path)))]))
  return digest(JSON.stringify(inputs))
}

export function loopbackVersionBase(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('version diagnostics require a plain loopback HTTP origin')
  return url.origin
}

async function readBackend(baseUrl, fetchImpl) {
  try {
    const response = await fetchImpl(`${loopbackVersionBase(baseUrl)}/xiaoshe/desktop/status`, {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return { state: 'unavailable' }
    // Do not relay another process's payload or diagnostics into a public report.
    const reader = response.body?.getReader()
    if (!reader) return { state: 'unknown' }
    const chunks = []; let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 64 * 1024) { await reader.cancel(); return { state: 'unknown' } }
        chunks.push(Buffer.from(value))
      }
    } finally { reader.releaseLock() }
    const body = Buffer.concat(chunks).toString('utf8')
    const value = JSON.parse(body)
    if (value?.product !== '小蛇' || value.api_version !== 1) return { state: 'unknown' }
    const identity = validIdentity(value.runtime_identity)
    return identity ? { state: 'observed', identity } : { state: 'unknown' }
  } catch { return { state: 'unavailable' } }
}

/** Read-only point-in-time evidence, not an update, release or signing claim. */
export async function inspectRuntimeVersion({ root, dshRoot, profileRoot, backendIdentity, baseUrl, loadedFrontendIdentity }, {
  identityReader = productRuntimeIdentity, fetchImpl = globalThis.fetch,
} = {}) {
  for (const path of [root, dshRoot, profileRoot]) if (!isAbsolute(path ?? '')) throw new Error('version diagnostic roots must be explicit absolute paths')
  if (baseUrl !== undefined) loopbackVersionBase(baseUrl)
  const reasons = []
  const candidate = { state: 'unavailable' }
  try { candidate.identity = validIdentity(await identityReader({ root, dshRoot, profileRoot })); candidate.state = candidate.identity ? 'observed' : 'unknown' }
  catch { reasons.push('candidate-unavailable') }
  const backend = baseUrl !== undefined ? await readBackend(baseUrl, fetchImpl)
    : validIdentity(backendIdentity) ? { state: 'observed', identity: backendIdentity } : { state: 'unknown' }
  if (backend.state === 'observed' && candidate.identity) backend.state = backend.identity === candidate.identity ? 'current' : 'stale'
  if (backend.state !== 'current') reasons.push(`backend-${backend.state === 'observed' ? 'unknown' : backend.state}`)
  const frontend = { state: 'unknown', loaded_state: 'unknown' }
  const packageRoot = join(root, 'packages/native-shell-legacy-adapted')
  try { frontend.source_identity = await clientSourceIdentity(packageRoot) } catch { reasons.push('frontend-source-unavailable') }
  try {
    const [artifact, manifestBytes] = await Promise.all([
      boundedFile(join(packageRoot, 'lib/client.js')),
      boundedFile(join(packageRoot, 'lib/client.version.json'), 8192),
    ])
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    if (manifest.schema !== 'xiaoshe-client-build/v1' || !validIdentity(manifest.source_identity) || !validIdentity(manifest.artifact_identity)) throw new Error('invalid client build record')
    frontend.build_identity = manifest.source_identity
    frontend.artifact_identity = digest(artifact)
    frontend.state = frontend.artifact_identity !== manifest.artifact_identity ? 'stale'
      : frontend.source_identity === undefined ? 'unknown' : frontend.source_identity === frontend.build_identity ? 'current' : 'stale'
  } catch { frontend.state = 'unavailable' }
  const loaded = validIdentity(loadedFrontendIdentity)
  if (loaded) {
    frontend.loaded_identity = loaded
    if (frontend.build_identity) frontend.loaded_state = loaded === frontend.build_identity ? 'current' : 'stale'
  }
  if (frontend.state !== 'current') reasons.push(`frontend-artifact-${frontend.state}`)
  if (frontend.loaded_state !== 'current') reasons.push(`frontend-loaded-${frontend.loaded_state}`)
  let source = 'unknown'; let version = 'unknown'
  try {
    const manifest = JSON.parse((await boundedFile(join(root, 'package.json'), 1024 * 1024)).toString('utf8'))
    if (typeof manifest.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/u.test(manifest.version)) version = manifest.version
    source = 'developer-source'
    try { const marker = await lstat(join(root, '.xiaoshe-product-runtime.json')); if (marker.isFile() && !marker.isSymbolicLink()) source = 'embedded-runtime' } catch {}
  } catch {}
  const states = [candidate.state === 'observed' ? 'current' : candidate.state, backend.state, frontend.state, frontend.loaded_state]
  const status = states.includes('stale') ? 'stale' : states.includes('unavailable') ? 'unavailable' : states.every(value => value === 'current') ? 'current' : 'unknown'
  return { schema: 'xiaoshe-runtime-version/v1', checked_at: new Date().toISOString(), source, version, status, candidate, backend, frontend, reasons }
}

async function main() {
  const options = new Map()
  const allowed = new Set(['--root', '--dsh-root', '--profile-root', '--backend-identity', '--base-url', '--frontend-identity'])
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]; const value = process.argv[i + 1]
    if (!allowed.has(key) || value === undefined || options.has(key)) throw new Error('invalid version diagnostic arguments')
    options.set(key, value)
  }
  const report = await inspectRuntimeVersion({ root: options.get('--root'), dshRoot: options.get('--dsh-root'), profileRoot: options.get('--profile-root'),
    backendIdentity: options.get('--backend-identity'), baseUrl: options.get('--base-url'), loadedFrontendIdentity: options.get('--frontend-identity') })
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

// Node canonicalizes the module URL, but argv can retain symlinked paths
// (including macOS /var -> /private/var). Compare canonical entry paths.
if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(resolve(process.argv[1])).catch(() => undefined)) {
  main().catch(() => { process.stderr.write('Version diagnostics unavailable; check explicit roots and loopback origin.\n'); process.exitCode = 1 })
}
