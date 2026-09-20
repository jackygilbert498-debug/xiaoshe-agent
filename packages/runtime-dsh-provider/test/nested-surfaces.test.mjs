import assert from 'node:assert/strict'
import test from 'node:test'
import { nestedSurfaceFixture, projectDshWorkSurfaces, materialJourneyEvidence } from './helpers/nested-surfaces.mjs'

test('validated file material titles lead with basename and distinguish only different source paths', () => {
  const read = (id, path) => ({ kind: 'tool-result', callId: id, seq: 1, time: 1,
    callView: { title: `Read ${path} (lines 12-13)` },
    resultView: { card: 'read', path, lines: [{ number: 12, text: 'actual' }], totalLines: 80 } })
  const left = 'C:\\Users\\fixture\\project\\client\\src\\index.ts'
  const right = 'C:\\Users\\fixture\\project\\server\\src\\index.ts'
  const nodes = [read('left', left), read('right', right), read('repeat', left), read('other', 'docs/requirements.md'),
    { kind: 'tool-result', callId: 'edit', seq: 2, time: 2, resultView: { card: 'diff', title: `Edit ${left}`, diffs: [{ path: left, oldText: 'before', newText: 'after' }] } },
    { kind: 'tool-result', callId: 'shell', seq: 3, time: 3, callView: { card: 'terminal', title: 'Get-Content C:\\project\\data.txt', cwd: 'C:\\project' }, resultView: { card: 'terminal', output: 'ok' } }]
  const surfaces = projectDshWorkSurfaces('s1', 'C:\\Users\\fixture\\project', { nodes })
  assert.equal(surfaces.find(row => row.callId === 'left').title, 'index.ts · client/src · 读取')
  assert.equal(surfaces.find(row => row.callId === 'right').title, 'index.ts · server/src · 读取')
  assert.equal(surfaces.find(row => row.callId === 'repeat').title, 'index.ts · client/src · 读取')
  assert.equal(surfaces.find(row => row.callId === 'other').title, 'requirements.md · 读取')
  assert.equal(surfaces.find(row => row.callId === 'edit').title, 'index.ts · client/src · 改动')
  assert.equal(surfaces.find(row => row.callId === 'shell').title, 'Get-Content C:\\project\\data.txt')
  assert.equal(surfaces.find(row => row.callId === 'left').source, left)
  assert.equal(surfaces.length, nodes.length)
})

test('multi-file diffs retain all paths and disclose that the filename is not the whole change', () => {
  const diffs = [{ path: '/project/a.txt', oldText: 'a', newText: 'b' }, { path: '/project/b.txt', oldText: 'c', newText: 'd' }]
  const [surface] = projectDshWorkSurfaces('s1', '/project', { nodes: [{ kind: 'tool-result', callId: 'edit',
    resultView: { card: 'diff', title: 'Edit /project/a.txt', diffs } }] })
  assert.equal(surface.title, 'a.txt · 改动（2 个文件）')
  assert.deepEqual(surface.view.diffs, diffs)
  assert.equal(surface.source, '/project/a.txt')
})

test('mixed native/PTC journey produces actual read, edit and terminal evidence', async () => {
  const result = await materialJourneyEvidence()
  assert.deepEqual(result.surfaces.items.map(item => item.view.kind), ['text', 'diff', 'terminal'])
  assert.equal(result.evidence.genericChatNodes, 0)
  assert.deepEqual(result.evidence.nestedCalls, ['edit'])
})

for (const mode of ['native', 'ptc']) test(`product with generic chat disabled retains ${mode} tool materials after files are removed`, async t => {
  const f = await nestedSurfaceFixture({ genericUi: false, mode })
  t.after(() => f.dispose())
  await f.seed('historical.txt', 'durable before')
  assert.equal(f.project(await f.history()).length, 0)
  if (mode === 'native') {
    await f.native('read', { file_path: 'historical.txt' })
    await f.native('edit', { file_path: 'historical.txt', old_string: 'before', new_string: 'after' })
  } else await f.code("await tools.read({file_path:'historical.txt'}); return await tools.edit({file_path:'historical.txt',old_string:'before',new_string:'after'})")
  const surfaces = f.project(await f.history())
  assert.equal(f.face.getSnapshot().nodes.length, 0, 'generic chat really is absent, like the product composition')
  assert.deepEqual(surfaces.map(row => row.view.kind), ['text', 'diff'])
  assert.equal(f.center.getSnapshot().deliverables.length, 2)
  await f.removeOwnedFiles()
  assert.deepEqual(f.project(await f.history()), surfaces, 'history presenters do not reopen deleted files')
})

