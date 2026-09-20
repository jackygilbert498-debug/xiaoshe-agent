import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertVisionCurrentGuards, observeFinishedVisionPage, observeVisionAttachmentPage, prepareVisionComposer, visionAcceptanceConfig, waitForFreshVisionComposer, writeNativeVisionClipboard } from '../src/vision-acceptance.mjs'

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'xs-vision-config-')))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const runId = randomUUID(), root = join(parent, `xiaoshe-product-acceptance-${runId}`)
  await mkdir(root, { mode: 0o700 })
  for (const name of ['dsh-home/profiles/web', 'state', 'logs', 'workspace', 'xiaoshe-windows-acceptance-user-data']) await mkdir(join(root, name), { recursive: true })
  return { runId, root, options: { temporaryRoot: parent, platform: 'darwin' }, environment: {
    XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: root,
    XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: runId, XIAOSHE_VISION_INPUT_KIND: 'path',
    DSH_HOME: join(root, 'dsh-home'), XIAOSHE_STATE_ROOT: join(root, 'state'), XIAOSHE_DSH_LOG_DIR: join(root, 'logs'),
    XIAOSHE_ACCEPTANCE_WORKSPACE: join(root, 'workspace'), XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(root, 'xiaoshe-windows-acceptance-user-data'),
    XIAOSHE_DSH_SERVICE_LABEL: `com.xiaoshe.acceptance.${runId}`, XIAOSHE_DSH_PORT: '49201' } }
}

test('vision entry requires explicit native flag and exact owned isolation', async t => {
  const f = await fixture(t)
  assert.equal(visionAcceptanceConfig([], {}), undefined)
  assert.equal(visionAcceptanceConfig([], f.environment), undefined)
  assert.throws(() => visionAcceptanceConfig(['--acceptance-vision'], {}), /isolated/u)
  const config = visionAcceptanceConfig(['--acceptance-vision'], f.environment, f.options)
  assert.equal(config.sessionId, `xiaoshe-vision-${f.runId}`)
  assert.equal(config.imagePath, join(f.root, 'workspace/input.png'))
  assert.equal(config.reportPath, join(f.root, 'vision-native.json'))
  assert(Object.isFrozen(config))
  for (const patch of [{ XIAOSHE_DESKTOP_ACCEPTANCE: '0' }, { XIAOSHE_VISION_INPUT_KIND: 'url' },
    { XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: randomUUID() }, { XIAOSHE_DSH_PORT: '3080' }]) {
    assert.throws(() => visionAcceptanceConfig(['--acceptance-vision'], { ...f.environment, ...patch }, f.options))
  }
})

test('native clipboard use requires separate explicit authorization', async t => {
  const f = await fixture(t), environment = { ...f.environment, XIAOSHE_VISION_INPUT_KIND: 'attachment' }
  assert.throws(() => visionAcceptanceConfig(['--acceptance-vision'], environment, f.options), /authorization/u)
  assert.throws(() => visionAcceptanceConfig(['--acceptance-vision'], { ...environment, XIAOSHE_VISION_CLIPBOARD_AUTHORIZED: 'true' }, f.options), /authorization/u)
  const config = visionAcceptanceConfig(['--acceptance-vision'], { ...environment, XIAOSHE_VISION_CLIPBOARD_AUTHORIZED: '1' }, f.options)
  assert.equal(config.inputKind, 'attachment')
})

