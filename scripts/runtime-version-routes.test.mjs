import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

async function moduleUrl(path, imports = {}) {
  let source = await readFile(new URL(path, import.meta.url), 'utf8')
  for (const [from, to] of Object.entries(imports)) source = source.replace(`from '${from}'`, `from '${to}'`)
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
}

async function control() {
  return moduleUrl('../src/runtime-control.ts', {
    './bridge-client.js': new URL('../dist/bridge-client.js', import.meta.url).href,
    './memory-service.js': new URL('../dist/memory-service.js', import.meta.url).href,
  })
}

test('version route preserves loopback/origin/method guards and accepts only an optional complete frontend digest', async () => {
  const { registerRuntimeRoutes } = await import(await control())
  let route; const calls = []
  registerRuntimeRoutes({ register(value) { if (value.name === 'xiaoshe-desktop-version') route = value; return () => {} } }, {
    runtimeVersion: async loaded => { calls.push(loaded); return { status: 'unknown' } },
  })
  const request = async (url, options = {}) => {
    let status; let body = ''; let headers
    await route.handler(Object.assign(new EventEmitter(), { method: 'GET', headers: { host: '127.0.0.1:3080' }, url }, options), {
      writeHead(value, extra) { status = value; headers = extra; return this }, end(value = '') { body += value },
    })
    return { status, body, headers }
  }
  const path = '/xiaoshe/desktop/version'
  assert.equal((await request(path + '?frontend_identity=' + 'a'.repeat(64))).status, 200)
  assert.deepEqual(calls, ['a'.repeat(64)])
  assert.equal((await request(path)).headers['cache-control'], 'no-store')
  for (const query of ['?root=/private', '?frontend_identity=bad', '?frontend_identity=' + 'a'.repeat(64) + '&frontend_identity=' + 'b'.repeat(64)]) {
    assert.equal((await request(path + query)).status, 400)
  }
  assert.equal((await request(path, { method: 'POST' })).status, 405)
  assert.equal((await request(path, { headers: { host: 'evil.example' } })).status, 403)
  assert.equal((await request(path, { headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' } })).status, 403)
  assert.equal(calls.length, 2, 'rejected calls never invoke file hashing or subprocesses')
})

test('route failure never exposes subprocess stderr or paths', async () => {
  const { registerRuntimeRoutes } = await import(await control())
  let route; let body; let status
  registerRuntimeRoutes({ register(value) { if (value.name === 'xiaoshe-desktop-version') route = value; return () => {} } }, {
    runtimeVersion: async () => { throw new Error('failed command /Users/private/profile token=secret') },
  })
  await route.handler(Object.assign(new EventEmitter(), { method: 'GET', headers: { host: '127.0.0.1:3080' } }), {
    writeHead(value) { status = value; return this }, end(value) { body = value },
  })
  assert.equal(status, 503)
  assert.equal(JSON.parse(body).status, 'unavailable')
  assert.doesNotMatch(body, /private|secret|Users/u)
})

test('diagnostic adapter does not guess old launcher roots and deduplicates concurrent on-demand checks', async t => {
  const plugin = await import(await moduleUrl('../src/plugins/runtime-routes.ts', { '../runtime-control.js': await control() }))
  const missing = plugin.createRuntimeVersionDiagnostic({ XIAOSHE_PRODUCT_ROOT: '/no/such/root' })
  assert.equal((await missing('a'.repeat(64))).status, 'unknown')
  const root = await mkdtemp(join(tmpdir(), 'xs-version-adapter-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  await writeFile(join(root, 'scripts/runtime-version-status.mjs'), 'setTimeout(() => process.stdout.write(JSON.stringify({ schema: "xiaoshe-runtime-version/v1", status: "unknown", args: process.argv.slice(2) })), 25)')
  const adapter = plugin.createRuntimeVersionDiagnostic({ XIAOSHE_PRODUCT_ROOT: root, XIAOSHE_DSH_ROOT: root, XIAOSHE_PROFILE_ROOT: root, XIAOSHE_RUNTIME_IDENTITY: 'b'.repeat(64) })
  const first = adapter('a'.repeat(64)); const second = adapter('a'.repeat(64))
  await assert.rejects(adapter('c'.repeat(64)), /busy/u)
  const [left, right] = await Promise.all([first, second])
  assert.deepEqual(left, right)
  assert.deepEqual(left.args.slice(-2), ['--frontend-identity', 'a'.repeat(64)])
  await assert.rejects(adapter('../../private'), /invalid frontend/u)
})

test('hashing timeout is unknown with a bounded invocation, not current or leaked stderr', async () => {
  const plugin = await import(await moduleUrl('../src/plugins/runtime-routes.ts', { '../runtime-control.js': await control() }))
  const adapter = plugin.createRuntimeVersionDiagnostic({ XIAOSHE_PRODUCT_ROOT: '/fixture', XIAOSHE_DSH_ROOT: '/fixture/runtime', XIAOSHE_PROFILE_ROOT: '/fixture/profile' }, async (_command, _args, options) => {
    assert.equal(options.timeout, 30_000)
    assert.equal(options.maxBuffer, 64 * 1024)
    throw Object.assign(new Error('private subprocess stderr'), { killed: true })
  })
  const report = await adapter('a'.repeat(64))
  assert.equal(report.status, 'unknown')
  assert.deepEqual(report.reasons, ['diagnostic-timeout'])
  assert.doesNotMatch(JSON.stringify(report), /private|stderr/u)
})