test('real successful Code Mode read and edit populate the workbench without feature contributions', async t => {
  const f = await nestedSurfaceFixture()
  t.after(() => f.dispose())
  await f.seed('answer.txt', 'before\n')
  assert.equal(f.registry.getSnapshot().items.length, 0)
  const result = await f.code("await tools.read({file_path:'answer.txt'}); await tools.edit({file_path:'answer.txt',old_string:'before',new_string:'after'}); return 'done'")
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(await f.read('answer.txt'), 'after\n')
  const entries = await f.history()
  assert.deepEqual(entries.filter(row => row.event.type === 'tool/ptc-dispatch').map(row => row.event.data.name), ['read', 'edit'])
  const surfaces = f.project(entries)
  assert.deepEqual(f.face.getSnapshot().nodes[0].subCalls.map(row => row.call.name), ['read', 'edit'], 'the generic DSH raw child-call seam also remains wired')
  assert.deepEqual(surfaces.map(row => row.view.kind), ['text', 'diff'])
  assert.deepEqual(surfaces[0].view.lines, [{ number: 1, text: 'before' }])
  assert.match(surfaces[1].view.diffs[0].oldText, /before/u)
  assert.match(surfaces[1].view.diffs[0].newText, /after/u)
  assert.equal(surfaces.every(row => row.status === 'ready' && row.trust === 'workspace'), true)
  assert.equal(f.center.getSnapshot().deliverables.length, 2)
  assert.deepEqual(f.project(entries, { incremental: true }), surfaces, 'live assembly and history replay agree')
  assert.deepEqual(f.project(entries), surfaces, 'replay does not duplicate materials')
  assert.deepEqual(f.project([]), [], 'a window replacement clears prior material nodes')
  assert.deepEqual(f.project(entries), surfaces, 'rehydration restores only the current window')
  f.list.publish({ ...f.list.getSnapshot(), current: 'different-session' })
  assert.equal(f.registry.getSnapshot().items.length, 0)
  assert.equal(f.center.getSnapshot().deliverables.length, 0)
})

test('new nested write shows the successful tool presenter diff matching the committed file', async t => {
  const f = await nestedSurfaceFixture()
  t.after(() => f.dispose())
  const result = await f.code("return await tools.write({file_path:'created.txt',content:'new content'})")
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(await f.read('created.txt'), 'new content')
  const [surface] = f.project(await f.history())
  assert.equal(surface.view.kind, 'diff')
  assert.deepEqual(surface.view.diffs, [{ path: 'created.txt', oldText: null, newText: 'new content' }])
  assert.equal(surface.source, 'created.txt')
  assert.equal(surface.status, 'ready')
  assert.equal(surface.trust, 'workspace')
})

test('real nested foreground shell publishes bounded terminal output with actual exit status', async t => {
  const f = await nestedSurfaceFixture()
  t.after(() => f.dispose())
  await f.enableShell()
  const command = JSON.stringify(f.terminalCommand('materials-terminal-ok'))
  const result = await f.code(`return await tools.${f.shellTool}({command:${command},description:'Test local terminal material'})`)
  assert.equal(result.isError, false, JSON.stringify(result))
  const [surface] = f.project(await f.history())
  assert.equal(surface.view.kind, 'terminal')
  assert.match(surface.view.output, /materials-terminal-ok/u)
  assert.equal(surface.view.exitCode, 0)
  assert.equal(surface.capabilities.interactive, false)
  assert.equal(surface.capabilities.externalOpen, false)
})

test('failed nested edit never shows requested replacement as an applied diff', async t => {
  const f = await nestedSurfaceFixture()
  t.after(() => f.dispose())
  await f.seed('untouched.txt', 'original')
  await f.code("return await tools.edit({file_path:'untouched.txt',old_string:'missing',new_string:'must-not-appear-as-applied'})")
  assert.equal(await f.read('untouched.txt'), 'original')
  const surfaces = f.project(await f.history())
  assert.equal(surfaces.some(row => row.view.kind === 'diff' || row.status === 'ready'), false)
  assert.doesNotMatch(JSON.stringify(surfaces), /must-not-appear-as-applied/u)
})

