import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsPromises, { mkdir, mkdtemp, realpath, readFile, writeFile, rm, rename, symlink, copyFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installVisionWireObservation, readVisionWireLedger } from './vision-wire-install.mjs'
import * as plugin from './vision-wire-install.mjs'
import { Context } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { LlmRuntime } from '../../runtime/DSH/packages/llm/llm/lib/index.js'
import { ENDPOINT } from './vision-wire-observer.mjs'

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'xs-vision-wire-mount-')))
  t.after(() => rm(parent, { recursive: true, force: false }))
  const runId = randomUUID(), acceptanceRoot = join(parent, `xiaoshe-product-acceptance-${runId}`)
  await mkdir(acceptanceRoot, { mode: 0o700 })
  const config = { acceptanceRoot, runId, sessionId: `xiaoshe-vision-${runId}` }, calls = []
  const original = async (...args) => { calls.push(args); return new Response('explicit offline fixture') }
  const target = { fetch: original }
  const init = { method: 'POST', headers: { 'x-deepseek-harness-session-id': config.sessionId, authorization: 'DO_NOT_PERSIST_FIXTURE_SECRET' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', max_tokens: 2048, stream: true, messages: [{ role: 'system', content: 'PRIVATE_SYNTHETIC_SYSTEM' }, { role: 'user', content: 'PRIVATE_SYNTHETIC_TASK' }] }) }
  return { parent, config, calls, original, target, init, directory: join(acceptanceRoot, 'wire-observations') }
}

test('mount is actual-current-process durable, initial ledger is empty, official records precede untouched fixture dispatch', async t => {
  const f = await fixture(t), observer = installVisionWireObservation(f.config, { fetchTarget: f.target })
  t.after(() => observer.dispose())
  assert.notEqual(f.target.fetch, f.original, 'synchronous endpoint interception precedes async mount')
  await observer.ready
  const before = await readVisionWireLedger(f.config)
  assert.equal(before.mount.pid, process.pid); assert.equal(before.observedAttempts, 0)
  assert.equal(before.manifest.runId, f.config.runId)
  assert.match(before.manifest.observerSourceSha256, /^[a-f0-9]{64}$/)
  await f.target.fetch('http://127.0.0.1:12345/health', f.init)
  assert.equal((await observer.snapshot()).observedAttempts, 0)
  await f.target.fetch(ENDPOINT, f.init)
  assert.equal(f.calls[1][1], f.init)
  const after = await observer.snapshot(); assert.equal(after.observedAttempts, 1)
  const raw = await readFile(join(f.directory, 'request-1.json'), 'utf8')
  assert.doesNotMatch(raw, /PRIVATE_|DO_NOT_PERSIST|authorization/)
  await observer.dispose(); await observer.dispose(); assert.equal(f.target.fetch, f.original)
})

test('exclusive request persistence failure does not fetch or erase evidence, and restart cannot reset a prior ledger', async t => {
  const f = await fixture(t), observer = installVisionWireObservation(f.config, { fetchTarget: f.target })
  await observer.ready
  await writeFile(join(f.directory, 'request-1.json'), '{"owned_test_partial":true}', { flag: 'wx', mode: 0o600 })
  await assert.rejects(f.target.fetch(ENDPOINT, f.init), { code: 'observation_persist_failed' }); assert.equal(f.calls.length, 0)
  assert.match(await readFile(join(f.directory, 'request-1.json'), 'utf8'), /owned_test_partial/)
  await assert.rejects(observer.snapshot(), { code: 'invalid_observation' })
  await observer.dispose()
  const restarted = installVisionWireObservation(f.config, { fetchTarget: f.target })
  await assert.rejects(restarted.ready)
  await assert.rejects(f.target.fetch(ENDPOINT, f.init), { code: 'observation_persist_failed' }); assert.equal(f.calls.length, 0)
  await assert.rejects(restarted.dispose())
  assert.equal(f.target.fetch, f.original)
})

test('reader rejects changed host identity, injected sensitive fields, request gaps and symlinked records', async t => {
  const f = await fixture(t), observer = installVisionWireObservation(f.config, { fetchTarget: f.target })
  t.after(() => observer.dispose()); await observer.ready; await f.target.fetch(ENDPOINT, f.init)
  const mountPath = join(f.directory, 'host-mounted.json'), mount = JSON.parse(await readFile(mountPath))
  await writeFile(mountPath, JSON.stringify({ ...mount, pid: mount.pid + 1 }), { mode: 0o600 })
  await assert.rejects(observer.snapshot(), { code: 'invalid_mount' })
  await writeFile(mountPath, JSON.stringify(mount), { mode: 0o600 })
  const requestPath = join(f.directory, 'request-1.json'), row = await readFile(requestPath, 'utf8')
  await writeFile(requestPath, JSON.stringify({ ...JSON.parse(row), headers: 'DO_NOT_RETURN' }), { mode: 0o600 })
  await assert.rejects(observer.snapshot(), { code: 'invalid_observation' })
  await writeFile(requestPath, row, { mode: 0o600 })
  const gapPath = join(f.directory, 'request-3.json'); await copyFile(requestPath, gapPath)
  await assert.rejects(observer.snapshot(), { code: 'invalid_attempt_sequence' }); await rm(gapPath)
  await rm(requestPath); await symlink(mountPath, requestPath)
  await assert.rejects(observer.snapshot(), { code: 'unsafe_record' })
})

test('lost fetch ownership is a cleanup error and never overwrites another owner', async t => {
  const f = await fixture(t), observer = installVisionWireObservation(f.config, { fetchTarget: f.target })
  await observer.ready
  const replacement = async () => new Response('other explicit fixture')
  f.target.fetch = replacement
  await assert.rejects(observer.dispose(), { code: 'fetch_owner_changed' })
  assert.equal(f.target.fetch, replacement)
})

test('manifest and mount times require canonical ISO strings, not merely Date.parse-compatible values', async t => {
  const f = await fixture(t), observer = installVisionWireObservation(f.config, { fetchTarget: f.target })
  t.after(() => observer.dispose()); await observer.ready
  const manifestPath = join(f.directory, 'manifest.json'), mountPath = join(f.directory, 'host-mounted.json')
  const manifest = JSON.parse(await readFile(manifestPath)), mount = JSON.parse(await readFile(mountPath))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, createdAt: Date.parse(manifest.createdAt) }))
  await assert.rejects(observer.snapshot(), { code: 'invalid_mount' })
  await writeFile(manifestPath, JSON.stringify(manifest))
  for (const at of [mount.at.replace('T', ' '), mount.at.replace('Z', '+00:00')]) {
    await writeFile(mountPath, JSON.stringify({ ...mount, at })); await assert.rejects(observer.snapshot(), { code: 'invalid_mount' })
  }
})

