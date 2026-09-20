import { createHash } from 'node:crypto'
import fsPromises from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'

export type ProbeJSON = null | boolean | number | string | ProbeJSON[] | { [key: string]: ProbeJSON }
export interface PureJsProbeCase {
  readonly name?: string
  readonly args: readonly ProbeJSON[]
  readonly expect?: ProbeJSON
  /** Exact synchronous thrown value's name; not instanceof, message matching or an async rejection. */
  readonly throws?: string
  readonly immutable?: boolean
}
export interface PureJsProbeInput {
  readonly workspace: string
  readonly module: string
  readonly files?: readonly string[]
  readonly exportName: string
  readonly cases: readonly PureJsProbeCase[]
}
export interface ProbeCaseResult {
  readonly index: number
  readonly name?: string
  readonly pass: boolean
  readonly actual?: ProbeJSON
  readonly thrown?: { readonly name: string; readonly message: string }
  readonly immutable?: boolean
  readonly error?: string
}
export interface ProbeResult {
  readonly status: 'passed' | 'failed' | 'unsupported' | 'timeout' | 'cancelled' | 'error'
  readonly runtime: 'quickjs-snapshot'
  readonly modules: readonly { readonly relativePath: string; readonly sha256: string }[]
  readonly cases: readonly ProbeCaseResult[]
  readonly limitations: readonly string[]
  readonly error?: string
}
export interface ProbeWorkerInput {
  readonly entry: string
  readonly modules: readonly { readonly relativePath: string; readonly source: string }[]
  readonly exportName: string
  readonly cases: readonly PureJsProbeCase[]
}

/** Fixed host limits; callers cannot increase them with tool arguments. */
const LIMITS = { modules: 32, fileBytes: 256 * 1024, sourceBytes: 1024 * 1024,
  inputBytes: 256 * 1024, depth: 20, nodes: 10_000, wallMs: 3_000, outputBytes: 256 * 1024 }
const LIMITATIONS = [
  'QuickJS snapshot semantics, not Node.js runtime equivalence.',
  'Only synchronous JSON inputs/results and explicitly listed relative .js/.mjs modules; no host APIs.',
  'Returned/post-call JSON graphs with shared object references are unsupported; throws matches a synchronous thrown name, not an exception class brand.',
  'Cases share one module instance within a run; each run has a fresh isolated worker and interpreter.',
  'Supplementary read-only evidence only: does not certify project gates or clear unknown effects.',
  'Filesystem snapshot containment is best-effort identity validation, not a kernel sandbox against hostile concurrent host filesystem changes.',
  'Limits: 32 modules, 256 KiB/file, 1 MiB source, 32 cases, 256 KiB input/output, depth 20; 3s worker wall, 250ms guest execution, 32 MiB guest heap, 512 KiB guest stack.',
] as const

/** Internal failures carry fixed codes only, never absolute filesystem diagnostics. */
class ProbeFailure extends Error {
  constructor(readonly status: ProbeResult['status'], code: string) { super(code) }
}

/** Validate plain JSON without invoking getters/toJSON or admitting inherited fields. */
function jsonCopy(value: unknown, depth = 0, seen = new Set<object>(), budget = { nodes: 0 }): ProbeJSON {
  if (++budget.nodes > LIMITS.nodes || depth > LIMITS.depth) throw new ProbeFailure('unsupported', 'input-limit')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= LIMITS.inputBytes) return value
  if (typeof value !== 'object' || value === null || seen.has(value)) throw new ProbeFailure('unsupported', 'invalid-json-input')
  const array = Array.isArray(value)
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new ProbeFailure('unsupported', 'invalid-json-input')
  }
  seen.add(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  const output: ProbeJSON[] | { [key: string]: ProbeJSON } = array ? [] : Object.create(null)
  if (array && keys.length !== value.length + 1) throw new ProbeFailure('unsupported', 'invalid-json-input')
  for (const key of keys) {
    if (array && key === 'length') continue
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new ProbeFailure('unsupported', 'invalid-json-input')
    if (array && !/^(0|[1-9][0-9]*)$/u.test(key as string)) throw new ProbeFailure('unsupported', 'invalid-json-input')
    Object.defineProperty(output, key, { value: jsonCopy(descriptor.value, depth + 1, seen, budget), enumerable: true, writable: true, configurable: true })
  }
  seen.delete(value)
  return output
}

