import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const client = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const turns = count => Array.from({ length: count }, (_, index) => ({
  key: `turn-${index}`, ordinal: index + 1, eventIndex: -1, seq: index * 3 + 1, preview: `消息 ${index + 1}`,
}))

test('short navigation stays complete without paging controls', () => {
  const items = turns(4)
  const page = client.userTurnNavigationPage(items, 2, undefined, 600)
  assert.deepEqual(page.items, items)
  assert.equal(page.page, 0)
  assert.equal(page.pageCount, 1)
})

test('long navigation follows the current message and shows at most five markers', () => {
  const page = client.userTurnNavigationPage(turns(120), 57, undefined, 600)
  assert.deepEqual(page.items.map(item => item.ordinal), [56, 57, 58, 59, 60])
  assert.equal(page.page, 11)
  assert.equal(page.pageCount, 24)
})

test('reading position skips unloaded history rather than jumping back to the first message', () => {
  assert.equal(client.activeUserTurnOrdinalAtScroll([NaN, NaN, 100, 500, 900], 420, 600), 4)
  assert.equal(client.activeUserTurnOrdinalAtScroll([NaN, NaN, 400, 800], 0, 600), 3)
  assert.equal(client.activeUserTurnOrdinalAtScroll([NaN, NaN], 0, 600), undefined)
})

test('manual pages retain every historical message and its reveal sequence', () => {
  const items = turns(123), reached = []
  const first = client.userTurnNavigationPage(items, 123, 0, 600)
  for (let index = 0; index < first.pageCount; index++) {
    const page = client.userTurnNavigationPage(items, 123, index, 600)
    assert.ok(page.items.length <= 5)
    reached.push(...page.items)
  }
  assert.deepEqual(reached, items)
  assert.equal(reached[0], items[0], 'paging must not reconstruct or discard timeline identity')
})

test('short viewports reduce marker count instead of overflowing a nested scroller', () => {
  const items = turns(20)
  for (const height of [90, 100, 120, 144, 160, 180, 600]) {
    const page = client.userTurnNavigationPage(items, 13, undefined, height)
    assert.ok(page.items.some(item => item.ordinal === 13))
    assert.ok((page.items.length + 2) * 24 <= height - 16)
    assert.ok(page.items.length <= 5)
  }
  const tiny = client.userTurnNavigationPage(items, 13, undefined, 60)
  assert.equal(tiny.items.length, 0, 'hide the optional rail if even one marker and its paging controls cannot fit')
  assert.equal(client.userTurnNavigationPage(turns(1), 1, undefined, 60).items.length, 1)
})

test('page selection is clamped when the session or viewport changes', () => {
  const items = turns(12)
  assert.equal(client.userTurnNavigationPage(items, 1, 999, 600).page, 2)
  assert.equal(client.userTurnNavigationPage(items, 12, -4, 600).page, 0)
  for (const invalid of [undefined, NaN, Infinity]) {
    assert.equal(client.userTurnNavigationPage(items, 12, invalid, 600).page, 2)
  }
  assert.equal(client.userTurnNavigationPage(items, 12, 1.9, 600).page, 1)
  assert.equal(client.userTurnNavigationPage(items, 999, undefined, 600).page, 0)
})

test('empty and invalid viewport values produce finite bounded navigation', () => {
  assert.deepEqual(client.userTurnNavigationPage([], undefined, undefined, 600), { items: [], page: 0, pageCount: 0 })
  for (const height of [NaN, Infinity, undefined]) {
    assert.equal(client.userTurnNavigationPage(turns(20), 6, undefined, height).items.length, 5)
  }
  for (const height of [0, -20]) {
    assert.equal(client.userTurnNavigationPage(turns(20), 6, undefined, height).items.length, 0)
  }
})

test('older history prefetch requires upward reading near the top, not startup or bottom-follow', () => {
  const state = { scrollTop: 120, previousTop: 250, clientHeight: 600, hasEarlier: true, loading: false }
  assert.equal(client.shouldPrefetchHistory(state), true)
  for (const change of [{ previousTop: 0 }, { previousTop: 120 }, { scrollTop: 500 }, { hasEarlier: false }, { loading: true }, { clientHeight: 0 }, { scrollTop: NaN }]) {
    assert.equal(client.shouldPrefetchHistory({ ...state, ...change }), false)
  }
  assert.equal(client.shouldPrefetchHistory({ ...state, scrollTop: 0, previousTop: 10 }), true)
})

test('prepend restoration uses the same visible message, not total height polluted by new replies', () => {
  assert.equal(client.historyPrependScrollTop({ scrollTop: 100, previousHeight: 2000, scrollHeight: 5500, anchorTop: 2500, previousAnchorTop: -20 }), 2620)
  assert.equal(client.historyPrependScrollTop({ scrollTop: 100, previousHeight: 2000, scrollHeight: 5500 }), 3600)
  assert.equal(client.historyPrependScrollTop({ scrollTop: 100, previousHeight: 2000, scrollHeight: 1500 }), 100)
})
