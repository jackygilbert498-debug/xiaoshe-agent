import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assessDesktopWakeVersion, captureDesktopWakeBaseline, createDesktopWakeCheck,
  desktopSourceIdentity, desktopWakeWarning, inspectDesktopWakeVersion } from '../src/wake-version.mjs'

const run = promisify(execFile)
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64)
const baseline = { shellIdentity: a, runtimeIdentity: b }
const observedFrontend = { identity: c, epoch: 2, rendererPid: 4321 }
const report = () => ({ schema: 'xiaoshe-runtime-version/v1', status: 'current',
  candidate: { state: 'observed', identity: b }, backend: { state: 'current', identity: b },
  frontend: { state: 'current', loaded_state: 'current', loaded_identity: c, source_identity: c, build_identity: c, artifact_identity: a } })
const response = value => new Response(JSON.stringify(value), { status: 200 })

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xiaoshe-wake-version-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path, text = 'fixture') => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text) }
  await put('package.json', '{"version":"0.2.0"}'); await put('src/main.mjs', 'export const version=1')
  return { root, put }
}

test('wake consistency requires captured runtime and the exact current mounted frontend, not just disk artifacts', () => {
  const result = assessDesktopWakeVersion({ baseline, shellIdentity: a, report: report(), loadedFrontend: observedFrontend })
  assert.deepEqual(result, { state: 'current', reason: 'shell-runtime-and-loaded-frontend-consistent',
    shellIdentity: a, runtimeIdentity: b, candidateIdentity: b, frontendIdentity: c,
    frontendSourceIdentity: c, frontendBuildIdentity: c, frontendArtifactIdentity: a, rendererPid: 4321, epoch: 2 })
  for (const mutate of [r => { r.backend.identity = a }, r => { r.candidate.identity = a },
    r => { r.backend.state = 'stale' }, r => { r.frontend.state = 'stale' }]) {
    const value = report(); mutate(value)
    assert.equal(assessDesktopWakeVersion({ baseline, shellIdentity: a, report: value, loadedFrontend: observedFrontend }).state, 'stale')
  }
  assert.equal(assessDesktopWakeVersion({ baseline, shellIdentity: c, report: report() }).reason, 'desktop-source-changed')
})

test('missing or malformed runtime/build facts never label an existing instance current', () => {
  for (const mutate of [r => { delete r.schema }, r => { r.status = 'unavailable' }, r => { delete r.candidate }, r => { r.backend = {} },
    r => { r.frontend.state = 'unknown' }, r => { r.frontend.build_identity = a }, r => { delete r.frontend.artifact_identity }]) {
    const value = report(); mutate(value)
    assert.notEqual(assessDesktopWakeVersion({ baseline, shellIdentity: a, report: value, loadedFrontend: observedFrontend }).state, 'current')
  }
  assert.equal(assessDesktopWakeVersion({ shellIdentity: a, report: report() }).state, 'unknown')
})

test('shell identity detects same-version module additions/edits and excludes logs outside src', async t => {
  const f = await fixture(t), initial = await desktopSourceIdentity(f.root)
  await f.put('logs/desktop-shell.jsonl', 'new log')
  assert.equal(await desktopSourceIdentity(f.root), initial)
  await f.put('src/main.mjs', 'export const version=2')
  assert.notEqual(await desktopSourceIdentity(f.root), initial)
  const edited = await desktopSourceIdentity(f.root)
  await f.put('src/new.mjs', 'export const changed=true')
  assert.notEqual(await desktopSourceIdentity(f.root), edited)
})

test('shell identity refuses unsafe links and absent source files', async t => {
  const f = await fixture(t)
  await symlink(join(f.root, 'package.json'), join(f.root, 'src/linked.json'))
  await assert.rejects(desktopSourceIdentity(f.root), /links/u)
  await assert.rejects(desktopSourceIdentity('relative'), /absolute/u)
})

test('baseline reads only the local ready identity and rejects foreign/legacy responses', async () => {
  const status = { product: '小蛇', api_version: 1, bridge: { state: 'ready' }, runtime_identity: b }
  const calls = [], fetchImpl = async (url, options) => { calls.push({ url: String(url), options }); return response(status) }
  assert.deepEqual(await captureDesktopWakeBaseline({ shellIdentity: a, baseUrl: 'http://127.0.0.1:3080/?ignored', fetchImpl }), baseline)
  assert.equal(calls[0].url, 'http://127.0.0.1:3080/xiaoshe/desktop/status')
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.redirect, 'error')
  for (const value of [{}, { ...status, api_version: 0 }, { ...status, bridge: { state: 'failed' } }]) {
    assert.equal(await captureDesktopWakeBaseline({ shellIdentity: a, baseUrl: 'http://localhost:3080/', fetchImpl: async () => response(value) }), undefined)
  }
  for (const baseUrl of ['https://external.test', 'http://user:secret@localhost:3080']) {
    assert.equal(await captureDesktopWakeBaseline({ shellIdentity: a, baseUrl, fetchImpl: () => assert.fail('must not request') }), undefined)
  }
})

