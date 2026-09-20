/** Private, loopback-only transport. No remote-debugging port is exposed. */
import { createServer, createConnection } from 'node:net'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const LIMIT = 1024 * 1024
export function browserOrigin(env = process.env) {
  const url = new URL(env.XIAOSHE_DESKTOP_URL || `http://127.0.0.1:${env.XIAOSHE_DSH_PORT || '3080'}`)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Invalid browser product origin')
  return `http://127.0.0.1:${url.port || '80'}`
}
export function descriptorPath(origin, root = process.env.XIAOSHE_BROWSER_BRIDGE_DIR || join(homedir(), '.xiaoshe', 'browser-bridge')) {
  const normalized = browserOrigin({ XIAOSHE_DESKTOP_URL: origin })
  return join(root, `${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}.json`)
}
export function browserFault(code, message) { return Object.assign(new Error(message), { code }) }

function readFrame(socket, onFrame) {
  let buffer = ''; let finished = false
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    if (finished) return
    buffer += chunk
    if (Buffer.byteLength(buffer) > LIMIT) { finished = true; socket.destroy(); return }
    const end = buffer.indexOf('\n')
    if (end < 0) return
    finished = true
    try { Promise.resolve(onFrame(JSON.parse(buffer.slice(0, end)))).catch(() => socket.destroy()) } catch { socket.destroy() }
  })
}
function secureToken(actual, expected) {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/u.test(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

export async function createBrowserEndpoint({ origin, root, dispatch }) {
  const path = descriptorPath(origin, root)
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const dir = await lstat(parent)
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Browser bridge directory must be a real directory')
  await chmod(parent, 0o700)
  const token = randomBytes(32).toString('hex')
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    const controller = new AbortController()
    socket.setTimeout(3_000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('close', () => { sockets.delete(socket); controller.abort() })
    readFrame(socket, async frame => {
      if (frame?.version !== 1 || !secureToken(frame.token, token) || typeof frame.id !== 'string' || frame.id.length > 128
        || typeof frame.ownerId !== 'string' || !frame.ownerId || frame.ownerId.length > 512
        || typeof frame.command !== 'string' || frame.command.length > 64) { socket.destroy(); return }
      socket.setTimeout(35_000)
      try {
        const value = await dispatch(frame.ownerId, frame.command, frame.args ?? {}, controller.signal)
        const reply = JSON.stringify({ version: 1, id: frame.id, ok: true, value })
        if (Buffer.byteLength(reply) > LIMIT) throw browserFault('BROWSER_OUTPUT_LIMIT', '浏览器返回内容过大，请缩小读取范围。')
        if (!socket.destroyed) socket.end(reply + '\n')
      } catch (error) {
        if (!socket.destroyed) socket.end(JSON.stringify({ version: 1, id: frame.id, ok: false,
          error: { code: typeof error?.code === 'string' ? error.code : 'BROWSER_FAILED', message: String(error?.message || 'Browser operation failed').slice(0, 1200) } }) + '\n')
      }
    })
  })
  server.maxConnections = 32
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const record = { version: 1, host: '127.0.0.1', port: address.port, token, pid: process.pid }
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path); await chmod(path, 0o600)
  } catch (error) { for (const socket of sockets) socket.destroy(); server.close(); await unlink(temporary).catch(() => {}); throw error }
  server.on('error', () => {})
  return {
    path,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      // Never remove a newer app instance's descriptor.
      const current = await readFile(path, 'utf8').then(JSON.parse).catch(() => null)
      if (current?.token === token) await unlink(path).catch(() => {})
    },
  }
}

export async function requestBrowser({ origin = browserOrigin(), root, ownerId, command, args = {}, signal, timeoutMs = 32_000 }) {
  if (signal?.aborted) throw browserFault('BROWSER_CANCELLED', '浏览器操作已取消。')
  let record
  try {
    const path = descriptorPath(origin, root)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2048 || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))) throw new Error('Unsafe descriptor')
    record = JSON.parse(await readFile(path, 'utf8'))
    if (record.version !== 1 || record.host !== '127.0.0.1' || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || !/^[a-f0-9]{64}$/u.test(record.token)) throw new Error('Invalid descriptor')
  } catch { throw browserFault('BROWSER_NOT_CONNECTED', '小蛇专用浏览器尚未连接。请打开小蛇桌面版；不要改用系统桌面操作网页。') }
  const id = randomBytes(12).toString('hex')
  const frame = JSON.stringify({ version: 1, id, token: record.token, ownerId, command, args }) + '\n'
  if (Buffer.byteLength(frame) > LIMIT) throw browserFault('BROWSER_INPUT_LIMIT', '浏览器输入过大。')
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: record.host, port: record.port })
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy()
      if (error) reject(error); else resolve(value)
    }
    const abort = () => finish(browserFault('BROWSER_CANCELLED', '浏览器操作已取消；已发出的网页操作不能回滚，请重新观察结果。'))
    const timer = setTimeout(() => finish(browserFault('BROWSER_TIMEOUT', '浏览器操作超时并已停止等待。请重新观察，不要盲目重复写入。')), timeoutMs)
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    socket.on('connect', () => socket.write(frame))
    socket.on('error', () => finish(browserFault('BROWSER_NOT_CONNECTED', '专用浏览器连接已断开，请打开小蛇桌面版。')))
    socket.on('close', () => finish(browserFault('BROWSER_DISCONNECTED', '专用浏览器连接已关闭，本次操作结果尚未确认。')))
    readFrame(socket, response => {
      if (response?.version !== 1 || response.id !== id || typeof response.ok !== 'boolean') { finish(browserFault('BROWSER_PROTOCOL', '浏览器响应不匹配。')); return }
      finish(response.ok ? undefined : browserFault(response.error?.code || 'BROWSER_FAILED', response.error?.message || '浏览器操作失败'), response.value)
    })
  })
}
