import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { DshTaskTimeline } from './.generated/client.mjs'

const data = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
const ref = { attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`, mediaType: 'image/png', bytes: data.length, width: 600, height: 400, name: 'current.png' }
const item = (images = [ref]) => ({ key: 'user/message:9', seq: 9, kind: 'user', text: '', images })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
function observable(value) {
  const listeners = new Set()
  return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, publish(next) { value = next; for (const fn of listeners) fn() } }
}
function fixture({ items = [item()], nodes, read } = {}) {
  const calls = []; const list = observable({ current: 'a', ids: ['a', 'b'], byId: { a: { projectionValues: nodes ? {} : { taskTimeline: { schemaVersion: 1, items } } }, b: {} } })
  const session = { getSnapshot: () => ({ nodes: nodes ?? [] }), async readAttachment(id) { calls.push(id); return read ? read(id) : { ok: true, value: { attachment: ref, data } } } }
  const timeline = new DshTaskTimeline({ list, binding: id => id === 'a' ? { session } : undefined })
  return { timeline, calls, list, session, switchTo(id) { list.publish({ ...list.getSnapshot(), current: id }) } }
}
const request = { sessionId: 'a', attachmentId: ref.attachmentId }

test('canonical timeline preserves ordered image-only references and delegates to the selected session', async t => {
  const other = { ...ref, name: 'second.png' }
  const f = fixture({ items: [item([{ ...ref, url: 'https://forbidden', data: 'private' }, other])] }); t.after(() => f.timeline.dispose())
  assert.equal(f.timeline.getSnapshot().sessionId, 'a')
  assert.deepEqual(f.timeline.getSnapshot().items[0].images, [ref, other])
  const result = await f.timeline.readImage(request)
  assert.deepEqual(f.calls, [ref.attachmentId]); assert.deepEqual(result.data, data); assert.notEqual(result.data, data)
  assert.deepEqual(result.attachment, ref)
})

test('actual projection output and DSH public user content fallback both preserve images', async t => {
  const source = await readFile(new URL('../../task-timeline/src/index.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const { foldTaskTimeline } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
  const content = [{ type: 'image', attachment: ref }, { type: 'text', text: '说明' }, { type: 'image', attachment: { ...ref, name: 'second.png' } }]
  const projected = foldTaskTimeline([{ type: 'user/message', seq: 9, time: 1, data: { source: { kind: 'user' }, content } }])
  for (const config of [{ items: projected.items }, { nodes: [{ kind: 'user', seq: 9, content }] }, { nodes: [{ kind: 'user', seq: 9, blocks: content.map(({ type, ...rest }) => ({ kind: type, ...rest })) }] }]) {
    const f = fixture(config); t.after(() => f.timeline.dispose())
    assert.equal(f.timeline.getSnapshot().items[0].text, '说明')
    assert.deepEqual(f.timeline.getSnapshot().items[0].images.map(image => image.name), ['current.png', 'second.png'])
    assert.deepEqual((await f.timeline.readImage(request)).data, data)
  }
})

test('rejects cross-session, unknown, URL/path and non-image references before any RPC', async t => {
  const f = fixture(); t.after(() => f.timeline.dispose())
  for (const input of [{ ...request, sessionId: 'b' }, { ...request, attachmentId: `sha256:${'f'.repeat(64)}` }, { ...request, attachmentId: '/private/image.png' }, { ...request, attachmentId: 'https://x/image' }]) await assert.rejects(f.timeline.readImage(input))
  assert.equal(f.calls.length, 0)
  const g = fixture({ items: [item([{ ...ref, mediaType: 'image/svg+xml' }])] }); t.after(() => g.timeline.dispose())
  assert.equal(g.timeline.getSnapshot().items[0].images, undefined)
  await assert.rejects(g.timeline.readImage(request)); assert.equal(g.calls.length, 0)
})

test('backend authorization failure and metadata/bytes/hash corruption stay failures', async t => {
  const malformed = [
    { ok: false, error: { code: 'ATTACHMENT_NOT_REFERENCED', message: '/secret/path' } },
    ...[{ ...ref, width: 601 }, { ...ref, height: 401 }, { ...ref, mediaType: 'image/jpeg' }, { ...ref, attachmentId: `sha256:${'f'.repeat(64)}` }].map(attachment => ({ ok: true, value: { attachment, data } })),
    { ok: true, value: { attachment: ref, data: data.slice(1) } },
    { ok: true, value: { attachment: ref, data: Uint8Array.from(data, byte => byte + 1) } },
  ]
  for (const result of malformed) {
    const f = fixture({ read: () => result }); t.after(() => f.timeline.dispose())
    await assert.rejects(f.timeline.readImage(request), error => !error.message.includes('/secret'))
  }
})

test('same bytes uploaded with a new name work even when original reference is outside current window', async t => {
  const rows = [item([{ ...ref, name: 'old.png' }]), ...Array.from({ length: 160 }, (_, seq) => ({ key: `status:${seq}`, seq, kind: 'status', text: 'ok' })), item()]
  const f = fixture({ items: rows, read: () => ({ ok: true, value: { attachment: { ...ref, name: 'old.png' }, data } }) }); t.after(() => f.timeline.dispose())
  assert.equal(f.timeline.getSnapshot().hasEarlier, true)
  assert.equal(f.timeline.getSnapshot().items.flatMap(row => row.images ?? []).length, 1)
  assert.equal((await f.timeline.readImage(request)).attachment.name, 'current.png')
})

test('pending reads cannot cross a session switch, even away and back to the same session', async t => {
  const wait = deferred(); const f = fixture({ read: () => wait.promise }); t.after(() => f.timeline.dispose())
  const pending = f.timeline.readImage(request)
  f.switchTo('b'); f.switchTo('a')
  wait.resolve({ ok: true, value: { attachment: ref, data } })
  await assert.rejects(pending, /会话已切换/)
  assert.deepEqual((await f.timeline.readImage(request)).data, data)
})

test('disposal cancels pending reads and later access without dispatching more requests', async () => {
  const wait = deferred(); const f = fixture({ read: () => wait.promise }); const pending = f.timeline.readImage(request)
  f.timeline.dispose(); wait.resolve({ ok: true, value: { attachment: ref, data } })
  await assert.rejects(pending); await assert.rejects(f.timeline.readImage(request)); assert.equal(f.calls.length, 1)
})