test('wake queries the real version route only after shell identity matches; outages remain unknown', async t => {
  const f = await fixture(t), shellIdentity = await desktopSourceIdentity(f.root)
  const options = { appRoot: f.root, baseUrl: 'http://localhost:3080', baseline: { ...baseline, shellIdentity }, loadedFrontend: () => observedFrontend }
  const result = await inspectDesktopWakeVersion({ ...options, fetchImpl: async (url, config) => {
    assert.equal(String(url), `http://localhost:3080/xiaoshe/desktop/version?frontend_identity=${c}`)
    assert.equal(config.method, 'GET'); assert.equal(config.cache, 'no-store')
    return response(report())
  } })
  assert.equal(result.state, 'current')
  for (const fetchImpl of [async () => { throw Error('offline') }, async () => new Response('{}', { status: 404 }),
    async () => new Response('not JSON'), async () => new Response(' '.repeat(65537))]) {
    assert.equal((await inspectDesktopWakeVersion({ ...options, fetchImpl })).state, 'unknown')
  }
  await f.put('src/main.mjs', 'changed')
  assert.equal((await inspectDesktopWakeVersion({ ...options, fetchImpl: () => assert.fail('no need to request changed shell') })).state, 'stale')
})

test('missing, conflicting and unmounted observations cannot be filled in from the disk response', () => {
  for (const loadedFrontend of [undefined, {}, { ...observedFrontend, epoch: NaN }, { ...observedFrontend, rendererPid: 0 }]) {
    assert.equal(assessDesktopWakeVersion({ baseline, shellIdentity: a, report: report(), loadedFrontend }).state, 'unknown')
  }
  for (const modify of [r => { r.frontend.loaded_state = 'unknown' }, r => { delete r.frontend.loaded_identity },
    r => { r.frontend.loaded_identity = a }, r => { r.status = 'unknown' }]) {
    const r = report(); modify(r)
    assert.equal(assessDesktopWakeVersion({ baseline, shellIdentity: a, report: r, loadedFrontend: observedFrontend }).state, 'unknown')
  }
  assert.equal(assessDesktopWakeVersion({ baseline, shellIdentity: a, report: report(), loadedFrontend: { ...observedFrontend, identity: a } }).state, 'stale')
})

test('wake checks reject navigation, unmount and renderer replacement while the real HTTP request is pending', async t => {
  const f = await fixture(t), shellIdentity = await desktopSourceIdentity(f.root)
  const options = { appRoot: f.root, baseUrl: 'http://localhost:3080', baseline: { ...baseline, shellIdentity } }
  assert.equal((await inspectDesktopWakeVersion({ ...options, fetchImpl: () => assert.fail('missing loaded observation must not query') })).reason, 'loaded-frontend-unavailable')
  for (const changed of [undefined, { ...observedFrontend }, { ...observedFrontend, epoch: 3 }, { ...observedFrontend, rendererPid: 4444 }, { ...observedFrontend, identity: a }]) {
    let current = observedFrontend
    const result = await inspectDesktopWakeVersion({ ...options, loadedFrontend: () => current,
      fetchImpl: async () => { current = changed; return response(report()) } })
    assert.deepEqual(result, { state: 'unknown', reason: 'loaded-frontend-changed-during-check' })
  }
  let reads = 0
  assert.equal((await inspectDesktopWakeVersion({ ...options,
    loadedFrontend: () => ++reads === 1 ? observedFrontend : undefined,
    fetchImpl: () => assert.fail('changed while hashing must not query') })).state, 'unknown')
})

test('desktop source changed during a deferred HTTP response cannot settle as current; deleted source remains unknown', async t => {
  for (const action of ['edit', 'delete']) {
    const f = await fixture(t), shellIdentity = await desktopSourceIdentity(f.root)
    let release, requested
    const waiting = new Promise(resolve => { requested = resolve })
    const deferred = new Promise(resolve => { release = resolve })
    const pending = inspectDesktopWakeVersion({ appRoot: f.root, baseUrl: 'http://localhost:3080',
      baseline: { ...baseline, shellIdentity }, loadedFrontend: () => observedFrontend,
      fetchImpl: async () => { requested(); await deferred; return response(report()) } })
    await waiting
    if (action === 'edit') await f.put('src/main.mjs', 'export const editedDuringRequest=true')
    else await rm(join(f.root, 'src'), { recursive: true })
    release()
    const result = await pending
    assert.equal(result.state, action === 'edit' ? 'stale' : 'unknown')
    if (action === 'edit') assert.equal(result.reason, 'desktop-source-changed')
  }
})

