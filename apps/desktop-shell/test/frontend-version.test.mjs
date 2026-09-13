import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { installFrontendVersion, FRONTEND_VERSION_CHALLENGE, FRONTEND_VERSION_REPORT } from '../src/frontend-version.mjs'

const origin = 'http://127.0.0.1:49391'
const a = 'a'.repeat(64), b = 'b'.repeat(64)
const preloadSource = await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8')

function fixture(t) {
  const ipcMain = new EventEmitter(), contents = new EventEmitter(), notes = []
  let dead = false, pid = 4321, serial = 0, renderer
  contents.mainFrame = { url: origin + '/' }
  contents.isDestroyed = () => dead
  contents.getOSProcessId = () => pid
  const host = installFrontendVersion({ contents, ipcMain, origin,
    record: (event, facts) => notes.push({ event, ...facts }), nonce: () => (++serial).toString(16).padStart(48, '0') })
  t.after(host.dispose)
  const newRenderer = () => {
    const ipcRenderer = new EventEmitter(), sent = [], frame = contents.mainFrame
    let exposed
    ipcRenderer.send = (channel, value) => {
      sent.push({ channel, value })
      ipcMain.emit(channel, { sender: contents, senderFrame: frame }, value)
    }
    frame.send = (channel, value) => ipcRenderer.emit(channel, {}, value)
    const context = vm.createContext({
      require: name => { assert.equal(name, 'electron'); return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value } } } },
      process: { platform: 'darwin' }, document: { readyState: 'loading' },
      window: { addEventListener() {} }, setInterval() {}, queueMicrotask,
    })
    vm.runInContext(preloadSource, context)
    renderer = { bridge: exposed, ipcRenderer, sent, context }
    return renderer
  }
  const ready = () => { contents.emit('dom-ready'); return renderer }
  const navigate = () => contents.emit('did-start-navigation', {}, origin + '/', false, true)
  return { host, contents, ipcMain, notes, newRenderer, ready, navigate,
    kill: () => { dead = true; contents.emit('destroyed') }, setPid: value => { pid = value } }
}

test('actual preload reports only the mounted compiled UI identity after the host document challenge', t => {
  const f = fixture(t), r = f.newRenderer()
  const cleanup = r.bridge.version.mountFrontend(a)
  assert.equal(f.host.snapshot(), undefined, 'mounting before challenge is not host evidence')
  f.ready()
  assert.deepEqual(f.host.snapshot(), { identity: a, epoch: 1, rendererPid: 4321 })
  const initial = f.host.snapshot()
  assert.deepEqual(f.notes.at(-1), { event: 'frontend-version-observed', frontendIdentity: a, epoch: 1, rendererPid: 4321 })
  assert.equal(Object.keys(r.bridge.version).join(), 'mountFrontend')
  assert.equal(vm.runInContext('typeof frontendChallenge', r.context), 'string', 'the state is in the isolated preload world')
  assert(!Object.hasOwn(r.bridge, 'frontendChallenge'), 'challenge is never exposed to page-world bridge')
  cleanup(); assert.equal(f.host.snapshot(), undefined)
  cleanup(); assert.equal(f.notes.filter(note => note.event === 'frontend-version-unmounted').length, 1)
  r.bridge.version.mountFrontend(a)
  const remounted = f.host.snapshot()
  assert.deepEqual(remounted, { identity: a, epoch: 1, rendererPid: 4321 })
  assert.notEqual(remounted, initial, 'remount changes the observation handle even when all public facts match')
  assert.ok(Object.isFrozen(remounted))
  r.bridge.version.mountFrontend(a)
  assert.equal(f.host.snapshot(), remounted, 'duplicate reports retain the stable observation handle')
})

test('a ready document without a mounted root cannot claim loaded; an eventual root mount can report', t => {
  const f = fixture(t), r = f.newRenderer(); f.ready()
  assert.equal(f.host.snapshot(), undefined)
  for (const invalid of ['', 'a'.repeat(63), 'A'.repeat(64), {}, null]) r.bridge.version.mountFrontend(invalid)()
  assert.equal(f.host.snapshot(), undefined)
  r.bridge.version.mountFrontend(a); assert.equal(f.host.snapshot().identity, a)
})

test('duplicate mounts retain their own cleanup and a different hash stays conflicted for the entire document', t => {
  const f = fixture(t), r = f.newRenderer(); f.ready()
  const old = r.bridge.version.mountFrontend(a), current = r.bridge.version.mountFrontend(a)
  old(); assert.equal(f.host.snapshot().identity, a, 'old async cleanup cannot invalidate the current same-hash mount')
  const other = r.bridge.version.mountFrontend(b)
  assert.equal(f.host.snapshot(), undefined)
  other(); current(); r.bridge.version.mountFrontend(a)
  assert.equal(f.host.snapshot(), undefined, 'unmounting/re-reporting cannot erase an observed same-document conflict')
})

