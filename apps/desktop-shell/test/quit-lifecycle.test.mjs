import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import vm from 'node:vm'
import test from 'node:test'
import { shutdownOwnedProduct } from '../src/lifecycle.mjs'

const mainUrl = new URL('../src/main.mjs', import.meta.url)
const mainSource = await readFile(mainUrl, 'utf8')
// Exercise the actual registration, not a second implementation of quit policy.
// The outer two-space terminator cannot match the handler's nested blocks.
const registrations = [...mainSource.matchAll(/^  app\.on\('before-quit', event => \{\r?\n[\s\S]*?^  \}\)\r?$/gmu)]
assert.equal(registrations.length, 1, 'main must have exactly one complete before-quit registration')

function quitStateInitializers(source) {
  return ['quitting', 'quitCleanupComplete'].map(name => {
    const declarations = [...source.matchAll(new RegExp(`\\b(?:let|const|var)[ \\t]+${name}\\b[^;\\r\\n]*`, 'gu'))]
    assert.equal(declarations.length, 1, `main must declare ${name} exactly once`)
    assert.match(declarations[0][0], new RegExp(`^let[ \\t]+${name}[ \\t]*=[ \\t]*false[ \\t]*$`, 'u'), `${name} must actually initialize to false`)
    return `${declarations[0][0]};`
  }).join('\n')
}

const initializers = quitStateInitializers(mainSource)

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function flush() { await setImmediate() }

function fixture(t, { controllerPresent = true } = {}) {
  const browser = deferred(), service = deferred(), recorded = deferred()
  const events = [], records = [], exits = [], failures = [], clearedTimers = []
  let handler, cleanupCalls = 0, browserCalls = 0, serviceCalls = 0
  function requestQuit(origin = 'user') {
    const event = { origin, prevented: false, preventDefault() { this.prevented = true } }
    events.push(event)
    handler(event)
    return event
  }
  const app = {
    on(name, value) {
      assert.equal(name, 'before-quit')
      assert.equal(handler, undefined, 'registration must not be duplicated')
      handler = value
    },
    quit() { return requestQuit('app.quit') },
    exit(code) { exits.push(code) },
  }
  const timer = Object.freeze({ ownedTrayTimer: true })
  const context = vm.createContext({
    app,
    trayRefreshTimer: timer,
    clearTimeout(value) { clearedTimers.push(value) },
    controller: controllerPresent ? { stopOwned() { serviceCalls++; return service.promise } } : undefined,
    closeBrowser() { browserCalls++; return browser.promise },
    shutdownOwnedProduct(options) { cleanupCalls++; return shutdownOwnedProduct(options) },
    recordStartup(event, detail) { records.push({ event, detail }); return recorded.promise },
    safeMessage(error, limit) { return String(error?.message ?? error).slice(0, limit) },
    showFailure(error) { failures.push(error) },
  })
  // Execute both real lexical initializers with the real handler. A missing,
  // duplicate, or already-completed product state must not be hidden by fakes.
  new vm.Script(`${initializers}\n${registrations[0][0]}`, { filename: mainUrl.pathname }).runInContext(context, { timeout: 1_000 })
  t.after(async () => {
    browser.resolve({ closed: true })
    service.resolve({ stopped: true })
    recorded.resolve()
    await flush()
  })
  return {
    app, requestQuit, events, records, exits, failures, clearedTimers, timer,
    browser, service, recorded,
    counts: () => ({ cleanup: cleanupCalls, browser: browserCalls, service: serviceCalls }),
    resolveCleanup() { browser.resolve({ closed: true }); service.resolve({ stopped: true }) },
  }
}

test('quit VM source binding rejects missing, true, or duplicate real state declarations', () => {
  for (const name of ['quitting', 'quitCleanupComplete']) {
    const declaration = new RegExp(`\\blet[ \\t]+${name}[ \\t]*=[ \\t]*false\\b`, 'u')
    assert.throws(() => quitStateInitializers(mainSource.replace(declaration, '')), /exactly once/u)
    assert.throws(() => quitStateInitializers(mainSource.replace(declaration, `let ${name} = true`)), /initialize to false/u)
    assert.throws(() => quitStateInitializers(`${mainSource}\nlet ${name} = false\n`), /exactly once/u)
  }
})

test('actual before-quit blocks two or three repeated requests until its single cleanup completes', async t => {
  for (const repeat of [2, 3]) {
    const h = fixture(t)
    for (let index = 0; index < repeat; index++) h.requestQuit('user')
    assert.deepEqual(h.events.map(event => event.prevented), Array(repeat).fill(true), 'every repeated quit must wait, not only the first')
    await flush()
    assert.deepEqual(h.counts(), { cleanup: 1, browser: 1, service: 1 })
    assert.equal(h.records.length, 0)
    h.resolveCleanup(); await flush()
    assert.equal(h.records[0]?.event, 'shutdown-complete')
    assert.equal(h.events.length, repeat, 'cleanup completion must still await terminal logging')
    h.recorded.resolve(); await flush()
    assert.equal(h.events.length, repeat + 1, 'one final app.quit is emitted')
    assert.equal(h.events.at(-1).prevented, false, 'completed cleanup permits normal exit')
    assert.equal(h.events.filter(event => !event.prevented).length, 1)
    assert.deepEqual(h.exits, [])
  }
})

test('native driver completion app.quit cannot bypass an already pending actual shutdown', async t => {
  const h = fixture(t)
  assert.equal(h.requestQuit('system').prevented, true)
  await flush()
  assert.equal(h.app.quit().prevented, true, 'the native completion quit must wait for the first cleanup')
  assert.deepEqual(h.counts(), { cleanup: 1, browser: 1, service: 1 })
  h.resolveCleanup(); await flush()
  h.recorded.resolve(); await flush()
  assert.equal(h.events.length, 3)
  assert.deepEqual(h.events.map(event => event.prevented), [true, true, false])
})

