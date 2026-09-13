import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { Context } from '../../../../vendor/cordis/src/index.ts'
import { SettingsProvider } from '../../settings/src/index.ts'
import { FileSettingsProvider } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const contextUrl = pathToFileURL(resolve(here, '../../../../vendor/cordis/src/index.ts')).href
const providerUrl = pathToFileURL(resolve(here, '../src/index.ts')).href

function inheritedTypeScriptLoaderArgs() {
  const result = []
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const value = process.execArgv[index]
    if (value === '--import' || value === '--require') {
      result.push(value, process.execArgv[index + 1])
      index += 1
    } else if (value?.startsWith('--import=') || value?.startsWith('--require=')) {
      result.push(value)
    }
  }
  return result
}
const processWriterSource = `
import { access, writeFile } from 'node:fs/promises'
import { Context } from ${JSON.stringify(contextUrl)}
import { FileSettingsProvider } from ${JSON.stringify(providerUrl)}
const [filename, field, ready, release] = process.argv.slice(1)
const schema = Object.assign(value => {
  const input = value ?? {}
  return { left: input.left ?? 0, right: input.right ?? 0 }
}, { toJSON: () => ({ type: 'object' }) })
const context = new Context()
await context.plugin(FileSettingsProvider, { path: filename, watch: false })
const scope = context.settings.register('demo', schema)
await writeFile(ready, 'ready')
while (true) {
  try { await access(release); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
}
await scope.update({ [field]: 1 })
await context.fiber.dispose()
`

const schema = Object.assign((value) => {
  const input = value ?? {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('section must be an object')
  const allowed = new Set(['left', 'right'])
  if (Object.keys(input).some(key => !allowed.has(key))) throw new TypeError('unknown section field')
  const left = input.left ?? 0
  const right = input.right ?? 0
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new TypeError('section values must be integers')
  return { left, right }
}, { toJSON: () => ({ type: 'object' }) })

test('legacy update rebases inside the file lock after another provider replaces the section', async t => {
  const fixture = await openPair(t)
  await fixture.second.replace({ left: 10, right: 10 })
  await fixture.first.update({ left: 11 })
  assert.deepEqual(await storedSection(fixture.filename), { left: 11, right: 10 })
})

test('concurrent legacy updates from independent providers preserve both patches', async t => {
  const fixture = await openPair(t)
  await Promise.all([
    fixture.first.update({ left: 1 }),
    fixture.second.update({ right: 1 }),
  ])
  assert.deepEqual(await storedSection(fixture.filename), { left: 1, right: 1 })
})

test('legacy updates from independent provider processes preserve both patches', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-settings-cas-process-'))
  const filename = join(directory, 'settings.json')
  const release = join(directory, 'release')
  await writeFile(filename, JSON.stringify({ demo: { left: 0, right: 0 } }), 'utf8')
  const left = startProcessWriter(filename, 'left', join(directory, 'left-ready'), release)
  const right = startProcessWriter(filename, 'right', join(directory, 'right-ready'), release)
  t.after(() => {
    if (left.exitCode === null) left.kill('SIGKILL')
    if (right.exitCode === null) right.kill('SIGKILL')
  })
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  await Promise.all([
    waitForFile(join(directory, 'left-ready')),
    waitForFile(join(directory, 'right-ready')),
  ])
  await writeFile(release, 'release')
  const [leftExit, rightExit] = await Promise.all([exited(left), exited(right)])
  assert.equal(leftExit.code, 0, leftExit.stderr)
  assert.equal(rightExit.code, 0, rightExit.stderr)
  assert.deepEqual(await storedSection(filename), { left: 1, right: 1 })
})

test('explicit expectedRevision still rejects a stale independent provider', async t => {
  const fixture = await openPair(t)
  const firstRevision = fixture.first.getSnapshot().revision
  const staleRevision = fixture.second.getSnapshot().revision
  await fixture.first.update({ left: 1 }, firstRevision)
  await assert.rejects(
    fixture.second.update({ right: 1 }, staleRevision),
    error => error?.code === 'SETTINGS_CONFLICT' && error.expected === staleRevision && error.actual > staleRevision,
  )
  assert.deepEqual(await storedSection(fixture.filename), { left: 1, right: 0 })
})