test('navigation invalidates immediately and old challenge/cleanup cannot certify or erase a new document', t => {
  const f = fixture(t), old = f.newRenderer(); f.ready()
  const cleanup = old.bridge.version.mountFrontend(a)
  const oldReply = old.sent.findLast(item => item.channel === FRONTEND_VERSION_REPORT).value
  f.navigate(); assert.equal(f.host.snapshot(), undefined)
  f.ipcMain.emit(FRONTEND_VERSION_REPORT, { sender: f.contents, senderFrame: f.contents.mainFrame }, oldReply)
  assert.equal(f.host.snapshot(), undefined)
  const current = f.newRenderer(); f.ready(); current.bridge.version.mountFrontend(b)
  assert.equal(f.host.snapshot().identity, b)
  cleanup(); assert.equal(f.host.snapshot().identity, b, 'old same-frame navigation reply still carries its old challenge')
})

test('foreign contents, subframes, origin, malformed payload and missing challenge are rejected', t => {
  const f = fixture(t), r = f.newRenderer(); f.ready(); r.bridge.version.mountFrontend(a)
  const reply = r.sent.findLast(item => item.channel === FRONTEND_VERSION_REPORT).value
  const actual = f.host.snapshot()
  const variants = [
    [{ sender: {}, senderFrame: f.contents.mainFrame }, reply],
    [{ sender: f.contents, senderFrame: { url: origin + '/' } }, reply],
    [{ sender: f.contents, senderFrame: f.contents.mainFrame }, { ...reply, challenge: '0'.repeat(48) }],
    [{ sender: f.contents, senderFrame: f.contents.mainFrame }, { ...reply, extra: 'ignored must not be allowed' }],
    [{ sender: f.contents, senderFrame: f.contents.mainFrame }, { ...reply, identity: 'bad' }],
  ]
  for (const [event, value] of variants) { f.ipcMain.emit(FRONTEND_VERSION_REPORT, event, value); assert.deepEqual(f.host.snapshot(), actual) }
  f.contents.mainFrame.url = 'https://foreign.invalid/'
  f.ipcMain.emit(FRONTEND_VERSION_REPORT, { sender: f.contents, senderFrame: f.contents.mainFrame }, reply)
  assert.equal(f.host.snapshot(), undefined)
})

test('host independently latches same-document identity conflict and rejects renderer PID changes or crash', t => {
  const f = fixture(t), r = f.newRenderer(); f.ready(); r.bridge.version.mountFrontend(a)
  const reply = r.sent.findLast(item => item.channel === FRONTEND_VERSION_REPORT).value
  f.ipcMain.emit(FRONTEND_VERSION_REPORT, { sender: f.contents, senderFrame: f.contents.mainFrame }, { ...reply, identity: b })
  assert.equal(f.host.snapshot(), undefined)
  f.ipcMain.emit(FRONTEND_VERSION_REPORT, { sender: f.contents, senderFrame: f.contents.mainFrame }, reply)
  assert.equal(f.host.snapshot(), undefined)
  f.navigate(); f.newRenderer(); f.ready(); r.bridge.version.mountFrontend(a)
  assert.equal(f.host.snapshot(), undefined)
  const current = f.newRenderer(); f.ready(); current.bridge.version.mountFrontend(a)
  f.setPid(4444); assert.equal(f.host.snapshot(), undefined)
  f.ready(); current.bridge.version.mountFrontend(a)
  f.contents.emit('render-process-gone'); assert.equal(f.host.snapshot(), undefined)
})

test('in-page changes preserve the current document and destruction removes only the owned IPC/listeners', t => {
  const f = fixture(t), r = f.newRenderer(); f.ready(); r.bridge.version.mountFrontend(a)
  const before = f.host.snapshot()
  f.contents.emit('did-start-navigation', {}, origin + '/#in-page', true, true)
  f.contents.emit('did-start-navigation', {}, origin + '/iframe', false, false)
  assert.deepEqual(f.host.snapshot(), before)
  const foreign = () => {}; f.ipcMain.on(FRONTEND_VERSION_REPORT, foreign)
  f.kill(); assert.equal(f.host.snapshot(), undefined)
  assert.deepEqual(f.ipcMain.listeners(FRONTEND_VERSION_REPORT), [foreign])
  assert.equal(f.contents.listenerCount('dom-ready'), 0)
})
