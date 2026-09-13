import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
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
