import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { redactDesktopLogin } from '../src/desktop-login.mjs'

const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')
const syntax = ts.createSourceFile('main.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function productionFunction(name) {
  const node = syntax.statements.find(row => ts.isFunctionDeclaration(row) && row.name?.text === name)
  assert.ok(node, `missing function ${name}`)
  return node.getText(syntax)
}

for (const environment of [{}, { XIAOSHE_DESKTOP_START_HIDDEN: '1' }, { XIAOSHE_DESKTOP_ACCEPTANCE: '1' }]) {
  test(`boot loads a visible startup page before waiting for service (${JSON.stringify(environment)})`, async () => {
    const calls = []
    const target = { async loadFile(path) {
      const html = await readFile(path, 'utf8')
      assert.match(html, /正在启动小蛇/u)
      calls.push('page-loaded')
    } }
    const context = vm.createContext({
      app: { setAppUserModelId() {}, isPackaged: false, getVersion: () => 'test', getPath: () => 'test-profile' },
      applicationUserModelId() {}, recordStartup: async () => {}, nativeNotificationsEnabled: false,
      process: { platform: 'win32', env: environment }, productRootOverride: () => 'test-root', applyBranding() {},
      session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
      createWindow: () => target, showWindow() { calls.push('shown') }, join,
      desktopAppRoot: fileURLToPath(new URL('../', import.meta.url)),
      PRODUCT_URL: 'http://127.0.0.1:3080/',
      ProductServiceController: class { async start() { calls.push('service-start'); throw new Error('fixture service failure') } },
    })
    await assert.rejects(new vm.Script(`${productionFunction('boot')}\nboot()`).runInContext(context), /fixture service failure/u)
    assert.deepEqual(calls, environment.XIAOSHE_DESKTOP_ACCEPTANCE || environment.XIAOSHE_DESKTOP_START_HIDDEN
      ? ['page-loaded', 'service-start'] : ['page-loaded', 'shown', 'service-start'])
  })
}

test('startup failure is visible without native notifications and does not expose login tokens', () => {
  const dialogs = []
  const context = vm.createContext({
    process: { env: {} }, nativeNotificationsEnabled: false,
    dialog: { showMessageBoxSync(options) { dialogs.push(options) } },
    app: { getPath: () => 'test-profile' }, join, redactDesktopLogin, Error,
  })
  new vm.Script(`${productionFunction('safeMessage')}\n${productionFunction('showFailure')}\nshowFailure(new Error('Service failed: http://127.0.0.1:3080/?token=private-login'))`).runInContext(context)
  assert.equal(dialogs.length, 1)
  assert.equal(dialogs[0].type, 'error')
  assert.match(dialogs[0].detail, /Service failed/u)
  assert.match(dialogs[0].detail, /desktop-shell\.jsonl/u)
  assert.equal(JSON.stringify(dialogs).includes('private-login'), false)
})

test('automated acceptance failures never block on a native modal', () => {
  const context = vm.createContext({ process: { env: { XIAOSHE_DESKTOP_ACCEPTANCE: '1' } }, nativeNotificationsEnabled: false })
  assert.doesNotThrow(() => new vm.Script(`${productionFunction('showFailure')}\nshowFailure('fixture failure')`).runInContext(context))
})