test('paid input requires a fresh wire mount, policy host/agent and API budget from one live backend', () => {
  const runId = randomUUID(), sessionId = `xiaoshe-vision-${runId}`, at = '2026-09-07T01:00:00.000Z', pid = 1234567
  const fixture = () => {
    const config = { runId, sessionId, inputKind: 'attachment', workspaceRoot: '/owned/workspace', imagePath: '/owned/workspace/input.png' }
    const imageSha256 = 'a'.repeat(64), sourceHashes = { observerSourceSha256: 'b'.repeat(64), installerSourceSha256: 'c'.repeat(64) }
    return { config, imageSha256, sourceHashes,
      budget: { mounted: true, runId, mountCount: 1, mounts: [{ runId, pid, at }], mode: 'bounded_model', maxRequests: 8,
        maxOutputTokens: 2048, reservedRequests: 0, attemptedRequests: 0, deniedRequests: 0, requests: [] },
      policy: { mounted: true, runId, inputKind: config.inputKind, imageSha256, sessionIds: [sessionId], workspaceRealPath: config.workspaceRoot,
        imagePath: config.imagePath, policyDigest: 'd'.repeat(64), mounts: [
          { kind: 'host', sessionId: null, runId, pid, at, policyDigest: 'd'.repeat(64) },
          { kind: 'agent', sessionId, runId, pid, at, policyDigest: 'd'.repeat(64) }] },
      wire: { schema: 'xiaoshe-vision-wire-ledger/v1', runId, sessionId, mounted: true, observedAttempts: 0, requests: [],
        manifest: { schema: 'xiaoshe-vision-wire-manifest/v1', runId, sessionId, pid, createdAt: at, endpoint: 'https://api.deepseek.com/chat/completions', ...sourceHashes },
        mount: { schema: 'xiaoshe-vision-wire-host-mount/v1', runId, sessionId, pid, at } } }
  }
  const probes = []
  assert.equal(assertVisionCurrentGuards(fixture(), (...args) => probes.push(args)), pid)
  assert.deepEqual(probes, [[pid, 0]])
  for (const mutate of [x => x.wire = null, x => x.wire.mount.pid++, x => x.wire.manifest.runId = randomUUID(),
    x => x.wire.observedAttempts++, x => x.wire.manifest.observerSourceSha256 = 'e'.repeat(64),
    x => x.wire.mount.at = '2099-09-07T01:00:00.000Z', x => x.wire.mount.at = '2026-09-07 01:00:00.000Z',
    x => x.policy.mounts[1].sessionId = 'foreign', x => x.policy.mounts[0].pid++, x => x.budget.mounts[0].pid++,
    x => x.budget.deniedRequests++, x => x.budget.maxOutputTokens = 4096]) {
    const value = fixture(); mutate(value)
    assert.throws(() => assertVisionCurrentGuards(value, () => assert.fail('reject before PID probe')), /guards not ready/u)
  }
  for (const code of ['ESRCH', 'EPERM']) assert.throws(() => assertVisionCurrentGuards(fixture(), () => { throw Object.assign(Error('fixture'), { code }) }), /guards not ready/u)
})

test('Electron 44 PNG write is atomic, awaited and never reads or clears prior contents', async () => {
  const bytes = Buffer.from('89504e470d0a1a0a010203', 'hex')
  class Item { constructor(data) { this.data = data } }
  let writes = 0, finish
  const clipboard = {
    clear() { assert.fail('must not clear before an atomic write') },
    read() { assert.fail('must not inspect prior contents') },
    async write(items) {
      writes++
      assert.equal(items.length, 1)
      const [format, blob] = Object.entries(items[0].data)[0]
      assert.equal(format, 'electron application/osclipboard;format="public.png"')
      assert.equal(blob.type, 'image/png')
      assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes)
      await new Promise(resolve => { finish = resolve })
    },
  }
  let completed = false
  const pending = writeNativeVisionClipboard({ clipboard, ClipboardItem: Item, bytes }).then(() => { completed = true })
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  finish(); await pending
  assert.equal(writes, 1)
  await assert.rejects(writeNativeVisionClipboard({ clipboard, bytes }), /unavailable/u)
  await assert.rejects(writeNativeVisionClipboard({ clipboard, ClipboardItem: Item, bytes: Buffer.from('not png') }), /unavailable/u)
  assert.equal(writes, 1)
  await assert.rejects(writeNativeVisionClipboard({ clipboard: { ...clipboard, write: async () => { throw Error('write denied') } }, ClipboardItem: Item, bytes }), /write denied/u)
})

test('composer preparation acknowledges only the known beta notice through its button', () => {
  let clicks = 0, dialogs = [], blocker = null
  const doc = { activeElement: null, querySelectorAll: () => dialogs, querySelector: () => composer }
  const composer = { disabled: false, isConnected: true, getClientRects: () => [{}], closest: () => blocker,
    focus() { doc.activeElement = this } }
  const dialog = title => ({ querySelector: () => ({ textContent: title }), querySelectorAll: () => [{ textContent: '继续', disabled: false, click() { clicks++; dialogs = [] } }] })
  dialogs = [dialog('内测声明')]
  assert.deepEqual(prepareVisionComposer(doc), { ready: false, reason: 'beta-notice-acknowledged' })
  assert.equal(clicks, 1)
  assert.equal(prepareVisionComposer(doc).ready, true)
  dialogs = [dialog('确认外部写入')]
  assert.equal(prepareVisionComposer(doc).reason, 'other-dialog-open')
  assert.equal(clicks, 1)
  dialogs = []; blocker = { inert: true }
  assert.equal(prepareVisionComposer(doc).reason, 'composer-not-editable')
  assert.equal(blocker.inert, true, 'never remove the product accessibility guard')
  blocker = null; composer.disabled = true
  assert.equal(prepareVisionComposer(doc).ready, false)
})