test('settings descriptors report ready for a healthy namespace', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-settings-descriptor-ready-'))
  const context = new Context()
  await context.plugin(FileSettingsProvider, { path: join(directory, 'settings.json'), watch: false })
  t.after(async () => {
    await context.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const owner = context.inject(['settings'], ctx => { ctx.settings.register('demo', schema) })
  await owner

  assert.equal(context.settings.describe()[0].status, 'ready')
})

test('an invalid reload degrades an ordinary namespace, advances its revision, and keeps writes fail-closed', async t => {
  const stored = { demo: { left: 1, right: 2 } }
  const writes = []
  class ReloadableSettingsProvider extends SettingsProvider {
    writable = true
    async load() { return structuredClone(stored) }
    async persist(ns, section) { writes.push([ns, structuredClone(section)]) }
    reload(document) { this.publish(structuredClone(document)) }
  }

  const context = new Context()
  await context.plugin(ReloadableSettingsProvider)
  t.after(async () => { await context.fiber.dispose() })
  const observed = []
  context.on('settings/document-updated', (ns, revision) => {
    observed.push({ ns: String(ns), revision, status: context.settings.describe()[0].status })
  })
  const scope = context.settings.register('demo', schema)

  context.settings.reload({ demo: { left: 'token=must-not-leak', right: 2 } })

  assert.deepEqual(scope.get(), { left: 1, right: 2 })
  assert.equal(scope.getSnapshot().status, 'degraded')
  assert.equal(scope.getSnapshot().revision, 1)
  assert.match(scope.getSnapshot().error, /invalid/u)
  assert.doesNotMatch(scope.getSnapshot().error, /token|must-not-leak/u)
  assert.equal(context.settings.describe()[0].status, 'degraded')
  assert.deepEqual(observed, [{ ns: 'demo', revision: 1, status: 'degraded' }])

  await assert.rejects(scope.update({ right: 3 }), /degraded/u)
  await assert.rejects(scope.replace({ left: 4, right: 5 }), /degraded/u)
  assert.deepEqual(writes, [])

  context.settings.reload({ demo: { left: 4, right: 5 } })
  assert.deepEqual(scope.get(), { left: 4, right: 5 })
  assert.deepEqual(scope.getSnapshot(), {
    value: { left: 4, right: 5 }, revision: 2, status: 'ready', error: null,
  })
  assert.deepEqual(observed[1], { ns: 'demo', revision: 2, status: 'ready' })
})

test('a stale file-backed write reconciles an invalid external edit without overwriting it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-settings-invalid-race-'))
  const filename = join(directory, 'settings.json')
  await writeFile(filename, JSON.stringify({ demo: { left: 1, right: 2 } }), 'utf8')
  const context = new Context()
  await context.plugin(FileSettingsProvider, { path: filename, watch: false })
  t.after(async () => {
    await context.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const scope = context.settings.register('demo', schema)
  const invalidText = `${JSON.stringify({ demo: { left: 'invalid', right: 2 } }, null, 2)}\n`
  await writeFile(filename, invalidText, 'utf8')

  await assert.rejects(scope.update({ right: 9 }), /degraded/u)

  assert.equal(await readFile(filename, 'utf8'), invalidText)
  assert.equal(scope.getSnapshot().status, 'degraded')
  assert.equal(scope.getSnapshot().revision, 1)
  await assert.rejects(scope.replace({ left: 7, right: 8 }), /degraded/u)
  assert.equal(await readFile(filename, 'utf8'), invalidText)
})

test('a replacement namespace owner observes a write that the disposed owner already persisted', async t => {
  let releasePersist
  let reportPersistStarted
  const persistStarted = new Promise(resolvePromise => { reportPersistStarted = resolvePromise })
  const persistRelease = new Promise(resolvePromise => { releasePersist = resolvePromise })
  let stored = { demo: { left: 0, right: 0 } }

  class DelayedSettingsProvider extends SettingsProvider {
    writable = true
    async load() { return structuredClone(stored) }
    async persist(ns, section) {
      reportPersistStarted()
      await persistRelease
      stored = { ...stored, [ns]: structuredClone(section) }
    }
  }

  const context = new Context()
  await context.plugin(DelayedSettingsProvider)
  t.after(async () => { await context.fiber.dispose() })

  let first
  const firstOwner = context.inject(['settings'], (ctx) => { first = ctx.settings.register('demo', schema) })
  await firstOwner
  const write = first.update({ left: 7 })
  await persistStarted
  await firstOwner.dispose()

  let replacement
  const replacementOwner = context.inject(['settings'], (ctx) => { replacement = ctx.settings.register('demo', schema) })
  await replacementOwner
  assert.deepEqual(replacement.get(), { left: 0, right: 0 })

  releasePersist()
  await write
  assert.deepEqual(stored.demo, { left: 7, right: 0 })
  assert.deepEqual(replacement.get(), { left: 7, right: 0 })
  assert.equal(replacement.getSnapshot().revision, 1)
})

