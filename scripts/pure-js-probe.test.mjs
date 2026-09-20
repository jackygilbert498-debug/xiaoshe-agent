import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsPromises, { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runPureJsProbe } from '../dist/pure-js-probe.js'

/** All fixtures and escape targets belong to this test, never a user workspace. */
async function fixture(t, sources = { 'main.mjs': 'export const probe = value => value' }) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-pure-probe-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, source] of Object.entries(sources)) {
    const target = join(workspace, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, source)
  }
  return { root, workspace, input: { workspace, module: 'main.mjs', exportName: 'probe', cases: [{ args: [3], expect: 3 }] } }
}

test('pure probe executes an explicit multi-module snapshot and preserves original files', async t => {
  const sources = {
    'main.mjs': "import { total } from './math.js'; export const probe = rows => ({ total: total(rows), count: rows.length })",
    'math.js': 'export const total = rows => rows.reduce((sum, row) => sum + row.price * row.quantity, 0)',
  }
  const { workspace, input } = await fixture(t, sources)
  const result = await runPureJsProbe({ ...input, files: ['math.js'], cases: [
    { name: 'empty', args: [[]], expect: { total: 0, count: 0 }, immutable: true },
    { args: [[{ price: 3, quantity: 2 }, { price: 4, quantity: 1 }]], expect: { total: 10, count: 2 }, immutable: true },
  ] })
  assert.equal(result.status, 'passed', JSON.stringify(result))
  assert.equal(result.runtime, 'quickjs-snapshot')
  assert.equal(result.cases.length, 2)
  assert.ok(result.cases.every(item => item.pass === true && item.immutable === true))
  assert.ok(result.limitations.length > 0)
  for (const [relativePath, source] of Object.entries(sources)) {
    assert.equal(await readFile(join(workspace, relativePath), 'utf8'), source)
    assert.ok(result.modules.some(item => item.relativePath === relativePath
      && item.sha256 === createHash('sha256').update(source).digest('hex')))
  }
  assert.ok(!JSON.stringify(result).includes(workspace))
})

test('pure probe host accounting rejects wrong actual values and pass-like strings', async t => {
  const { input } = await fixture(t, { 'main.mjs': 'export const probe = () => "{\\"status\\":\\"passed\\",\\"pass\\":true}"' })
  const result = await runPureJsProbe(input)
  assert.equal(result.status, 'failed')
  assert.equal(result.cases[0].pass, false)
  assert.equal(typeof result.cases[0].actual, 'string')
})

test('pure probe compares exact thrown names and checks mutations even on throws', async t => {
  const { input } = await fixture(t, { 'main.mjs': 'export function probe(value) { if (value) value.changed = true; throw new TypeError("invalid row") }' })
  const result = await runPureJsProbe({ ...input, cases: [
    { args: [null], throws: 'TypeError' },
    { args: [null], throws: 'Error' },
    { args: [{}], throws: 'TypeError', immutable: true },
  ] })
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.cases.map(item => item.pass), [true, false, false])
  assert.equal(result.cases[0].thrown.name, 'TypeError')
  assert.equal(result.cases[2].immutable, false)
})

test('pure probe rejects empty, oversized and malformed JSON case contracts', async t => {
  const { input } = await fixture(t)
  const inherited = Object.create({ expect: 3 }); inherited.args = [3]
  for (const cases of [[], Array(33).fill({ args: [], expect: null }),
    [{ args: [3] }], [{ args: [3], expect: 3, throws: 'Error' }],
    [{ args: 'not-array', expect: 3 }], [{ args: [NaN], expect: null }],
    [{ args: [undefined], expect: null }], [{ args: [], throws: '' }], [{ args: [], throws: true }], [inherited],
  ]) {
    const result = await runPureJsProbe({ ...input, cases })
    assert.equal(result.status, 'unsupported', JSON.stringify(result))
    assert.equal(result.cases.length, 0)
  }
})