/** Reject extra controls, non-own expectations and ambiguous case contracts. */
function validateInput(input: unknown): PureJsProbeInput {
  const copied = jsonCopy(input) as unknown as PureJsProbeInput
  if (!copied || Array.isArray(copied) || typeof copied.workspace !== 'string' || !isAbsolute(copied.workspace)
    || typeof copied.module !== 'string' || typeof copied.exportName !== 'string'
    || !/^[A-Za-z_$][\w$]{0,127}$/u.test(copied.exportName)
    || !Array.isArray(copied.cases) || copied.cases.length < 1 || copied.cases.length > 32
    || (copied.files !== undefined && (!Array.isArray(copied.files) || copied.files.some(path => typeof path !== 'string')))
    || Object.keys(copied).some(key => !['workspace', 'module', 'files', 'exportName', 'cases'].includes(key))) {
    throw new ProbeFailure('unsupported', 'invalid-input')
  }
  for (const item of copied.cases) {
    if (!item || Array.isArray(item) || !Array.isArray(item.args)
      || Object.hasOwn(item, 'expect') === Object.hasOwn(item, 'throws')
      || (item.throws !== undefined && (typeof item.throws !== 'string' || !/^[A-Za-z_$][\w$]{0,127}$/u.test(item.throws)))
      || (item.name !== undefined && (typeof item.name !== 'string' || item.name.length > 128))
      || (item.immutable !== undefined && typeof item.immutable !== 'boolean')
      || Object.keys(item).some(key => !['name', 'args', 'expect', 'throws', 'immutable'].includes(key))) {
      throw new ProbeFailure('unsupported', 'invalid-case')
    }
  }
  if (Buffer.byteLength(JSON.stringify(copied)) > LIMITS.inputBytes) throw new ProbeFailure('unsupported', 'input-limit')
  return copied
}

/** Normalize portable relative names; entry/dependency declarations cannot leave the workspace. */
function modulePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '')
  if (normalized.length > 512 || !/\.(?:m?js)$/u.test(normalized) || isAbsolute(path)
    || /[:\0?#]/u.test(normalized) || normalized.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new ProbeFailure('unsupported', 'module-path-not-allowed')
  }
  return normalized
}

