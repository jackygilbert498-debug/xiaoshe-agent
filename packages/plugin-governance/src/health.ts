import { spawn, type ChildProcess } from 'node:child_process'
import { type DshProfileManagerLike } from './dsh-profile.js'
import type { HealthGateReceipt } from './store.js'

export interface HealthResult {
  readonly state: 'healthy' | 'partial-health' | 'failed'
  readonly gates: readonly HealthGateReceipt[]
}

export interface HealthCheckInput {
  readonly profile: string
  readonly packageName: string
  readonly expected: 'present' | 'absent' | 'ignore'
  readonly candidateHealthPath?: string
  readonly signal: AbortSignal
}

export interface ProfileHealthCheckerLike { verify(input: HealthCheckInput): Promise<HealthResult> }

export interface ProfileHealthCheckerOptions {
  readonly manager: DshProfileManagerLike
  readonly cliPath: string
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  readonly nodeArgs?: readonly string[]
  readonly startupTimeoutMs?: number
  readonly probeTimeoutMs?: number
}

/** Condition-based dump, boot, loopback probe and clean-stop health verifier. */
export class ProfileHealthChecker implements ProfileHealthCheckerLike {
  readonly #manager: DshProfileManagerLike
  readonly #cliPath: string
  readonly #cwd: string
  readonly #environment: NodeJS.ProcessEnv
  readonly #nodeArgs: readonly string[]
  readonly #startupTimeoutMs: number
  readonly #probeTimeoutMs: number

  constructor(options: ProfileHealthCheckerOptions) {
    this.#manager = options.manager
    this.#cliPath = options.cliPath
    this.#cwd = options.cwd
    this.#environment = { ...options.environment }
    this.#nodeArgs = options.nodeArgs ?? ['--import', 'tsx/esm']
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 60_000
    this.#probeTimeoutMs = options.probeTimeoutMs ?? 10_000
  }

  async verify(input: HealthCheckInput): Promise<HealthResult> {
    const gates: HealthGateReceipt[] = []
    let dump: string
    try {
      dump = await this.#manager.dump(input.profile, input.signal)
      const membership = dump.includes(input.packageName)
      const ok = input.expected === 'ignore' || (input.expected === 'present' ? membership : !membership)
      gates.push({ gate: 'profile-dump', ok, detail: input.expected === 'ignore' ? 'dump completed' : `${input.packageName} is ${membership ? 'present' : 'absent'}` })
      if (!ok) return { state: 'failed', gates }
    } catch (error) {
      gates.push({ gate: 'profile-dump', ok: false, detail: safeMessage(error) })
      return { state: 'failed', gates }
    }

    let held: { child: ChildProcess; url: string; output: () => string }
    try {
      held = await this.#start(input.profile, input.signal)
      gates.push({ gate: 'profile-start', ok: true, detail: held.url })
    } catch (error) {
      gates.push({ gate: 'profile-start', ok: false, detail: safeMessage(error) })
      return { state: 'failed', gates }
    }

    let probeState: 'healthy' | 'partial-health' | 'failed' = 'partial-health'
    if (input.candidateHealthPath === undefined) {
      gates.push({ gate: 'functional-probe', ok: false, detail: 'candidate declares no functional health path' })
    } else {
      try {
        validateHealthPath(input.candidateHealthPath)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.#probeTimeoutMs)
        const abort = (): void => controller.abort()
        input.signal.addEventListener('abort', abort, { once: true })
        try {
          const response = await fetch(`${held.url}${input.candidateHealthPath}`, { signal: controller.signal, cache: 'no-store' })
          const body: unknown = await response.json()
          const bodyHealthy = isRecord(body) && (body.ok === true || body.status === 'ok' || body.status === 'healthy' || Array.isArray(body.transactions))
          if (!response.ok || !bodyHealthy) throw new Error(`functional probe returned HTTP ${response.status} or malformed health JSON`)
          gates.push({ gate: 'functional-probe', ok: true, detail: `HTTP ${response.status}` })
          probeState = 'healthy'
        } finally {
          clearTimeout(timer)
          input.signal.removeEventListener('abort', abort)
        }
      } catch (error) {
        gates.push({ gate: 'functional-probe', ok: false, detail: safeMessage(error) })
        probeState = 'failed'
      }
    }
    const stopped = await stopChild(held.child)
    gates.push({ gate: 'clean-stop', ok: stopped, detail: stopped ? 'profile stopped' : `profile did not stop cleanly; ${held.output().slice(-500)}` })
    if (!stopped) return { state: 'failed', gates }
    return { state: probeState, gates }
  }

  async #start(profile: string, signal: AbortSignal): Promise<{ child: ChildProcess; url: string; output: () => string }> {
    if (signal.aborted) throw new Error('profile health check aborted')
    const child = spawn(process.execPath, [...this.#nodeArgs, this.#cliPath, '--profile', profile, '--no-open', '--port', '0'], {
      cwd: this.#cwd, env: this.#environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
    })
    let output = ''
    const append = (chunk: Buffer | string): void => { output = `${output}${String(chunk)}`.slice(-64 * 1024) }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const abort = (): void => { child.kill() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const url = await new Promise<string>((resolveUrl, reject) => {
        let done = false
        const finish = (error?: Error, value?: string): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          child.stdout?.off('data', inspect)
          child.stderr?.off('data', inspect)
          child.off('exit', exited)
          error === undefined ? resolveUrl(value!) : reject(error)
        }
        const inspect = (): void => {
          const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)
          if (match?.[1] !== undefined) finish(undefined, match[1])
        }
        const exited = (code: number | null): void => finish(new Error(`profile exited before announcing URL (${String(code)}): ${output.slice(-1_000)}`))
        const timer = setTimeout(() => finish(new Error(`profile did not announce a loopback URL within ${this.#startupTimeoutMs}ms`)), this.#startupTimeoutMs)
        child.stdout?.on('data', inspect)
        child.stderr?.on('data', inspect)
        child.once('exit', exited)
        inspect()
      })
      return { child, url, output: () => output }
    } catch (error) {
      await stopChild(child)
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}

async function stopChild(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null) return child.exitCode === 0
  child.kill()
  return new Promise(resolveStop => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolveStop(false) }, 5_000)
    child.once('exit', (code, signal) => { clearTimeout(timer); resolveStop(code === 0 || signal === 'SIGTERM') })
  })
}
function validateHealthPath(path: string): void {
  if (path.length > 200 || !/^\/api\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(path) || path.includes('..') || path.includes('//')) throw new TypeError('invalid functional health path')
}
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