test('a replaced path cannot be accepted using its still-open old file descriptor', async t => {
  const f = await fixture(t), observer = installVisionWireObservation(f.config, { fetchTarget: f.target })
  t.after(() => observer.dispose()); await observer.ready
  const target = join(f.directory, 'manifest.json'), original = await readFile(target)
  const originalOpen = fsPromises.open; let replaced = false
  const mock = t.mock.method(fsPromises, 'open', async function (path, ...args) {
    const handle = await originalOpen.call(this, path, ...args)
    if (path === target && !replaced) {
      replaced = true
      await rename(target, join(f.config.acceptanceRoot, 'old-manifest-fixture.json'))
      await writeFile(target, original, { flag: 'wx', mode: 0o600 })
    }
    return handle
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(observer.snapshot(), { code: 'record_changed' }); assert.equal(replaced, true)
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
})

test('real Cordis plugin mount gates official fixture transport and scope disposal restores only its own fetch', async t => {
  const f = await fixture(t), ctx = new Context()
  new LlmRuntime(ctx)
  t.mock.method(globalThis, 'fetch', f.original)
  const priorFetch = globalThis.fetch
  t.after(() => ctx.fiber.dispose())
  const loaded = await ctx.plugin(plugin, f.config)
  const before = await readVisionWireLedger(f.config)
  assert.equal(before.observedAttempts, 0); assert.equal(before.mount.pid, process.pid)
  assert.notEqual(globalThis.fetch, priorFetch)
  await globalThis.fetch(ENDPOINT, f.init)
  assert.equal((await readVisionWireLedger(f.config)).observedAttempts, 1)
  await loaded.dispose()
  assert.equal(globalThis.fetch, priorFetch)
  // A stale ledger cannot be remounted or reset; failed plugin application is
  // not silently considered a successful mounted observer.
  await assert.rejects(async () => { await ctx.plugin(plugin, f.config) })
  assert.equal(globalThis.fetch, priorFetch)
})