/** Realpath containment is segment-based, including Windows drive boundaries. */
function within(root: string, path: string): boolean {
  const difference = relative(root, path)
  return difference !== '' && !isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`)
}

/** Abort checks occur between bounded filesystem operations and before execution. */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProbeFailure('cancelled', 'cancelled')
}

/**
 * Read a regular file through a checked descriptor and reject observed replacement.
 * A final path identity check closes an observed directory/junction ABA; portable
 * realpath/stat are not an atomic sandbox against arbitrary hostile host races.
 */
async function snapshotFile(root: string, path: string, signal?: AbortSignal): Promise<{ source: string; sha256: string; bytes: number }> {
  checkAbort(signal)
  const requested = resolve(root, path)
  const canonical = await fsPromises.realpath(requested)
  if (!within(root, canonical)) throw new ProbeFailure('unsupported', 'module-path-not-allowed')
  const before = await fsPromises.stat(canonical)
  if (!before.isFile() || before.size > LIMITS.fileBytes) throw new ProbeFailure('unsupported', 'module-size-or-type')
  const descriptor = await fsPromises.open(canonical, 'r')
  try {
    const opened = await descriptor.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new ProbeFailure('unsupported', 'module-changed-during-snapshot')
    }
    const buffer = Buffer.alloc(LIMITS.fileBytes + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      checkAbort(signal)
      const read = await descriptor.read(buffer, bytes, buffer.length - bytes, bytes)
      if (read.bytesRead === 0) break
      bytes += read.bytesRead
    }
    const after = await descriptor.stat()
    if (bytes > LIMITS.fileBytes || after.size !== before.size || bytes !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || await fsPromises.realpath(requested) !== canonical) throw new ProbeFailure('unsupported', 'module-changed-during-snapshot')
    const current = await fsPromises.stat(canonical)
    if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
      || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
      throw new ProbeFailure('unsupported', 'module-changed-during-snapshot')
    }
    let source: string
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)) }
    catch { throw new ProbeFailure('unsupported', 'module-is-not-utf8') }
    return { source, bytes, sha256: createHash('sha256').update(buffer.subarray(0, bytes)).digest('hex') }
  } finally { await descriptor.close() }
}

/** Construct the trusted envelope from parent-owned snapshot identity. */
function envelope(status: ProbeResult['status'], modules: ProbeResult['modules'], cases: readonly ProbeCaseResult[] = [], error?: string): ProbeResult {
  return { status, runtime: 'quickjs-snapshot', modules, cases, limitations: [...LIMITATIONS], ...(error === undefined ? {} : { error }) }
}

/** Terminate and await the dedicated worker before resolving any terminal outcome. */
async function executeSnapshot(input: ProbeWorkerInput, modules: ProbeResult['modules'], signal?: AbortSignal): Promise<ProbeResult> {
  checkAbort(signal)
  return new Promise(resolveResult => {
    let done = false
    const worker = new Worker(new URL('./pure-js-probe-worker.js', import.meta.url), {
      workerData: input, env: {}, execArgv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    })
    const finish = (result: ProbeResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancelled)
      void worker.terminate().then(() => resolveResult(result), () => resolveResult(envelope('error', modules, [], 'worker-cleanup-failed')))
    }
    const cancelled = (): void => finish(envelope('cancelled', modules, [], 'cancelled'))
    const timer = setTimeout(() => finish(envelope('timeout', modules, [], 'worker-wall-limit')), LIMITS.wallMs)
    signal?.addEventListener('abort', cancelled, { once: true })
    if (signal?.aborted) cancelled()
    // Guest receives no console bridge. Suppress/bound accidental WASM diagnostics.
    let diagnosticBytes = 0
    for (const stream of [worker.stdout, worker.stderr]) stream.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length
      if (diagnosticBytes > LIMITS.outputBytes) finish(envelope('error', modules, [], 'worker-output-limit'))
    })
    worker.once('error', () => finish(envelope('error', modules, [], 'worker-error')))
    worker.once('exit', () => { if (!done) finish(envelope('error', modules, [], 'worker-exited-without-result')) })
    worker.once('message', (message: { status?: ProbeResult['status']; cases?: ProbeCaseResult[]; error?: string }) => {
      if (!message || !['passed', 'failed', 'unsupported', 'timeout', 'error'].includes(message.status ?? '')
        || !Array.isArray(message.cases) || message.cases.length > input.cases.length
        || Buffer.byteLength(JSON.stringify(message)) > LIMITS.outputBytes
        || (message.status === 'passed' && (message.cases.length !== input.cases.length
          || message.cases.length === 0 || message.cases.some(item => item.pass !== true)))) {
        finish(envelope('error', modules, [], 'invalid-worker-result'))
      } else finish(envelope(message.status!, modules, message.cases, message.error))
    })
  })
}

/**
 * Probe explicitly declared pure ESM snapshots, without writing files or minting
 * canonical project verification facts. Host validation and errors fail closed.
 */
export async function runPureJsProbe(input: PureJsProbeInput, signal?: AbortSignal): Promise<ProbeResult> {
  const modules: Array<{ relativePath: string; sha256: string }> = []
  try {
    checkAbort(signal)
    const validated = validateInput(input)
    const root = await fsPromises.realpath(validated.workspace)
    if (!(await fsPromises.stat(root)).isDirectory()) throw new ProbeFailure('unsupported', 'workspace-not-directory')
    const entry = modulePath(validated.module)
    const names = [...new Set([entry, ...(validated.files ?? []).map(modulePath)])]
    if (names.length > LIMITS.modules) throw new ProbeFailure('unsupported', 'module-count-limit')
    const snapshots: Array<{ relativePath: string; source: string }> = []
    let totalBytes = 0
    for (const relativePath of names) {
      const snapshot = await snapshotFile(root, relativePath, signal)
      totalBytes += snapshot.bytes
      if (totalBytes > LIMITS.sourceBytes) throw new ProbeFailure('unsupported', 'source-total-limit')
      snapshots.push({ relativePath, source: snapshot.source })
      modules.push({ relativePath, sha256: snapshot.sha256 })
    }
    return await executeSnapshot({ entry, modules: snapshots, exportName: validated.exportName, cases: validated.cases }, modules, signal)
  } catch (error) {
    if (signal?.aborted) return envelope('cancelled', modules, [], 'cancelled')
    return error instanceof ProbeFailure ? envelope(error.status, modules, [], error.message)
      : envelope('unsupported', modules, [], 'snapshot-unavailable')
  }
}