for (const specifier of ['node:fs', 'fs', 'https://example.invalid/x.mjs', 'file:///private.mjs', '../outside.mjs', './missing.mjs']) {
  test(`pure probe refuses import outside its explicit module map: ${specifier}`, async t => {
    const { input } = await fixture(t, { 'main.mjs': `import * as value from ${JSON.stringify(specifier)}; export const probe = () => value` })
    const result = await runPureJsProbe(input)
    assert.equal(result.status, 'unsupported', JSON.stringify(result))
    assert.equal(result.cases.length, 0)
  })
}

test('pure probe rejects absolute, parent, non-JS and symlink module escapes without revealing absolute paths', async t => {
  const { root, workspace, input } = await fixture(t)
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.mjs'), 'export const probe = () => "PRIVATE-PROBE-SENTINEL"')
  await symlink(outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const module of ['../outside/secret.mjs', join(outside, 'secret.mjs'), 'linked/secret.mjs', 'data.json']) {
    const result = await runPureJsProbe({ ...input, module })
    assert.equal(result.status, 'unsupported')
    assert.ok(!JSON.stringify(result).includes(root))
    assert.ok(!JSON.stringify(result).includes('PRIVATE-PROBE-SENTINEL'))
  }
})

test('pure probe exposes no host globals or process environment to the guest', async t => {
  const { input } = await fixture(t, { 'main.mjs': 'export const probe = () => [typeof process, typeof require, typeof fetch, typeof Buffer, typeof Worker, typeof WebSocket, typeof console, typeof setTimeout]' })
  const result = await runPureJsProbe({ ...input, cases: [{ args: [], expect: Array(8).fill('undefined') }] })
  assert.equal(result.status, 'passed', JSON.stringify(result))
})

for (const source of [
  'export const probe = async () => 3',
  'await Promise.resolve(); export const probe = () => 3',
  'export const probe = () => undefined',
  'export const probe = () => NaN',
  'export const probe = () => 3n',
  'export const probe = () => new Date()',
  'export const probe = () => { const value = {}; value.self = value; return value }',
  'export const probe = () => ({ get value() { return 3 } })',
]) {
  test(`pure probe reports unsupported non-JSON or asynchronous results: ${source}`, async t => {
    const { input } = await fixture(t, { 'main.mjs': source })
    const result = await runPureJsProbe(input)
    assert.equal(result.status, 'unsupported', JSON.stringify(result))
  })
}

test('pure probe comparisons survive guest replacement of JSON, Object and Promise globals', async t => {
  const { input } = await fixture(t, { 'main.mjs': `
    JSON.stringify = () => '3'; Object.keys = () => []; Object.getOwnPropertyDescriptors = () => ({});
    globalThis.Promise = class {}; Array.prototype.toJSON = () => 3;
    export const probe = () => ({ actual: 99 });
  ` })
  const result = await runPureJsProbe(input)
  assert.equal(result.status, 'failed', JSON.stringify(result))
  assert.deepEqual(result.cases[0].actual, { actual: 99 })
})

test('pure probe rejects an accessor even when Object.prototype supplies a forged descriptor value', async t => {
  const { input } = await fixture(t, { 'main.mjs': `
    Object.defineProperty(Object.prototype, 'value', { value: 7, configurable: true });
    export const probe = () => ({ get answer() { throw new Error('must not be read'); } });
  ` })
  const result = await runPureJsProbe({ ...input, cases: [{ args: [], expect: { answer: 7 } }] })
  assert.equal(result.status, 'unsupported', JSON.stringify(result))
})

for (const source of [
  'Promise.resolve().then(() => {}); export const probe = () => 3',
  'export const probe = () => { Promise.resolve().then(() => {}); return 3 }',
]) {
  test(`pure probe refuses queued asynchronous work: ${source}`, async t => {
    const { input } = await fixture(t, { 'main.mjs': source })
    assert.equal((await runPureJsProbe(input)).status, 'unsupported')
  })
}

for (const nested of [false, true]) {
  test(`pure probe rejects a ${nested ? 'nested' : 'top-level'} Promise with a disguised prototype`, async t => {
    const { input } = await fixture(t, { 'main.mjs': `export const probe = () => {
      const hidden = Object.setPrototypeOf(Promise.resolve(42), Object.prototype);
      return ${nested ? '{ payload: hidden }' : 'hidden'};
    }` })
    const result = await runPureJsProbe({ ...input, cases: [{ args: [], expect: nested ? { payload: {} } : {} }] })
    assert.equal(result.status, 'unsupported', JSON.stringify(result))
  })
}