test('orphan and mismatched nested results cannot claim a successful presenter view', async t => {
  const f = await nestedSurfaceFixture()
  t.after(() => f.dispose())
  await f.seed('observed.txt', 'observed')
  await f.code("return await tools.read({file_path:'observed.txt'})")
  const entries = await f.history()
  const actual = f.session.snapshotEvents().find(event => event.type === 'tool/ptc-dispatch')
  const rows = []
  for (const overrides of [
    { subCallId: 'orphan' }, { rootCallId: 'different-root' }, { parentCallId: 'different-parent' },
    { arguments: { file_path: 'different.txt' } }, { name: 'write' },
  ]) rows.push({ type: 'event', event: { ...actual, seq: entries.length + rows.length, data: { ...actual.data, ...overrides } } })
  assert.equal(f.project(rows).length, 0, 'a detached result is not a work material')
  const withoutResult = entries.filter(row => row.event !== actual && !(row.event.type === actual.type && row.event.seq === actual.seq))
  assert.equal(f.project([...withoutResult, ...rows]).length, 0, 'mismatched results cannot settle a legitimate start')
  assert.equal(f.project(entries).length, 1)
  const legacy = entries.map(row => ({ ...row, event: { ...row.event, type: row.event.type.replace('tool/ptc-dispatch', 'tool/code-dispatch') } }))
  assert.deepEqual(f.project(legacy), f.project(entries), 'old durable event names retain the same product material')
})

test('raw replay metadata retains web surfaces and rejects an unstarted nested call', async t => {
  const f = await nestedSurfaceFixture({ genericUi: false })
  t.after(() => f.dispose())
  const entry = (type, data, seq, surfaceOp) => ({ type: 'event', event: { type, data, seq, time: 1000 + seq, ...(surfaceOp ? { surfaceOp } : {}) } })
  const root = entry('tool/call', { callId: 'web', name: 'web_fetch', arguments: '{"url":"https://example.com/"}' }, 0)
  const result = entry('tool/result', { message: { source: { callId: 'web' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'fixture body' }], isError: false }] }, meta: { url: 'https://example.com/', statusCode: 200, truncated: false } }, 1, 'append')
  assert.equal(f.project([root, result]).length, 1)
  const nested = { rootCallId: 'absent', parentCallId: 'absent', subCallId: 'absent:ptc:1', name: 'web_fetch', arguments: { url: 'https://example.com/' } }
  assert.equal(f.project([entry('tool/ptc-dispatch-start', nested, 2), entry('tool/ptc-dispatch', { ...nested, content: [], isError: false, meta: result.event.data.meta }, 3)]).length, 0)
})

test('work materials reject URL-shaped file sources and do not label traversal as workspace trust', () => {
  const result = path => ({ kind: 'tool-result', callId: 'read', seq: 1, time: 1, isError: false,
    resultView: { card: 'read', path, lines: [{ number: 1, text: 'public sample' }], totalLines: 1 } })
  for (const path of ['https://user:secret@example.test/a?token=private', 'file:///C:/private.txt', 'javascript:alert(1)', 'C:\\a\u0000b']) {
    assert.deepEqual(projectDshWorkSurfaces('s1', 'C:/workspace', { nodes: [result(path)] }), [])
  }
  for (const path of ['../outside.txt', 'C:/workspace/../outside.txt']) {
    const [surface] = projectDshWorkSurfaces('s1', 'C:/workspace', { nodes: [result(path)] })
    assert.notEqual(surface.trust, 'workspace')
    assert.equal(surface.capabilities.externalOpen, false)
  }
})

test('material projection bounds hostile presenter lines, diffs and terminal output', () => {
  const huge = '文'.repeat(300_000)
  const surfaces = projectDshWorkSurfaces('s1', 'C:/workspace', { nodes: [
    { kind: 'tool-result', callId: 'read', resultView: { card: 'read', path: 'file.txt', lines: Array.from({ length: 3000 }, (_, number) => ({ number, text: huge })), totalLines: 3000 } },
    { kind: 'tool-result', callId: 'diff', resultView: { card: 'diff', diffs: Array.from({ length: 30 }, () => ({ path: 'file.txt', oldText: huge, newText: huge })) } },
    { kind: 'tool-result', callId: 'terminal', resultView: { card: 'terminal', output: huge, exitCode: 0 } },
  ] })
  assert.equal(surfaces.length, 3)
  for (const surface of surfaces) assert.equal(surface.view.truncated, true)
  const read = surfaces.find(row => row.view.kind === 'text').view
  assert.ok(read.lines.length <= 2000)
  assert.ok(Buffer.byteLength(read.lines.map(line => line.text).join('')) <= 512 * 1024)
  const diff = surfaces.find(row => row.view.kind === 'diff').view
  assert.ok(diff.diffs.length <= 24)
  assert.ok(Buffer.byteLength(diff.diffs.map(row => (row.oldText ?? '') + row.newText).join('')) <= 384 * 1024)
  assert.ok(Buffer.byteLength(surfaces.find(row => row.view.kind === 'terminal').view.output) <= 256 * 1024)
})

