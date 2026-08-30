import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { JsonValue, ResolvedConfig } from './types.js'

const MAX_PROTOCOL_LINE_BYTES = 1_048_576
const MAX_STDERR_CHARS = 32_768
const FORCE_KILL_DELAY_MS = 2_000

interface PendingRequest {
  readonly resolve: (value: JsonValue) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
  readonly signal: AbortSignal
  readonly onAbort: () => void
}

interface RpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly result?: JsonValue
  readonly error?: {
    readonly code?: unknown
    readonly message?: unknown
    readonly data?: unknown
  }
}

/** Error reported by the Python JSON-RPC server. */
export class BridgeRpcError extends Error {
  constructor(
    message: string,
    public readonly rpcCode: number | undefined,
    public readonly rpcData: unknown,
  ) {
    super(message)
    this.name = 'BridgeRpcError'
  }
}

/** One lazily spawned, strictly framed Python bridge owned by a plugin fiber. */
export class BridgeClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private stdoutBuffer = ''
  private stderrTail = ''
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stopping: Promise<void> | undefined

  constructor(
    private readonly config: ResolvedConfig,
    private readonly scriptPath = fileURLToPath(new URL('../python/xiaoshe_desktop_bridge.py', import.meta.url)),
  ) {}

  /** Send one request; timeout or caller cancellation tears down the whole exclusive bridge. */
  async request(method: string, params: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    if (signal.aborted) throw abortError()
    if (this.stopping !== undefined) await this.stopping
    const child = this.ensureStarted()
    const id = this.nextId
    this.nextId += 1

    return await new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Xiaoshe desktop bridge timed out after ${this.config.requestTimeoutMs} ms`)
        this.rejectOne(id, error)
        void this.stop(error)
      }, this.config.requestTimeoutMs)
      timer.unref()

      const onAbort = (): void => {
        const error = abortError()
        this.rejectOne(id, error)
        void this.stop(error)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve, reject, timer, signal, onAbort })

      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      child.stdin.write(payload, 'utf8', (error) => {
        if (error !== null && error !== undefined) {
          const writeError = new Error(`Xiaoshe desktop bridge write failed: ${error.message}`)
          this.rejectOne(id, writeError)
          void this.stop(writeError)
        }
      })
    })
  }

  /** Stop the bridge process tree and wait until no owned process remains. */
  async dispose(): Promise<void> {
    await this.stop(new Error('Xiaoshe desktop plugin disposed'))
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child !== undefined) return this.child
    const args = [
      '-I',
      '-X',
      'utf8',
      '-u',
      this.scriptPath,
      '--xiaoshe-root',
      this.config.xiaosheRoot,
      '--actions-enabled',
      this.config.actionsEnabled ? 'true' : 'false',
    ]
    const child = spawn(this.config.pythonExecutable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeChildEnvironment(),
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    this.child = child
    this.stdoutBuffer = ''
    this.stderrTail = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(child, chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_CHARS)
    })
    child.once('error', error => this.onChildFailure(child, new Error(`Bridge spawn failed: ${error.message}`)))
    child.once('exit', (code, signal) => {
      const suffix = this.stderrTail.trim() === '' ? '' : `; stderr: ${this.stderrTail.trim()}`
      this.onChildFailure(
        child,
        new Error(`Bridge exited before all requests settled (code=${String(code)}, signal=${String(signal)})${suffix}`),
      )
    })
    return child
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return
    this.stdoutBuffer += chunk
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > MAX_PROTOCOL_LINE_BYTES && !this.stdoutBuffer.includes('\n')) {
      const error = new Error('Bridge emitted an oversized unterminated protocol line')
      this.failAll(error)
      void this.stop(error)
      return
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
        const error = new Error('Bridge emitted an oversized protocol response')
        this.failAll(error)
        void this.stop(error)
        return
      }
      if (line.trim() !== '') this.handleResponse(line)
    }
  }

  private handleResponse(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error: unknown) {
      const protocolError = new Error(`Bridge emitted invalid JSON: ${errorMessage(error)}`)
      this.failAll(protocolError)
      void this.stop(protocolError)
      return
    }
    if (!isRpcResponse(value)) {
      const protocolError = new Error('Bridge emitted a response with invalid JSON-RPC fields')
      this.failAll(protocolError)
      void this.stop(protocolError)
      return
    }
    const pending = this.pending.get(value.id)
    if (pending === undefined) return
    this.clearPending(value.id, pending)
    if (value.error !== undefined) {
      const message = typeof value.error.message === 'string' ? value.error.message : 'Unknown bridge RPC error'
      const code = typeof value.error.code === 'number' ? value.error.code : undefined
      pending.reject(new BridgeRpcError(message, code, value.error.data))
      return
    }
    if (!Object.hasOwn(value, 'result')) {
      pending.reject(new Error('Bridge response contains neither result nor error'))
      return
    }
    pending.resolve(value.result ?? null)
  }

  private rejectOne(id: number, error: Error): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.clearPending(id, pending)
    pending.reject(error)
  }

  private clearPending(id: number, pending: PendingRequest): void {
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.signal.removeEventListener('abort', pending.onAbort)
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.clearPending(id, pending)
      pending.reject(error)
    }
  }

  private onChildFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return
    this.child = undefined
    this.failAll(error)
  }

  private async stop(reason: Error): Promise<void> {
    if (this.stopping !== undefined) return await this.stopping
    const child = this.child
    if (child === undefined) {
      this.failAll(reason)
      return
    }
    this.child = undefined
    this.stopping = new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(forceTimer)
        resolve()
      }
      child.once('exit', finish)
      terminateProcessTree(child, 'SIGTERM')
      const forceTimer = setTimeout(() => {
        terminateProcessTree(child, 'SIGKILL')
        finish()
      }, FORCE_KILL_DELAY_MS)
      forceTimer.unref()
      if (child.exitCode !== null || child.signalCode !== null) finish()
    }).finally(() => {
      this.stopping = undefined
    })
    this.failAll(reason)
    await this.stopping
  }
}

function isRpcResponse(value: unknown): value is RpcResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.jsonrpc !== '2.0' || typeof record.id !== 'number' || !Number.isSafeInteger(record.id)) return false
  const hasResult = Object.hasOwn(record, 'result')
  const hasError = Object.hasOwn(record, 'error')
  return hasResult !== hasError
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'TEMP', 'TMP',
    'LOCALAPPDATA', 'APPDATA',
  ] as const
  const output: NodeJS.ProcessEnv = {}
  for (const name of allowed) {
    const value = process.env[name]
    if (value !== undefined) output[name] = value
  }
  output.PYTHONIOENCODING = 'utf-8'
  output.PYTHONUTF8 = '1'
  return output
}

type KillableChild = Pick<ChildProcessWithoutNullStreams, 'pid' | 'exitCode' | 'signalCode' | 'kill'>

/** Terminate an owned child while tolerating only an already-exited Windows handle race. */
export function terminateProcessTree(child: KillableChild, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, signal)
    } else {
      child.kill(signal)
    }
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined
    const alreadyExited = child.exitCode !== null || child.signalCode !== null
    if (code !== 'ESRCH' && !(process.platform === 'win32' && code === 'EINVAL' && alreadyExited)) throw error
  }
}

function abortError(): Error {
  const error = new Error('Xiaoshe desktop bridge request aborted')
  error.name = 'AbortError'
  return error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