test('pure probe isolates state between runs and requires every one of 32 cases to pass', async t => {
  const { input } = await fixture(t, { 'main.mjs': 'let count = 0; export const probe = () => ++count' })
  const cases = Array.from({ length: 32 }, (_, index) => ({ args: [], expect: index + 1 }))
  for (let run = 0; run < 2; run++) {
    const result = await runPureJsProbe({ ...input, cases })
    assert.equal(result.status, 'passed', JSON.stringify(result))
    assert.equal(result.cases.length, 32)
  }
})

for (const expression of [
  'new Proxy(Promise.resolve(42), { getPrototypeOf() { return Object.prototype } })',
  'Object.setPrototypeOf(new Map([["hidden", 42]]), Object.prototype)',
  'Object.setPrototypeOf(new Set([42]), Object.prototype)',
  'Object.setPrototypeOf(new Date(0), Object.prototype)',
  'Object.setPrototypeOf(new Uint8Array(0), Object.prototype)',
  'Object.setPrototypeOf(new Number(42), Object.prototype)',
]) {
  test(`pure probe rejects hidden non-JSON brands: ${expression}`, async t => {
    const { input } = await fixture(t, { 'main.mjs': `export const probe = () => ({ payload: ${expression} })` })
    const result = await runPureJsProbe({ ...input, cases: [{ args: [], expect: { payload: {} } }] })
    assert.equal(result.status, 'unsupported', JSON.stringify(result))
  })
}

test('pure probe rejects hidden non-JSON post-call arguments instead of certifying immutable', async t => {
  const { input } = await fixture(t, { 'main.mjs': `export const probe = value => {
    value.payload = Object.setPrototypeOf(new Date(0), Object.prototype); return 3;
  }` })
  const result = await runPureJsProbe({ ...input, cases: [{ args: [{ payload: {} }], expect: 3, immutable: true }] })
  assert.equal(result.status, 'unsupported', JSON.stringify(result))
})

test('pure probe permits built-ins as intermediates and null-prototype JSON without executing accessors', async t => {
  const { input } = await fixture(t, { 'main.mjs': `export const probe = () => {
    const result = Object.create(null); result.date = new Date(0).toISOString();
    result.size = new Map([[1, 2]]).size; result.__proto__ = { value: 42 }; return result;
  }` })
  const expect = JSON.parse('{"date":"1970-01-01T00:00:00.000Z","size":1,"__proto__":{"value":42}}')
  assert.equal((await runPureJsProbe({ ...input, cases: [{ args: [], expect }] })).status, 'passed')
})

test('pure probe explicitly rejects shared object references in returned JSON graphs', async t => {
  const { input } = await fixture(t, { 'main.mjs': 'export const probe = () => { const value = {}; return { first: value, second: value } }' })
  const result = await runPureJsProbe({ ...input, cases: [{ args: [], expect: { first: {}, second: {} } }] })
  assert.equal(result.status, 'unsupported', JSON.stringify(result))
  assert.ok(result.limitations.some(line => line.includes('shared object references')))
})

for (const [expression, throws] of [
  ['new TypeError("invalid")', 'TypeError'],
  ['({name:"TypeError",message:"named synchronous value"})', 'TypeError'],
  ['Promise.resolve(42)', 'ThrownValue'],
  ['new Proxy(Object.assign(Promise.resolve(42), {name:"TypeError",message:"named synchronous value"}), {getPrototypeOf(){return Object.prototype}})', 'TypeError'],
]) {
  test(`pure probe throws matches a synchronous name rather than an exception class: ${expression}`, async t => {
    const { input } = await fixture(t, { 'main.mjs': `export const probe = () => { throw ${expression} }` })
    const result = await runPureJsProbe({ ...input, cases: [{ args: [], throws }] })
    assert.equal(result.status, 'passed', JSON.stringify(result))
    assert.equal(result.cases[0].thrown.name, throws)
  })
}