for (const [name, lines] of [
  ['one overlong line', [{ number: 1, text: 'a'.repeat(600_000) }]],
  ['partial final multibyte line', Array.from({ length: 6 }, (_, index) => ({ number: index + 1, text: '文'.repeat(30_000) }))],
]) test(`read material discloses truncation for ${name} even when no row was dropped`, () => {
  const [surface] = projectDshWorkSurfaces('s1', 'C:/workspace', { nodes: [{
    kind: 'tool-result', callId: 'long-read', seq: 1, time: 1, isError: false,
    resultView: { card: 'read', path: 'bounded.txt', lines, totalLines: lines.length },
  }] })
  assert.equal(surface.view.lines.length, lines.length)
  assert.ok(surface.view.lines.at(-1).text.length < lines.at(-1).text.length)
  assert.ok(Buffer.byteLength(surface.view.lines.map(row => row.text).join('')) <= 512 * 1024)
  assert.equal(surface.view.truncated, true)
})

test('a complete short read material does not claim truncation', () => {
  const [surface] = projectDshWorkSurfaces('s1', 'C:/workspace', { nodes: [{
    kind: 'tool-result', callId: 'short-read', seq: 1, time: 1, isError: false,
    resultView: { card: 'read', path: 'short.txt', lines: [{ number: 1, text: 'whole result' }], totalLines: 1 },
  }] })
  assert.equal(surface.view.truncated, false)
})

for (const field of ['oldText', 'newText']) test(`diff material preserves ${field} UTF-8 truncation even below the byte ceiling`, () => {
  const text = '😀'.repeat(110_000)
  const [surface] = projectDshWorkSurfaces('s1', 'C:/workspace', { nodes: [{
    kind: 'tool-result', callId: 'long-diff', seq: 1, time: 1, isError: false,
    resultView: { card: 'diff', diffs: [{ path: 'diff.txt', oldText: '', newText: '', [field]: text }] },
  }] })
  assert.equal(surface.view.diffs.length, 1)
  assert.ok(surface.view.diffs[0][field].length < text.length)
  assert.ok(Buffer.byteLength(surface.view.diffs[0].oldText + surface.view.diffs[0].newText) <= 384 * 1024)
  assert.equal(surface.view.truncated, true)
})

test('a complete diff exactly at the byte budget does not claim truncation', () => {
  const text = 'a'.repeat(384 * 1024)
  const [surface] = projectDshWorkSurfaces('s1', 'C:/workspace', { nodes: [{
    kind: 'tool-result', callId: 'exact-diff', seq: 1, time: 1, isError: false,
    resultView: { card: 'diff', diffs: [{ path: 'exact.txt', oldText: null, newText: text }] },
  }] })
  assert.equal(surface.view.diffs[0].newText, text)
  assert.equal(surface.view.truncated, false)
})

for (const [name, content] of [
  ['large error text', [{ type: 'text', text: 'error-detail '.repeat(30_000) }]],
  ['too many content blocks', Array.from({ length: 129 }, (_, index) => ({ type: 'text', text: `line-${index}` }))],
  ['partially retained final block', [{ type: 'text', text: 'a'.repeat(200_000) }, { type: 'text', text: 'b'.repeat(100_000) }]],
]) test(`failed terminal fallback discloses truncation for ${name}`, () => {
  // The real pwsh error presenter is generic; the terminal start remains, so
  // this supported branch reads result.content instead of resultView.output.
  const [surface] = projectDshWorkSurfaces('s1', 'C:/workspace', { nodes: [{
    kind: 'tool-result', callId: 'terminal-failure', seq: 1, time: 1, isError: true,
    callView: { card: 'terminal', title: 'public error fixture' }, resultView: { card: 'generic' }, content,
  }] })
  assert.equal(surface.status, 'error')
  assert.ok(surface.view.output.length < content.map(block => block.text).join('\n').length)
  assert.ok(Buffer.byteLength(surface.view.output) <= 256 * 1024)
  assert.equal(surface.view.truncated, true)
})

test('short complete terminal fallback remains complete', () => {
  const [surface] = projectDshWorkSurfaces('s1', 'C:/workspace', { nodes: [{
    kind: 'tool-result', callId: 'short-error', seq: 1, time: 1, isError: true,
    callView: { card: 'terminal' }, resultView: { card: 'generic' }, content: [{ type: 'text', text: 'complete error' }],
  }] })
  assert.equal(surface.view.output, 'complete error')
  assert.equal(surface.view.truncated, false)
})
