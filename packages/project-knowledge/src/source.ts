import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fail, type Call, type Identity, type Source } from './types.js'

const exec = promisify(execFile)
const MAX_BYTES = 262_144
const SECRET = /^(?:\.git|\.hg|\.svn|node_modules|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.boto|\.?credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx|keystore)$/iu

/** Reject absolute/drive-relative paths on either OS and normalize a single workspace-relative path. */
export function sourcePath(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 400 || /[\x00-\x1f:]/u.test(input)
    || isAbsolute(input) || win32.isAbsolute(input)) return fail('INVALID_PATH')
  const parts = input.replaceAll('\\', '/').split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part) || SECRET.test(part))) return fail('UNSAFE_PATH')
  const normalized = parts.join('/')
  if (/(?:^|\/)(?:\.docker\/config\.json|\.codex\/auth\.json|\.config\/gcloud\/application_default_credentials\.json)$/iu.test(normalized)) return fail('UNSAFE_PATH')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

/** Bind projections to a canonical worktree AND branch/commit, never to a remote URL or credentials. */
export async function identity(call: Call): Promise<Identity> {
  call.signal?.throwIfAborted()
  if (typeof call.cwd !== 'string' || !isAbsolute(call.cwd)) return fail('PROJECT_REQUIRED')
  const canonical = await realpath(call.cwd)
  if (!(await stat(canonical)).isDirectory()) return fail('PROJECT_REQUIRED')
  let git: string
  const options = { cwd: canonical, windowsHide: true, timeout: 2000, maxBuffer: 4096,
    ...(call.signal ? { signal: call.signal } : {}) }
  try {
    const head = (await exec('git', ['rev-parse', '--verify', 'HEAD'], options)).stdout.trim()
    if (!/^[a-f0-9]{40,64}$/u.test(head)) return fail('IDENTITY_UNAVAILABLE')
    let branch = 'detached'
    try { branch = (await exec('git', ['symbolic-ref', '--quiet', 'HEAD'], options)).stdout.trim() }
    catch (error) { if ((error as { code?: unknown }).code !== 1) throw error }
    git = `${head}:${branch}`
  } catch (error) {
    call.signal?.throwIfAborted()
    // Only a confirmed non-repository may use local file identity. Missing git,
    // unsafe ownership, timeout and broken repositories must not look healthy.
    if ((error as { code?: unknown }).code === 128
      && /not a git repository/iu.test(String((error as { stderr?: unknown }).stderr))) git = 'non-git'
    else if ((error as { code?: unknown }).code === 128
      && /Needed a single revision/iu.test(String((error as { stderr?: unknown }).stderr))) {
      const branch = (await exec('git', ['symbolic-ref', '--quiet', 'HEAD'], options)).stdout.trim()
      git = `unborn:${branch}`
    } else return fail('IDENTITY_UNAVAILABLE')
  }
  call.signal?.throwIfAborted()
  return { root: process.platform === 'win32' ? canonical.toLowerCase() : canonical, git }
}

/** Read a bounded regular UTF-8 file, checking the path and handle again after IO.
 * This is a best-effort race guard, not an OS sandbox; execution permissions remain host-owned.
 */
export async function readSource(root: string, input: string, signal?: AbortSignal): Promise<Source & { text: string }> {
  signal?.throwIfAborted()
  const path = sourcePath(input)
  let current = root
  for (const part of path.split('/')) {
    current = resolve(current, part)
    if ((await lstat(current)).isSymbolicLink()) return fail('UNSAFE_PATH')
  }
  const resolved = await realpath(current)
  if (!contained(root, resolved)) return fail('UNSAFE_PATH')
  const handle = await open(resolved, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > MAX_BYTES || before.nlink > 1) return fail('SOURCE_LIMIT')
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      signal?.throwIfAborted()
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (read.bytesRead === 0) break
      bytes += read.bytesRead
    }
    const after = await handle.stat(), pathStat = await lstat(current)
    if (bytes > MAX_BYTES || before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || pathStat.isSymbolicLink() || pathStat.ino !== after.ino
      || pathStat.dev !== after.dev || (await realpath(current)) !== resolved) return fail('SOURCE_CHANGED')
    signal?.throwIfAborted()
    const raw = buffer.subarray(0, bytes)
    if (raw.includes(0)) return fail('BINARY_SOURCE')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw) }
    catch { return fail('BINARY_SOURCE') }
    return { path, sha256: createHash('sha256').update(raw).digest('hex'), text }
  } finally { await handle.close() }
}
