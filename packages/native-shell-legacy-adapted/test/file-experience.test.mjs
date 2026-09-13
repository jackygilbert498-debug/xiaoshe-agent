import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(`${source}\nexport { createFilePreviewComponent, renderWorkSurfaceDock }`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const app = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('ordinary attachment admission enforces individual, count and combined limits without rejecting empty files', () => {
  assert.equal(typeof app.validateFileBatch, 'function')
  assert.equal(app.validateFileBatch([{ name: 'empty.txt', size: 0 }]), undefined)
  assert.match(app.validateFileBatch([{ name: 'big.bin', size: 33 * 1024 * 1024 }]), /32/)
  assert.match(app.validateFileBatch(Array.from({ length: 11 }, () => ({ name: 'tiny', size: 1 }))), /10/)
  assert.match(app.validateFileBatch(Array.from({ length: 5 }, () => ({ name: 'medium', size: 30 * 1024 * 1024 }))), /128/)
  assert.ok(app.validateFileBatch([{ name: 'bad', size: -1 }]))
})

test('file tabs deduplicate the same source while keeping every execution snapshot available', () => {
  assert.equal(typeof app.materialFileTabs, 'function')
  const rows = [
    { id: 'old', type: 'file', source: 'C:\\work\\a.md', sessionId: 's', seq: 1 },
    { id: 'cmd', type: 'terminal', source: 'read a.md', sessionId: 's', seq: 2 },
    { id: 'new', type: 'file', source: 'C:\\work\\a.md', sessionId: 's', seq: 3 },
    { id: 'other', type: 'file', source: 'C:\\work\\b.md', sessionId: 's', seq: 4 },
  ]
  assert.deepEqual(app.materialFileTabs(rows).map(item => item.id), ['new', 'other'])
  assert.equal(rows.length, 4, 'view deduplication must not remove history')
})

test('static HTML preview blocks scripts, network and base URL injection without modifying the parent', () => {
  assert.equal(typeof app.staticDocumentHtml, 'function')
  const result = app.staticDocumentHtml('<script>top.bad=1</script><img src="https://example.invalid/x"><base href="https://example.invalid/">')
  assert.doesNotMatch(result, /<script>|<base |<img /)
  assert.match(result, /default-src 'none'/)
  assert.match(result, /script-src 'none'/)
  assert.match(result, /base-uri 'none'/)
  assert.match(result, /form-action 'none'/)
})

test('late preview reads are canceled and cannot publish a document after unmount', async () => {
  assert.equal(typeof app.createFilePreviewResource, 'function')
  let finish, signal
  const changes = []
  const resource = app.createFilePreviewResource({ sessionId: 'old', path: 'a.txt', onChange: value => changes.push(value),
    read: input => { signal = input.signal; return new Promise(resolve => { finish = resolve }) } })
  const load = resource.load()
  resource.dispose()
  assert.equal(signal.aborted, true)
  finish({ ok: true, value: { sessionId: 'old', path: 'a.txt', name: 'a.txt', data: new Uint8Array([65]), bytes: 1, mediaType: 'text/plain', version: 'v' } })
  await load
  assert.deepEqual(changes.map(value => value.status), ['loading'])
})

test('preview validates owner and byte receipt and revokes owned Blob URLs', async () => {
  const changes = []
  const value = { sessionId: 's', path: 'a.txt', name: 'a.txt', data: new Uint8Array([65]), bytes: 1, mediaType: 'text/plain', version: 'v' }
  const resource = app.createFilePreviewResource({ sessionId: 's', path: 'a.txt', onChange: change => changes.push(change), read: async () => ({ ok: true, value }) })
  await resource.load()
  const url = changes.at(-1).url
  assert.equal(await (await fetch(url)).text(), 'A')
  resource.dispose()
  await assert.rejects(fetch(url))
  const bad = app.createFilePreviewResource({ sessionId: 's', path: 'a.txt', onChange: change => changes.push(change), read: async () => ({ ok: true, value: { ...value, sessionId: 'other' } }) })
  await bad.load()
  assert.equal(changes.at(-1).status, 'error')
  assert.equal(changes.at(-1).url, undefined)
  bad.dispose()
})

test('document download preserves exact bytes and releases prior URLs on reload and disposal', async () => {
  let state
  const data = new TextEncoder().encode('<script>opener.bad=1</script>\n中文')
  const resource = app.createFilePreviewResource({ sessionId: 's', path: 'a.html', onChange: value => { state = value },
    read: async () => ({ ok: true, value: { sessionId: 's', path: 'a.html', name: 'a.html', data, bytes: data.length, mediaType: 'text/html', version: 'v' } }) })
  await resource.load()
  assert.deepEqual(new Uint8Array(await (await fetch(state.url)).arrayBuffer()), data)
  const oldUrl = state.url
  await resource.load()
  await assert.rejects(fetch(oldUrl))
  const { url } = state
  assert.deepEqual(new Uint8Array(await (await fetch(url)).arrayBuffer()), data)
  resource.dispose()
  await assert.rejects(fetch(url))
})

test('ready file reader offers a download and in-shell fullscreen but no blocked Blob navigation', async () => {
  const e = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)]
  let loaded, effect, cleanup
  const ref = { current: undefined }
  const react = { createElement: e, useState: initial => [loaded ?? initial, value => { loaded = value }],
    useRef: () => ref, useEffect: callback => { effect ??= callback } }
  const data = new TextEncoder().encode('完整文件\nsecond line')
  const surface = { id: 'file', sessionId: 's', source: 'a.txt', title: 'a.txt', type: 'file', status: 'ready',
    capabilities: { refresh: true, copySource: true, externalOpen: false, interactive: false },
    view: { kind: 'text', lines: [], truncated: false, totalLines: 0 } }
  const Reader = app.createFilePreviewComponent(react, async () => ({ ok: true,
    value: { sessionId: 's', path: 'a.txt', name: 'a.txt', data, bytes: data.length, mediaType: 'text/plain', version: 'v' } }), 'MarkdownText')
  Reader({ surface, reloadKey: 0 })
  cleanup = effect()
  try {
    await new Promise(resolve => setImmediate(resolve))
    const reader = Reader({ surface, reloadKey: 0 })
    assert.equal(reader.props['data-file-state'], 'ready')
    const links = nodes(reader).filter(node => node.type === 'a')
    assert.equal(links.length, 1, 'file actions must not expose a Blob navigation denied by the desktop host')
    assert.equal(links[0].props.download, 'a.txt')
    assert.deepEqual(new Uint8Array(await (await fetch(links[0].props.href)).arrayBuffer()), data)
    let fullscreen = false
    const dock = app.renderWorkSurfaceDock(e, { open: true, active: surface, items: [surface], hiddenCount: 0,
      preference: { pinnedIds: [], mode: 'watch' }, renderContent: () => reader,
      onFullscreen: () => { fullscreen = true } })
    const expand = nodes(dock).find(node => node.type === 'button' && node.children.includes('全屏阅读'))
    assert.ok(expand)
    expand.props.onClick()
    assert.equal(fullscreen, true)
    cleanup(); cleanup = undefined
    await assert.rejects(fetch(links[0].props.href))
  } finally { cleanup?.() }
})
