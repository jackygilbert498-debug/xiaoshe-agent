import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const mainUrl = new URL('../src/main.mjs', import.meta.url)
const source = await readFile(mainUrl, 'utf8')
const start = source.indexOf('function createWindow() {')
const end = source.indexOf('\nasync function installBrowserWorkspace(', start)
assert.ok(start >= 0 && end > start, 'exercise the production window constructor')
const createWindowSource = source.slice(start, end).replaceAll('import.meta.url', JSON.stringify(mainUrl.href))

/** Replace only native Electron boundaries; execute the real constructor and
 * its registered input handler, so missing installation is a regression too. */
function fixture(platform = 'win32', initialZoom = -4) {
  class Window extends EventEmitter {
    constructor() {
      super()
      this.webContents = Object.assign(new EventEmitter(), {
        zoomLevel: initialZoom, setWindowOpenHandler() {}, isDestroyed: () => false,
      })
    }
    isDestroyed() { return false }
  }
  const context = vm.createContext({
    window: undefined, BrowserWindow: Window, process: { platform, argv: [], env: {} },
    app: { isPackaged: false }, brandIcon: undefined, frontendVersion: undefined,
    browserWindowIconOptions: () => ({}), browserPreferences: () => ({}),
    join: (...parts) => parts.join('/'), dirname: value => value, fileURLToPath: value => value,
    installFrontendVersion: () => ({}), ipcMain: new EventEmitter(), ORIGIN: 'http://127.0.0.1:3080',
    interactionAcceptanceRequested: () => false, recordStartup: async () => {},
  })
  vm.runInContext(createWindowSource, context)
  const window = vm.runInContext('createWindow()', context), contents = window.webContents
  return {
    contents,
    reopen: () => vm.runInContext('createWindow()', context),
    input(overrides = {}) {
      let prevented = 0
      contents.emit('before-input-event', { preventDefault: () => { prevented++ } }, {
        type: 'keyDown', key: '=', code: 'Equal', control: platform !== 'darwin',
        meta: platform === 'darwin', shift: false, alt: false, isComposing: false,
        isAutoRepeat: false, ...overrides,
      })
      return prevented
    },
  }
}

test('ordinary Ctrl+= enlarges a shrunken product page and consumes the key exactly once', () => {
  const f = fixture()
  assert.equal(f.input(), 1)
  assert.equal(f.contents.zoomLevel, -3.5)
  assert.equal(f.input({ type: 'keyUp' }), 0)
  assert.equal(f.contents.zoomLevel, -3.5)
})

test('shifted and numpad plus use the same single increment, including a held key', () => {
  for (const key of [
    { key: '+', shift: true }, { key: '+', code: 'NumpadAdd' },
    { key: 'Add', code: 'NumpadAdd' }, { isAutoRepeat: true },
  ]) {
    const f = fixture('win32', 0)
    assert.equal(f.input(key), 1)
    assert.equal(f.contents.zoomLevel, 0.5)
  }
})

test('Cmd+= works on macOS without treating Control as Command', () => {
  const f = fixture('darwin', 0)
  assert.equal(f.input(), 1)
  assert.equal(f.contents.zoomLevel, 0.5)
  assert.equal(f.input({ meta: false, control: true }), 0)
  assert.equal(f.contents.zoomLevel, 0.5)
})

test('ordinary typing, AltGr, IME, and existing minus/reset shortcuts remain untouched', () => {
  const f = fixture('win32', 1)
  for (const key of [
    { control: false }, { control: false, meta: true }, { meta: true },
    { alt: true }, { isComposing: true }, { type: 'char' },
    { key: '-', code: 'Minus' }, { key: '0', code: 'Digit0' },
    { key: 'c', code: 'KeyC' }, { key: 'v', code: 'KeyV' },
  ]) assert.equal(f.input(key), 0)
  assert.equal(f.contents.zoomLevel, 1)
})

test('reusing the existing product window never installs duplicate zoom handlers', () => {
  const f = fixture('win32', 0)
  f.reopen(); f.reopen()
  assert.equal(f.input(), 1)
  assert.equal(f.contents.zoomLevel, 0.5)
})