test('fresh onboarding cannot finish during the empty async frame before the notice appears', async () => {
  const observed = []
  const sequence = [{ ready: true, reason: 'ready' }, { ready: false, reason: 'beta-notice-acknowledged' },
    { ready: false, reason: 'composer-not-editable' }, { ready: true, reason: 'ready' }]
  const result = await waitForFreshVisionComposer(async () => sequence.shift(), state => observed.push(state))
  assert.equal(observed.length, 4)
  assert.equal(observed[0].acknowledged, false)
  assert.deepEqual(result, { ready: true, reason: 'ready', acknowledged: true })
})

test('backend completion alone is not a rendered idle final-answer page', () => {
  let answers = [], running = true, blocked = false
  const doc = { querySelectorAll: () => answers,
    querySelector: selector => (selector.includes('stop-generation') ? running : blocked) ? {} : null }
  assert.equal(observeFinishedVisionPage(doc).ready, false)
  answers = [{ textContent: 'Earlier answer' }, { textContent: '{"rows":[]}' }]
  assert.equal(observeFinishedVisionPage(doc).ready, false)
  running = false; blocked = true
  assert.equal(observeFinishedVisionPage(doc).ready, false)
  blocked = false
  assert.deepEqual(observeFinishedVisionPage(doc), { ready: true, assistantCount: 2, answerText: '{"rows":[]}', running: false, blocked: false })
})

test('historical thumbnail proof reads only a unique decoded same-origin Blob and retains actual byte hash', async () => {
  const id = `sha256:${'a'.repeat(64)}`, bytes = Buffer.from('synthetic PNG bytes')
  const sessionId = 'owned-session'
  const img = { dataset: { attachmentId: id, sessionId }, complete: true, naturalWidth: 600, naturalHeight: 400, src: 'blob:http://127.0.0.1:49999/owned' }
  let images = [img], reads = 0
  const doc = { location: { origin: 'http://127.0.0.1:49999' }, querySelectorAll: selector => {
    assert.equal(selector, '.xsla-shell .event-user img[data-attachment-id]'); return images
  } }
  const fetchImage = async () => { reads++; return new Response(bytes, { headers: { 'content-type': 'image/png' } }) }
  const digest = bytes => createHash('sha256').update(Buffer.from(bytes)).digest()
  const result = await observeVisionAttachmentPage(doc, id, sessionId, fetchImage, digest)
  assert.equal(result.ready, true); assert.equal(result.sha256, digest(bytes).toString('hex'))
  assert.equal(result.bytes, bytes.length); assert.equal(result.attachmentId, id)
  assert.equal(result.width, 600); assert.equal(result.height, 400)
  for (const source of ['https://example.com/input.png', 'file:///tmp/input.png', 'blob:http://127.0.0.1:40000/foreign']) {
    img.src = source; assert.equal((await observeVisionAttachmentPage(doc, id, sessionId, fetchImage, digest)).ready, false)
  }
  img.src = 'blob:http://127.0.0.1:49999/owned'; img.complete = false
  assert.equal((await observeVisionAttachmentPage(doc, id, sessionId, fetchImage, digest)).ready, false)
  img.complete = true; images = [img, img]
  assert.equal((await observeVisionAttachmentPage(doc, id, sessionId, fetchImage, digest)).ready, false)
  images = [img]
  assert.equal((await observeVisionAttachmentPage(doc, 'foreign', sessionId, fetchImage, digest)).ready, false)
  assert.equal((await observeVisionAttachmentPage(doc, id, 'foreign-session', fetchImage, digest)).ready, false)
  assert.equal(reads, 1, 'no reads of drafts, foreign URLs, duplicates, or undecoded images')
  assert.equal((await observeVisionAttachmentPage(doc, id, sessionId, async () => { throw Error('revoked') }, digest)).ready, false)
})
