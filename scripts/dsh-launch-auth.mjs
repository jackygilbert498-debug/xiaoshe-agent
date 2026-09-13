/** Login handoff for a Host whose PID, roots and runtime identity the launcher already verified.
 * The official process token is read only from that launcher's log, never from an HTTP mint endpoint.
 */
import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const WINDOW_BYTES = 1024 * 1024
const failure = message => new Error('小蛇登录：' + message)
function loginCandidate(text, base) {
  const candidates = [...text.matchAll(/^dsh web: (\S+)/gmu)].map(row => row[1]).reverse()
  for (const value of candidates) {
    try {
      const url = new URL(value), token = url.searchParams.get('token')
      if (url.origin !== base.origin || url.pathname !== '/' || url.hash || url.username || url.password
        || [...url.searchParams.keys()].join(',') !== 'token' || !/^[\w-]{43}$/u.test(token ?? '')
        || Buffer.from(token, 'base64url').toString('base64url') !== token) continue
      url.search = ''
      url.searchParams.set('token', token)
      return url.href
    } catch { /* Ignore unrelated log text; never dispatch it. */ }
  }
  throw failure('日志中尚无当前地址的有效登录链接')
}
async function readLog(logPath) {
  const before = await lstat(logPath)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || (process.platform !== 'win32' && (before.uid !== process.getuid() || (before.mode & 0o077) !== 0))) {
    throw failure('日志必须是当前用户的私有普通文件')
  }
  const handle = await open(logPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw failure('日志已更换')
    const head = Buffer.alloc(Math.min(opened.size, WINDOW_BYTES))
    const first = await handle.read(head, 0, head.length, 0)
    let text = head.subarray(0, first.bytesRead).toString('utf8')
    if (opened.size > WINDOW_BYTES) {
      const tail = Buffer.alloc(Math.min(WINDOW_BYTES, opened.size - WINDOW_BYTES))
      const last = await handle.read(tail, 0, tail.length, opened.size - tail.length)
      text += '\n' + tail.subarray(0, last.bytesRead).toString('utf8')
    }
    const current = await lstat(logPath)
    if (current.dev !== opened.dev || current.ino !== opened.ino || current.isSymbolicLink() || current.nlink !== 1) throw failure('日志已更换')
    return text
  } finally { await handle.close() }
}

/** Bounded read and official token exchange. The returned URL is sensitive: memory/child env only. */
export async function readDshLaunchUrl({ logPath, baseUrl, expectedRuntimeIdentity, fetcher = fetch }) {
  const base = new URL(baseUrl)
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.pathname !== '/' || base.username || base.password || base.search || base.hash) throw failure('只允许已验证的本机地址')
  if (!isAbsolute(logPath)) throw failure('日志路径必须是绝对路径')
  if (!/^[a-f0-9]{64}$/u.test(expectedRuntimeIdentity ?? '')) throw failure('缺少已验证的运行身份')
  const url = loginCandidate(await readLog(logPath), base)
  // Confirm that neither a reused log nor a listener replacement can transfer login authority.
  try {
    const response = await fetcher(new URL('xiaoshe/desktop/status', base), { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const status = await response.json()
    if (!response.ok || status?.product !== '小蛇' || status?.runtime_identity !== expectedRuntimeIdentity || status?.bridge?.state !== 'ready') {
      throw failure('服务运行身份不匹配')
    }
    const login = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const cookies = login.headers.getSetCookie()
    if (login.status !== 303 || login.headers.get('location') !== '/'
      || !cookies.some(cookie => /^dsh-auth-[\w-]+=[^;\s]+;/u.test(cookie))) throw failure('官方登录验证失败')
    await login.body?.cancel()
    return url
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('小蛇登录：')) throw error
    // Fetch/OS messages can include the token-bearing URL. Do not retain their cause.
    throw failure('无法完成本机认证交换；请检查当前服务')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Map()
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
  try {
    let result, last
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        result = await readDshLaunchUrl({ logPath: args.get('--log'), baseUrl: args.get('--base'), expectedRuntimeIdentity: args.get('--identity') })
        break
      } catch (error) { last = error; if (attempt < 11) await delay(250) }
    }
    if (!result) throw last
    process.stdout.write(result)
  } catch (error) {
    process.stderr.write((error instanceof Error && error.message.startsWith('小蛇登录：') ? error.message : '小蛇登录：启动参数无效') + '\n')
    process.exitCode = 1
  }
}