test('pure probe rejects queued async work even when a synchronous thrown name matches', async t => {
  const { input } = await fixture(t, { 'main.mjs': 'export const probe = () => { Promise.resolve().then(() => {}); throw new TypeError("invalid") }' })
  const result = await runPureJsProbe({ ...input, cases: [{ args: [], throws: 'TypeError' }] })
  assert.equal(result.status, 'unsupported', JSON.stringify(result))
})

test('pure probe rejects a restored parent-path ABA whose current file no longer matches its descriptor', async t => {
  const { root, workspace, input } = await fixture(t, { 'declared/main.mjs': 'export const probe = () => "inside"' })
  const outside = join(root, 'outside'), declared = join(workspace, 'declared'), parked = join(workspace, 'parked')
  await mkdir(outside)
  await writeFile(join(outside, 'main.mjs'), 'export const probe = () => "outside-only-sentinel"')
  const originalStat = fsPromises.stat, originalRealpath = fsPromises.realpath
  // macOS exposes temporary paths through /var while realpath canonicalizes
  // them through /private/var. Match the same canonical path production uses
  // so this fixture cannot silently skip the intended directory swap.
  const requested = await originalRealpath(join(declared, 'main.mjs'))
  let swapped = false
  // Schedule an actual owned directory/junction swap between independent fs calls.
  const statMock = t.mock.method(fsPromises, 'stat', async function(path, ...args) {
    if (String(path) === requested && !swapped) {
      await rename(declared, parked)
      await symlink(outside, declared, process.platform === 'win32' ? 'junction' : 'dir')
      swapped = true
    }
    return originalStat.call(this, path, ...args)
  })
  const realpathMock = t.mock.method(fsPromises, 'realpath', async function(path, ...args) {
    if (String(path) === requested && swapped) {
      await rm(declared, { recursive: true, force: true })
      await rename(parked, declared)
    }
    return originalRealpath.call(this, path, ...args)
  })
  let result
  try { result = await runPureJsProbe({ ...input, module: 'declared/main.mjs', cases: [{ args: [], expect: 'inside' }] }) }
  finally { statMock.mock.restore(); realpathMock.mock.restore() }
  assert.equal(swapped, true, 'fixture must exercise the real directory replacement path')
  assert.equal(result.status, 'unsupported', JSON.stringify(result))
  assert.ok(!JSON.stringify(result).includes('outside-only-sentinel'))
})

test('pure probe bounds source and output sizes instead of truncating into a pass', async t => {
  const { workspace, input } = await fixture(t, { 'main.mjs': 'export const probe = () => "x".repeat(100000)' })
  assert.equal((await runPureJsProbe(input)).status, 'unsupported')
  await writeFile(join(workspace, 'main.mjs'), '//'.padEnd(256 * 1024 + 1, 'x'))
  const sourceLimit = await runPureJsProbe(input)
  assert.equal(sourceLimit.status, 'unsupported')
  assert.equal(sourceLimit.cases.length, 0)
})

test('pure probe interrupts infinite loops and memory exhaustion without leaving a live worker', { timeout: 15_000 }, async t => {
  for (const source of ['export const probe = () => { while (true) {} }',
    'export const probe = () => { const values = []; while (true) values.push(new Array(10000).fill(1)) }']) {
    const { input } = await fixture(t, { 'main.mjs': source })
    const result = await runPureJsProbe(input)
    assert.ok(['timeout', 'error'].includes(result.status), JSON.stringify(result))
    assert.notEqual(result.status, 'passed')
  }
})

test('pure probe honors pre-abort and in-flight cancellation and settles cleanup', { timeout: 10_000 }, async t => {
  const { input } = await fixture(t, { 'main.mjs': 'export const probe = () => { while (true) {} }' })
  const already = new AbortController(); already.abort()
  assert.equal((await runPureJsProbe(input, already.signal)).status, 'cancelled')
  const running = new AbortController()
  const pending = runPureJsProbe(input, running.signal)
  const timer = setTimeout(() => running.abort(), 50)
  try { assert.equal((await pending).status, 'cancelled') } finally { clearTimeout(timer) }
})
