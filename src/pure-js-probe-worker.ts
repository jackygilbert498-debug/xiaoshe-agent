import { parentPort, workerData } from 'node:worker_threads'
import { posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { getQuickJS, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten'
import type { ProbeCaseResult, ProbeJSON, ProbeResult, ProbeWorkerInput } from './pure-js-probe.js'

const HEAP_BYTES = 32 * 1024 * 1024
const STACK_BYTES = 512 * 1024
const EXECUTION_MS = 250
const CASE_OUTPUT_BYTES = 64 * 1024
const TOTAL_OUTPUT_BYTES = 256 * 1024
const BINARY_BYTES = 256 * 1024

/**
 * This host-authored function is captured BEFORE loading guest modules and is
 * never installed on the guest global. It accepts only a function and JSON
 * arguments; no host function/object is bridged. Captured intrinsic references
 * and descriptor-based traversal resist JSON/Object/prototype monkey-patching.
 * It serializes strict finite JSON, not toJSON/getters, with bounded work/output.
 */
const INVOKER = String.raw`(() => {
  const descriptors = Object.getOwnPropertyDescriptors, ownKeys = Reflect.ownKeys, hasOwn = Object.hasOwn;
  const getPrototype = Object.getPrototypeOf, objectPrototype = Object.prototype;
  const arrayPrototype = Array.prototype, isArray = Array.isArray, create = Object.create;
  const stringify = JSON.stringify, parse = JSON.parse, apply = Reflect.apply, finite = Number.isFinite;
  const unsupported = create(null);
  let nodes = 0, objects = create(null), objectCount = 0;
  function finish(text) {
    const result = create(null);
    objects.length = objectCount;
    result.objects = objects;
    result.text = text;
    return result;
  }
  function encode(value, depth = 0, stack = create(null)) {
    if (++nodes > 4000 || depth > 20) throw unsupported;
    if (value === null || typeof value === 'boolean') return stringify(value);
    if (typeof value === 'number') { if (!finite(value)) throw unsupported; return stringify(value); }
    if (typeof value === 'string') { if (value.length > 32768) throw unsupported; return stringify(value); }
    if (typeof value !== 'object') throw unsupported;
    objects[objectCount++] = value;
    for (let i = 0; i < depth; i++) if (stack[i] === value) throw unsupported;
    const array = isArray(value), prototype = getPrototype(value);
    if (prototype !== null && prototype !== (array ? arrayPrototype : objectPrototype)) throw unsupported;
    stack[depth] = value;
    const properties = descriptors(value), keys = ownKeys(properties);
    let output = array ? '[' : '{';
    if (array) {
      if (!hasOwn(properties, 'length') || !hasOwn(properties.length, 'value')) throw unsupported;
      const length = properties.length.value;
      if (length > 2000 || keys.length !== length + 1) throw unsupported;
      for (let i = 0; i < length; i++) {
        const item = properties[i];
        if (!hasOwn(properties, i) || !item || !hasOwn(item, 'value') || !item.enumerable) throw unsupported;
        output += (i ? ',' : '') + encode(item.value, depth + 1, stack);
        if (output.length > 65536) throw unsupported;
      }
    } else {
      if (keys.length > 2000) throw unsupported;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i], item = properties[key];
        if (typeof key !== 'string' || !hasOwn(item, 'value') || !item.enumerable) throw unsupported;
        output += (i ? ',' : '') + stringify(key) + ':' + encode(item.value, depth + 1, stack);
        if (output.length > 65536) throw unsupported;
      }
    }
    delete stack[depth];
    return output + (array ? ']' : '}');
  }
  return function invoke(fn, input) {
    nodes = 0; objects = create(null); objectCount = 0;
    const args = parse(input);
    let value, thrown = false, exception;
    try { value = apply(fn, undefined, args); } catch (error) { thrown = true; exception = error; }
    try {
      const after = encode(args);
      if (thrown) {
        let name = 'ThrownValue', message = '';
        if (exception !== null && (typeof exception === 'object' || typeof exception === 'function')) {
          // Exception accessors are not needed for this bounded name contract.
          let cursor = exception, foundName = false, foundMessage = false;
          for (let level = 0; cursor !== null && level < 8; level++, cursor = getPrototype(cursor)) {
            const fields = descriptors(cursor);
            const names = ['name', 'message'];
            for (let i = 0; i < names.length; i++) {
              const key = names[i];
              if (!hasOwn(fields, key)) continue;
              const field = fields[key];
              if (!field) continue;
              if (!hasOwn(field, 'value')) throw unsupported;
              if (key === 'name' && !foundName) { name = field.value; foundName = true; }
              if (key === 'message' && !foundMessage) { message = field.value; foundMessage = true; }
            }
          }
        } else if (typeof exception === 'string') message = exception;
        if (typeof name !== 'string' || name.length > 128 || typeof message !== 'string' || message.length > 2048) throw unsupported;
        return finish('{"kind":"throw","name":' + stringify(name) + ',"message":' + stringify(message) + ',"args":' + after + '}');
      }
      return finish('{"kind":"return","actual":' + encode(value) + ',"args":' + after + '}');
    } catch (_) { return finish('{"kind":"unsupported"}'); }
  };
})()`

/** Only this fixed validator runs in the second context; guest code never does. */
const CLEAN_VALIDATOR = String.raw`(() => {
  const byteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
  function validate(root) {
    let nodes = 0;
    const seen = new WeakSet();
    function visit(value, depth) {
      if (++nodes > 10000 || depth > 22) return false;
      if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
      if (typeof value === 'number') return Number.isFinite(value);
      if (typeof value !== 'object') return false;
      const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
      if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) return false;
      if (seen.has(value)) return true;
      seen.add(value);
      const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
      if (array && keys.length !== value.length + 1) return false;
      for (const key of keys) {
        if (array && key === 'length') continue;
        const field = fields[key];
        if (typeof key !== 'string' || !Object.hasOwn(field, 'value') || !field.enumerable || !visit(field.value, depth + 1)) return false;
      }
      return true;
    }
    return visit(root, 0);
  }
  return { validate, byteLength };
})()`

/** Normalize only relative imports and resolve strictly within the supplied map. */
function normalizeImport(base: string, requested: string, modules: ReadonlyMap<string, string>): string {
  if ((!requested.startsWith('./') && !requested.startsWith('../')) || /[\\:\0?#]/u.test(requested)) throw new Error('unsupported-import')
  const resolved = posix.normalize(posix.join(posix.dirname(base), requested))
  if (resolved.startsWith('../') || resolved.startsWith('/') || !modules.has(resolved)) throw new Error('missing-or-unsupported-module')
  return resolved
}

/** Dispose a promise result only when it is not the original non-promise handle. */
function isPromise(context: QuickJSContext, value: QuickJSHandle): boolean {
  const state = context.getPromiseState(value)
  if (state.type === 'fulfilled' && state.notAPromise) return false
  if (state.type === 'fulfilled') state.value.dispose()
  else if (state.type === 'rejected') state.error.dispose()
  return true
}

/**
 * The private invoker supplies raw objects, never a guest-accessible host API.
 * Descriptor validation runs first (no getters/toJSON), then QuickJS BinaryJSON
 * copies each raw JSON object's genuine internal class to a clean context:
 * disguised Date/views are
 * restored and rejected, while Proxy/Map/Set and other unsupported classes fail
 * encoding. This is not a growing JavaScript brand blacklist. Both contexts
 * share the same bounded runtime. quickjs-emscripten 0.32.0 encodes with
 * JS_WRITE_OBJ_REFERENCE (no BYTECODE) and decodes with flags 0 (no BYTECODE).
 * Each object is copied separately: encoding the inventory itself would create
 * shared references, which this version's public decoder rejects. Guest JSON
 * graphs containing shared references are likewise explicitly unsupported.
 * No guest-supplied bytes are decoded, and cumulative private bytes are capped before
 * decoding or copying it to the host. Returned error handles are always freed;
 * an encoder/decoder's pending exception is freed with its context on exit.
 */
function readInvocation(context: QuickJSContext, clean: QuickJSContext, validator: QuickJSHandle,
  byteLength: QuickJSHandle, invocation: QuickJSHandle): string | undefined {
  const textHandle = context.getProp(invocation, 'text')
  let text: string
  try { text = context.getString(textHandle) } finally { textHandle.dispose() }
  // A rejected accessor must never reach the engine serializer.
  if (text === '{"kind":"unsupported"}') return text
  const objects = context.getProp(invocation, 'objects')
  try {
    const length = context.getLength(objects)
    if (length === undefined || length > 4001) throw new Error('invalid-invocation')
    let binaryBytes = 0
    for (let index = 0; index < length; index++) {
      const value = context.getProp(objects, index)
      try {
        const binary = context.encodeBinaryJSON(value)
        try {
          if (context.typeof(binary) !== 'object') return undefined
          const size = clean.callFunction(byteLength, binary)
          if (size.error) { size.error.dispose(); return undefined }
          try { binaryBytes += clean.getNumber(size.value) } finally { size.value.dispose() }
          if (binaryBytes > BINARY_BYTES) return undefined
          const cloned = clean.decodeBinaryJSON(binary)
          try {
            if (clean.typeof(cloned) !== 'object') return undefined
            const checked = clean.callFunction(validator, clean.undefined, cloned)
            if (checked.error) { checked.error.dispose(); return undefined }
            try { if (!clean.eq(checked.value, clean.true)) return undefined } finally { checked.value.dispose() }
          } finally { cloned.dispose() }
        } finally { binary.dispose() }
      } finally { value.dispose() }
    }
  } finally { objects.dispose() }
  return text
}

/** Read a bounded primitive error name; never dump guest stacks or arbitrary values. */
function errorName(context: QuickJSContext, error: QuickJSHandle): string {
  const property = context.getProp(error, 'name')
  try { return context.typeof(property) === 'string' ? context.getString(property).slice(0, 128) : 'Error' }
  finally { property.dispose() }
}

/** Execute no pending jobs: promises, top-level await and async results are unsupported. */
async function execute(input: ProbeWorkerInput): Promise<{ status: ProbeResult['status']; cases: ProbeCaseResult[]; error?: string }> {
  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(HEAP_BYTES)
  runtime.setMaxStackSize(STACK_BYTES)
  const deadline = performance.now() + EXECUTION_MS
  let interrupted = false, importFailure = false
  runtime.setInterruptHandler(() => { interrupted ||= performance.now() >= deadline; return interrupted })
  const modules = new Map(input.modules.map(module => [module.relativePath, module.source]))
  runtime.setModuleLoader(name => {
    const source = modules.get(name)
    if (source === undefined) { importFailure = true; throw new Error('missing-module') }
    return source
  }, (base, requested) => {
    try { return normalizeImport(base, requested, modules) }
    catch { importFailure = true; throw new Error('unsupported-import') }
  })
  const context = runtime.newContext()
  const clean = runtime.newContext()
  const handles: QuickJSHandle[] = []
  const cases: ProbeCaseResult[] = []
  try {
    const cleanBootstrap = clean.evalCode(CLEAN_VALIDATOR, '<probe-validator>')
    if (cleanBootstrap.error) { cleanBootstrap.error.dispose(); return { status: 'error', cases, error: 'interpreter-initialization-failed' } }
    handles.push(cleanBootstrap.value)
    const validator = clean.getProp(cleanBootstrap.value, 'validate'), binaryByteLength = clean.getProp(cleanBootstrap.value, 'byteLength')
    handles.push(validator, binaryByteLength)
    const bootstrap = context.evalCode(INVOKER, '<probe-invoker>')
    if (bootstrap.error) { bootstrap.error.dispose(); return { status: 'error', cases, error: 'interpreter-initialization-failed' } }
    const invoker = bootstrap.value
    handles.push(invoker)
    const moduleResult = context.evalCode(modules.get(input.entry)!, input.entry, { type: 'module' })
    if (moduleResult.error) {
      const syntax = errorName(context, moduleResult.error) === 'SyntaxError'
      moduleResult.error.dispose()
      return { status: interrupted ? 'timeout' : importFailure || syntax ? 'unsupported' : 'error', cases,
        error: interrupted ? 'guest-execution-limit' : importFailure ? 'missing-or-unsupported-module' : syntax ? 'module-syntax-unsupported' : 'module-evaluation-failed' }
    }
    handles.push(moduleResult.value)
    if (isPromise(context, moduleResult.value) || runtime.hasPendingJob() || importFailure) {
      return { status: 'unsupported', cases, error: 'async-modules-unsupported' }
    }
    const callable = context.getProp(moduleResult.value, input.exportName)
    handles.push(callable)
    if (context.typeof(callable) !== 'function') return { status: 'unsupported', cases, error: 'export-is-not-a-function' }
    let outputBytes = 0, unsupported = false
    for (let index = 0; index < input.cases.length; index++) {
      const item = input.cases[index]!
      const json = context.newString(JSON.stringify(item.args))
      let result
      try { result = context.callFunction(invoker, context.undefined, callable, json) }
      finally { json.dispose() }
      if (result.error) {
        result.error.dispose()
        return { status: interrupted ? 'timeout' : 'error', cases, error: interrupted ? 'guest-execution-limit' : 'guest-resource-or-execution-error' }
      }
      let text: string | undefined
      try { text = readInvocation(context, clean, validator, binaryByteLength, result.value) } finally { result.value.dispose() }
      if (interrupted) return { status: 'timeout', cases, error: 'guest-execution-limit' }
      if (runtime.hasPendingJob() || importFailure) return { status: 'unsupported', cases, error: 'async-work-unsupported' }
      if (text === undefined) return { status: 'unsupported', cases, error: 'non-json-or-async-value' }
      const byteLength = Buffer.byteLength(text)
      outputBytes += byteLength
      const base = { index, ...(item.name === undefined ? {} : { name: item.name }) }
      if (byteLength > CASE_OUTPUT_BYTES || outputBytes > TOTAL_OUTPUT_BYTES) {
        return { status: 'unsupported', cases: [...cases, { ...base, pass: false, error: 'output-limit' }], error: 'output-limit' }
      }
      const value = JSON.parse(text) as { kind: string; actual?: ProbeJSON; args?: ProbeJSON[]; name?: string; message?: string }
      if (value.kind === 'unsupported') {
        unsupported = true
        cases.push({ ...base, pass: false, error: 'non-json-or-async-value' })
        continue
      }
      const immutable = isDeepStrictEqual(value.args, item.args)
      if (value.kind === 'throw') {
        if (value.name === 'InternalError' && /memory|stack|interrupt/iu.test(value.message ?? '')) {
          return { status: 'error', cases, error: 'guest-resource-limit' }
        }
        const pass = Object.hasOwn(item, 'throws') && value.name === item.throws && (!item.immutable || immutable)
        cases.push({ ...base, pass, thrown: { name: value.name!, message: value.message! },
          ...(item.immutable ? { immutable } : {}), ...(pass ? {} : { error: item.immutable && !immutable ? 'arguments-mutated' : 'unexpected-exception' }) })
      } else if (value.kind === 'return' && Object.hasOwn(value, 'actual')) {
        const pass = Object.hasOwn(item, 'expect') && isDeepStrictEqual(value.actual, item.expect) && (!item.immutable || immutable)
        cases.push({ ...base, pass, actual: value.actual!, ...(item.immutable ? { immutable } : {}),
          ...(pass ? {} : { error: item.immutable && !immutable ? 'arguments-mutated' : 'expectation-mismatch' }) })
      } else return { status: 'error', cases, error: 'invalid-interpreter-result' }
    }
    return { status: unsupported ? 'unsupported' : cases.length > 0 && cases.every(item => item.pass) ? 'passed' : 'failed', cases }
  } finally {
    for (const handle of handles.reverse()) handle.dispose()
    clean.dispose()
    context.dispose()
    runtime.dispose()
  }
}

/** Only worker-owned accounting can send a terminal envelope; guest has no port. */
if (parentPort) {
  try { parentPort.postMessage(await execute(workerData as ProbeWorkerInput)) }
  catch { parentPort.postMessage({ status: 'error', cases: [], error: 'interpreter-resource-or-worker-failure' }) }
  finally { parentPort.close() }
}