test('a replacement owner and descriptor report degraded when an old owner persists an incompatible section', async t => {
  let releasePersist
  let reportPersistStarted
  const persistStarted = new Promise(resolvePromise => { reportPersistStarted = resolvePromise })
  const persistRelease = new Promise(resolvePromise => { releasePersist = resolvePromise })
  let stored = { demo: { left: 0, right: 0 } }

  class DelayedSettingsProvider extends SettingsProvider {
    writable = true
    async load() { return structuredClone(stored) }
    async persist(ns, section) {
      reportPersistStarted()
      await persistRelease
      stored = { ...stored, [ns]: structuredClone(section) }
    }
  }
  const narrowSchema = Object.assign((value) => {
    const resolved = schema(value)
    if (resolved.left > 5) throw new TypeError('left exceeds replacement schema')
    return resolved
  }, { toJSON: () => ({ type: 'object' }) })

  const context = new Context()
  await context.plugin(DelayedSettingsProvider)
  t.after(async () => { await context.fiber.dispose() })

  let first
  const firstOwner = context.inject(['settings'], (ctx) => { first = ctx.settings.register('demo', schema) })
  await firstOwner
  const write = first.update({ left: 7 })
  await persistStarted
  await firstOwner.dispose()

  let replacement
  const replacementOwner = context.inject(['settings'], (ctx) => { replacement = ctx.settings.register('demo', narrowSchema) })
  await replacementOwner
  releasePersist()
  await write

  assert.deepEqual(replacement.get(), { left: 0, right: 0 })
  assert.equal(replacement.getSnapshot().status, 'degraded')
  assert.equal(context.settings.describe()[0].status, 'degraded')
  assert.equal(replacement.getSnapshot().revision, 1)
})

test('disposing a namespace owner silences callbacks that have not started', async t => {
  let releaseFirst
  const firstRelease = new Promise(resolvePromise => { releaseFirst = resolvePromise })
  const calls = []
  const directory = await mkdtemp(join(tmpdir(), 'dsh-settings-owner-'))
  const context = new Context()
  await context.plugin(FileSettingsProvider, { path: join(directory, 'settings.json'), watch: false })
  t.after(async () => {
    await context.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  let scope
  const owner = context.inject(['settings'], (ctx) => {
    scope = ctx.settings.register('demo', schema)
    scope.watch(async (next) => {
      calls.push(next.left)
      if (next.left === 1) await firstRelease
    })
  })
  await owner
  await scope.update({ left: 1 })
  await scope.update({ left: 2 })
  const disposal = owner.dispose()
  releaseFirst()
  await disposal
  assert.deepEqual(calls, [1])
})

async function openPair(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-settings-cas-'))
  const filename = join(directory, 'settings.json')
  await writeFile(filename, JSON.stringify({ demo: { left: 0, right: 0 } }), 'utf8')
  const firstContext = new Context()
  const secondContext = new Context()
  await firstContext.plugin(FileSettingsProvider, { path: filename, watch: false })
  await secondContext.plugin(FileSettingsProvider, { path: filename, watch: false })
  t.after(async () => {
    await Promise.all([firstContext.fiber.dispose(), secondContext.fiber.dispose()])
    await rm(directory, { recursive: true, force: true })
  })
  return {
    filename,
    first: firstContext.settings.register('demo', schema),
    second: secondContext.settings.register('demo', schema),
  }
}

async function storedSection(filename) {
  return JSON.parse(await readFile(filename, 'utf8')).demo
}

function startProcessWriter(filename, field, ready, release) {
  const child = spawn(process.execPath, [
    ...inheritedTypeScriptLoaderArgs(),
    '--input-type=module', '-e', processWriterSource,
    filename, field, ready, release,
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.setEncoding('utf8')
  child.diagnosticStderr = ''
  child.stderr.on('data', chunk => { child.diagnosticStderr += chunk })
  return child
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { await access(path); return } catch { await new Promise(resolvePromise => setTimeout(resolvePromise, 10)) }
  }
  throw new Error(`timed out waiting for ${path}`)
}

function exited(child) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, stderr: child.diagnosticStderr })
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolvePromise({ code, stderr: child.diagnosticStderr }))
  })
}