test('actual before-quit keeps exit blocked while shutdown-complete logging is pending', async t => {
  const h = fixture(t)
  h.requestQuit()
  h.resolveCleanup(); await flush()
  assert.equal(h.records[0]?.event, 'shutdown-complete')
  assert.equal(h.app.quit().prevented, true, 'a pending terminal log is not completed shutdown')
  assert.equal(h.requestQuit('user').prevented, true)
  assert.equal(h.events.filter(event => !event.prevented).length, 0)
  h.recorded.resolve(); await flush()
  assert.deepEqual(h.events.map(event => event.prevented), [true, true, true, false])
  assert.deepEqual(h.counts(), { cleanup: 1, browser: 1, service: 1 })
})

test('one normal quit waits for both owned resources then allows one final quit after logging', async t => {
  const h = fixture(t)
  assert.equal(h.requestQuit().prevented, true)
  await flush()
  h.browser.resolve({ closed: true }); await flush()
  assert.equal(h.records.length, 0, 'browser cleanup alone cannot release the service')
  assert.equal(h.events.length, 1)
  h.service.resolve({ stopped: true }); await flush()
  assert.deepEqual(h.records.map(row => row.event), ['shutdown-complete'])
  assert.equal(h.records[0].detail.service.stopped, true)
  assert.equal(h.events.length, 1)
  h.recorded.resolve(); await flush()
  assert.deepEqual(h.events.map(event => event.prevented), [true, false])
  assert.deepEqual(h.exits, [])
  assert.deepEqual(h.failures, [])
  assert.ok(h.clearedTimers.every(value => value === h.timer))
})

test('actual shutdown failure remains explicit exit 1 without graceful success', async t => {
  const h = fixture(t)
  h.requestQuit()
  h.browser.resolve({ closed: true })
  h.service.reject(new Error('synthetic owned service cleanup failure'))
  await flush()
  assert.deepEqual(h.records.map(row => row.event), ['shutdown-failed'])
  assert.match(h.records[0].detail.message, /owned product shutdown failed/u)
  assert.deepEqual(h.exits, [], 'failure logging precedes the explicit failure exit')
  h.recorded.resolve(); await flush()
  assert.deepEqual(h.exits, [1])
  assert.equal(h.failures.length, 1)
  assert.equal(h.events.length, 1, 'failed cleanup must not use normal final app.quit')
  assert.equal(h.records.some(row => row.event === 'shutdown-complete'), false)
})

test('a repeated quit cannot turn pending shutdown-failed logging into graceful exit', async t => {
  const h = fixture(t)
  h.requestQuit()
  h.browser.resolve({ closed: true })
  h.service.reject(new Error('synthetic cleanup refusal'))
  await flush()
  assert.equal(h.records[0]?.event, 'shutdown-failed')
  assert.equal(h.requestQuit().prevented, true)
  assert.equal(h.app.quit().prevented, true)
  h.recorded.resolve(); await flush()
  assert.deepEqual(h.exits, [1])
  assert.equal(h.events.filter(event => !event.prevented).length, 0)
  assert.deepEqual(h.counts(), { cleanup: 1, browser: 1, service: 1 })
})

test('actual before-quit permits immediate normal exit when no controller was created', async t => {
  const h = fixture(t, { controllerPresent: false })
  assert.equal(h.requestQuit().prevented, false)
  await flush()
  assert.deepEqual(h.counts(), { cleanup: 0, browser: 0, service: 0 })
  assert.deepEqual(h.records, [])
  assert.deepEqual(h.exits, [])
  assert.deepEqual(h.failures, [])
})

test('rejected shutdown-complete logging preserves the existing non-hanging normal exit', async t => {
  const h = fixture(t)
  assert.equal(h.requestQuit().prevented, true)
  h.resolveCleanup(); await flush()
  assert.deepEqual(h.records.map(row => row.event), ['shutdown-complete'])
  assert.equal(h.events.length, 1)
  h.recorded.reject(new Error('synthetic log write failure'))
  await flush()
  assert.deepEqual(h.events.map(event => event.prevented), [true, false])
  assert.deepEqual(h.counts(), { cleanup: 1, browser: 1, service: 1 })
  assert.deepEqual(h.exits, [])
  assert.deepEqual(h.failures, [])
  // A normal exit does not imply that the rejected terminal log was persisted.
})

test('browser cleanup rejection still waits for owned service completion before exit 1', async t => {
  const h = fixture(t)
  h.requestQuit()
  h.browser.reject(new Error('synthetic browser cleanup failure'))
  await flush()
  assert.deepEqual(h.counts(), { cleanup: 1, browser: 1, service: 1 })
  assert.equal(h.records.length, 0, 'one rejected resource must not abandon the pending service')
  assert.deepEqual(h.exits, [])
  assert.equal(h.app.quit().prevented, true)
  h.service.resolve({ stopped: true }); await flush()
  assert.deepEqual(h.records.map(row => row.event), ['shutdown-failed'])
  assert.deepEqual(h.exits, [], 'failed shutdown still waits for its terminal log')
  h.recorded.resolve(); await flush()
  assert.deepEqual(h.exits, [1])
  assert.equal(h.failures.length, 1)
  assert.match(h.failures[0].errors[0].message, /synthetic browser cleanup failure/u)
  assert.equal(h.events.filter(event => !event.prevented).length, 0)
  assert.equal(h.records.some(row => row.event === 'shutdown-complete'), false)
})
