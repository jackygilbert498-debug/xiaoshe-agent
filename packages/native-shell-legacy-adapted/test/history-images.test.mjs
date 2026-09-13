import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { createHistoryImageResource, createHistoryImageComponent, buildUserTurnNavigation } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
const data = new Uint8Array([1, 2, 3])
const image = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 3, width: 600, height: 400, name: '图.png' }
const result = { attachment: image, data }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
function fixture(readImage = async () => result) {
  const changes = []; const created = []; const revoked = []; const calls = []
  const resource = createHistoryImageResource({ sessionId: 'a', image, readImage: async input => { calls.push(input); return readImage(input) }, onChange: value => changes.push(value) }, {
    createObjectURL(blob) { const url = `blob:owned-${created.length}`; created.push({ blob, url }); return url }, revokeObjectURL(url) { revoked.push(url) },
  })
  return { changes, created, revoked, calls, resource }
}

test('historical images use session-authorized bytes and owned blob URLs, never a remote/ref path', async () => {
  const f = fixture(); await f.resource.load()
  assert.deepEqual(f.calls, [{ sessionId: 'a', attachmentId: image.attachmentId }])
  assert.deepEqual(f.changes, [{ status: 'loading' }, { status: 'ready', url: 'blob:owned-0' }])
  assert.equal(f.created[0].blob.type, 'image/png')
  assert.deepEqual(new Uint8Array(await f.created[0].blob.arrayBuffer()), data)
  f.resource.dispose(); f.resource.dispose(); assert.deepEqual(f.revoked, ['blob:owned-0'])
})

test('unmount/session switch while awaiting bytes never creates a late Blob or updates the next session', async () => {
  const wait = deferred(); const f = fixture(() => wait.promise); const loading = f.resource.load()
  f.resource.dispose(); wait.resolve(result); await loading
  assert.equal(f.created.length, 0); assert.deepEqual(f.changes, [{ status: 'loading' }])
  await f.resource.load(); assert.equal(f.calls.length, 1)
})

test('new retry cancels an older outstanding result; only latest owns a URL', async () => {
  const first = deferred(); const second = deferred(); let count = 0
  const f = fixture(() => (++count === 1 ? first : second).promise)
  const a = f.resource.load(); const b = f.resource.load()
  second.resolve(result); await b; first.resolve(result); await a
  assert.equal(f.created.length, 1); assert.equal(f.changes.filter(row => row.status === 'ready').length, 1)
  f.resource.dispose(); assert.deepEqual(f.revoked, ['blob:owned-0'])
})

test('read/decode failure shows an error and a manual retry revokes the previous object URL', async () => {
  let attempts = 0; const f = fixture(async () => { if (++attempts === 1) throw new Error('/private/secret'); return result })
  await f.resource.load(); assert.deepEqual(f.changes.at(-1), { status: 'error' }); assert.equal(f.created.length, 0)
  await f.resource.load(); assert.equal(f.changes.at(-1).status, 'ready')
  f.resource.fail(); assert.deepEqual(f.revoked, ['blob:owned-0']); assert.deepEqual(f.changes.at(-1), { status: 'error' })
  await f.resource.load(); assert.equal(f.changes.at(-1).url, 'blob:owned-1')
  f.resource.dispose(); assert.deepEqual(f.revoked, ['blob:owned-0', 'blob:owned-1'])
})

test('metadata substitution, non-image MIME and truncated bytes never create a Blob', async () => {
  for (const value of [
    { attachment: { ...image, attachmentId: '/private/image.png' }, data },
    { attachment: { ...image, attachmentId: `sha256:${'b'.repeat(64)}` }, data },
    { attachment: { ...image, width: 601 }, data },
    { attachment: { ...image, mediaType: 'image/svg+xml' }, data },
    { attachment: image, data: data.slice(1) },
  ]) {
    const f = fixture(async () => value); await f.resource.load()
    assert.deepEqual(f.changes.at(-1), { status: 'error' }); assert.equal(f.created.length, 0); f.resource.dispose()
  }
})

test('non-Blob URL factories are never presented as historical image sources', async () => {
  const changes = []
  const resource = createHistoryImageResource({ sessionId: 'a', image, readImage: async () => result, onChange: value => changes.push(value) }, {
    createObjectURL: () => 'https://forbidden/image.png', revokeObjectURL: () => assert.fail('not an owned Blob'),
  })
  await resource.load(); assert.deepEqual(changes.at(-1), { status: 'error' }); resource.dispose()
})

function reactHarness() {
  const cells = []; let cursor = 0; const pending = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) { const index = cursor++; cells[index] ??= { value: initial }; return [cells[index].value, value => { cells[index].value = typeof value === 'function' ? value(cells[index].value) : value }] },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial } },
    useEffect(effect, deps) { const index = cursor++; const old = cells[index]; if (!old || JSON.stringify(old.deps) !== JSON.stringify(deps)) { old?.cleanup?.(); cells[index] = { deps }; pending.push(() => { cells[index].cleanup = effect() }) } },
  }
  return { react, render(component, props) { cursor = 0; const tree = component(props); pending.splice(0).forEach(fn => fn()); return tree }, dispose() { cells.forEach(cell => cell.cleanup?.()) } }
}
const find = (node, type) => node && typeof node === 'object' ? node.type === type ? node : node.children?.map(child => find(child, type)).find(Boolean) : undefined

test('real component exposes stable session/ref selectors, intrinsic dimensions, accessible error and retry', async () => {
  const h = reactHarness(); const calls = []
  const Component = createHistoryImageComponent(h.react, async input => { calls.push(input); return result })
  const props = { sessionId: 'session-a', image, ordinal: 1 }
  assert.equal(h.render(Component, props).props['data-image-state'], 'loading')
  await new Promise(resolve => setImmediate(resolve))
  let tree = h.render(Component, props); const img = find(tree, 'img')
  assert.match(img.props.src, /^blob:/); assert.equal(img.props['data-attachment-id'], image.attachmentId)
  assert.equal(img.props['data-session-id'], 'session-a'); assert.equal(img.props.alt, '图.png')
  assert.equal(img.props.width, 600); assert.equal(img.props.height, 400)
  img.props.onError(); tree = h.render(Component, props)
  assert.equal(tree.props['data-image-state'], 'error'); assert.equal(find(tree, 'img'), undefined)
  assert.equal(find(tree, 'button').props['aria-label'], '重试加载图.png')
  find(tree, 'button').props.onClick(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.render(Component, props).props['data-image-state'], 'ready'); assert.equal(calls.length, 2)
  const next = h.render(Component, { ...props, sessionId: 'session-b' })
  assert.equal(find(next, 'img'), undefined, 'previous session URL is not rendered while the new effect starts')
  h.dispose()
})

test('image-only history remains a navigable user turn and gallery wiring is session-scoped', () => {
  assert.deepEqual(buildUserTurnNavigation([{ key: 'user:9', kind: 'user', text: '', images: [image, image] }]), [{ key: 'user:9', eventIndex: 0, ordinal: 1, preview: '图片 2 张' }])
  assert.match(source, /timeline\.sessionId !== currentId/)
  assert.match(source, /'data-event-key': item\.key/)
  assert.match(source, /createHistoryImageComponent\(react, input => ctx\.taskTimeline\.readImage\(input\)\)/)
})
