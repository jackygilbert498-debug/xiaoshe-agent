import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly stdoutBytes: number
  readonly stderrBytes: number
}

export interface ProcessRunOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly signal?: AbortSignal
}

/** Execute one argv-only child with bounded, redacted diagnostics. Never uses a shell. */
export async function runBoundedProcess(options: ProcessRunOptions): Promise<ProcessResult> {
  if (!isAbsolute(options.command)) throw new TypeError('process command must be an absolute executable path')
  if (!isAbsolute(options.cwd)) throw new TypeError('process cwd must be absolute')
  if (options.args.some(value => typeof value !== 'string' || value.includes('\0') || /[\r\n]/u.test(value))) throw new TypeError('process argv contains unsupported control characters')
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) throw new RangeError('process timeout is out of range')
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4 * 1024 * 1024) throw new RangeError('process output bound is out of range')
  if (options.signal?.aborted === true) return emptyTerminatedResult(true)

  const child = spawn(resolve(options.command), [...options.args], {
    cwd: resolve(options.cwd),
    env: { ...options.environment },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  })
  const stdout = new BoundedOutput(maxOutputBytes)
  const stderr = new BoundedOutput(maxOutputBytes)
  child.stdout?.on('data', (chunk: Buffer | string) => stdout.append(chunk))
  child.stderr?.on('data', (chunk: Buffer | string) => stderr.append(chunk))
  let timedOut = false
  let aborted = false
  let settled = false
  let forceTimer: NodeJS.Timeout | undefined
  const terminate = (kind: 'timeout' | 'abort'): void => {
    if (settled || child.exitCode !== null) return
    timedOut ||= kind === 'timeout'
    aborted ||= kind === 'abort'
    child.kill()
    forceTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 5_000)
    forceTimer.unref()
  }
  const timeout = setTimeout(() => terminate('timeout'), timeoutMs)
  timeout.unref()
  const abort = (): void => terminate('abort')
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', code => resolveExit(code ?? -1))
    })
    settled = true
    return {
      exitCode,
      stdout: redact(stdout.text()),
      stderr: redact(stderr.text()),
      timedOut,
      aborted,
      stdoutBytes: stdout.totalBytes,
      stderrBytes: stderr.totalBytes,
    }
  } finally {
    settled = true
    clearTimeout(timeout)
    if (forceTimer !== undefined) clearTimeout(forceTimer)
    options.signal?.removeEventListener('abort', abort)
  }
}

class BoundedOutput {
  totalBytes = 0
  #buffer = Buffer.alloc(0)
  constructor(readonly limit: number) {}
  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    this.totalBytes += chunk.byteLength
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    if (this.#buffer.byteLength > this.limit) this.#buffer = this.#buffer.subarray(this.#buffer.byteLength - this.limit)
  }
  text(): string {
    const suffix = this.#buffer.toString('utf8')
    return this.totalBytes <= this.limit ? suffix : `[truncated; original ${this.totalBytes} bytes]\n${suffix}`
  }
}

function redact(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)[A-Za-z0-9_]*)\s*[:=]\s*([^\s,;]+)/giu, '$1=[REDACTED]')
    .slice(0, 4 * 1024 * 1024)
}

function emptyTerminatedResult(aborted: boolean): ProcessResult {
  return { exitCode: -1, stdout: '', stderr: '', timedOut: false, aborted, stdoutBytes: 0, stderrBytes: 0 }
}