test('concurrent second instances share one check and one warning until dismissed, without restart operations', async () => {
  let inspections = 0, warnings = 0, release
  const records = [], wait = new Promise(resolve => { release = resolve })
  const check = createDesktopWakeCheck({
    inspect: async () => { inspections++; return { state: 'stale', reason: 'desktop-source-changed' } },
    record: async result => records.push(result), warn: async options => { warnings++; assert.deepEqual(options.buttons, ['保留当前会话']); await wait },
  })
  const first = check(), second = check()
  assert.equal(first, second)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(inspections, 1); assert.equal(warnings, 1); assert.equal(records.length, 1)
  release(); assert.equal((await first).state, 'stale')
  await check(); assert.equal(inspections, 2)
})

test('current does not warn; exceptions and unknown results warn without swallowing notification failure', async () => {
  assert.equal((await createDesktopWakeCheck({ inspect: async () => ({ state: 'current' }), warn: () => assert.fail('not stale') })()).state, 'current')
  for (const inspect of [async () => { throw Error('private details') }, async () => null]) {
    let options
    assert.equal((await createDesktopWakeCheck({ inspect, warn: async value => { options = value } })()).state, 'unknown')
    assert(!JSON.stringify(options).includes('private details'))
    assert.match(options.detail, /未重启后台.*未清除任务或草稿/u)
    assert.match(options.detail, /先复制保存草稿/u)
  }
  await assert.rejects(createDesktopWakeCheck({ inspect: async () => ({ state: 'stale' }), warn: async () => { throw Error('dialog failed') } })(), /dialog failed/u)
  assert.equal(desktopWakeWarning({ state: 'stale' }).cancelId, 0)
})

async function launcherFixture(t) {
  const f = await fixture(t)
  await copyFile(fileURLToPath(new URL('../../../启动小蛇.command', import.meta.url)), join(f.root, '启动小蛇.command'))
  await f.put('scripts/start-xiaoshe-web.sh', '#!/bin/bash\nprintf "CURRENT_SOURCE_BROWSER\\n"\nprintf "%s\\n" "$@"\n')
  const old = 'apps/desktop-shell/dist-desktop/mac-arm64/小蛇.app/Contents/MacOS/小蛇'
  await f.put(old, '#!/bin/bash\nprintf "OLD_PACKAGE_MUST_NOT_RUN\\n"\nexit 98\n'); await chmod(join(f.root, old), 0o755)
  return f
}

test('source launcher missing dev Electron uses current browser flow even when old local package exists', async t => {
  const f = await launcherFixture(t)
  const result = await run('/bin/bash', [join(f.root, '启动小蛇.command')])
  assert.match(result.stdout, /CURRENT_SOURCE_BROWSER/u)
  assert.match(result.stderr, /不会转入旧打包应用/u)
  assert.doesNotMatch(result.stdout, /OLD_PACKAGE/u)
})

test('source launcher preserves dev arguments and explicit browser fallback', async t => {
  const f = await launcherFixture(t), dev = 'apps/desktop-shell/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  await f.put(dev, '#!/bin/bash\nprintf "DEV_ELECTRON\\n"\nprintf "%s\\n" "$@"\n'); await chmod(join(f.root, dev), 0o755)
  const result = await run('/bin/bash', [join(f.root, '启动小蛇.command'), 'argument with spaces'])
  assert.equal(result.stdout, `DEV_ELECTRON\n${f.root}/apps/desktop-shell\nargument with spaces\n`)
  const fallback = await run('/bin/bash', [join(f.root, '启动小蛇.command'), '--browser-fallback', 'forwarded'])
  assert.equal(fallback.stdout, 'CURRENT_SOURCE_BROWSER\nforwarded\n')
})

test('actual second-instance wiring contains no service stop, start, reload or draft mutation', async () => {
  const main = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const handler = main.slice(main.indexOf("app.on('second-instance'"), main.indexOf('app.whenReady()'))
  assert.match(handler, /showWindow\(\)/u); assert.match(handler, /checkDesktopWake/u)
  assert.doesNotMatch(handler, /controller\.(?:start|stop)|\.reload\(|\.loadURL\(|app\.(?:quit|exit|relaunch)|executeJavaScript/u)
  assert.match(main, /captureDesktopWakeBaseline/u); assert.match(main, /dialog\.showMessageBox/u)
})
