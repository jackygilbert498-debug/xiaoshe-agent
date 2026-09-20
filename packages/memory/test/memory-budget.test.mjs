import assert from 'node:assert/strict'
import test from 'node:test'

import { renderContextSections } from '../../../runtime/DSH/packages/core/system-prompt/lib/index.js'
import {
  apply as applyMemory,
  createMemoryService,
  selectMemoryInjection,
} from '../lib/index.js'

const TIMESTAMP = '2026-09-19T00:00:00.000Z'
const READY_DIAGNOSTICS = {
  persistence_status: 'ready',
  usage_audit_status: 'ready',
  usage_persistence_failures: 0,
}

function entry(id, text, overrides = {}) {
  return {
    id,
    scope: 'global',
    text,
    state: 'active',
    version: 1,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    ...overrides,
  }
}

function snapshot(entries) {
  return {
    api_version: 1,
    revision: entries.length,
    counts: {
      active: entries.filter(item => item.state === 'active').length,
      global: entries.filter(item => item.scope === 'global').length,
      project: entries.filter(item => item.scope === 'project').length,
      forgotten: entries.filter(item => item.state === 'forgotten').length,
      superseded: entries.filter(item => item.state === 'superseded').length,
    },
    entries,
    audit: [],
    usage: [],
    diagnostics: READY_DIAGNOSTICS,
  }
}

function manyEntries(count) {
  return Array.from({ length: count }, (_, index) => entry(`memory-${index}`, `note ${index}`))
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

test('default injection keeps 0, 100, 101, and 500 eligible entries within the 100-item audit ceiling', () => {
  for (const [count, expectedSelected, expectedOmitted] of [
    [0, 0, 0],
    [100, 100, 0],
    [101, 100, 1],
    [500, 100, 400],
  ]) {
    const injection = selectMemoryInjection(snapshot(manyEntries(count)))
    assert.equal(injection.items.length, expectedSelected, `${count} eligible entries`)
    assert.equal(injection.omitted, expectedOmitted, `${count} eligible entries`)
    assert.ok(injection.text.length <= 16_000, `${count} eligible entries exceeded the prompt budget`)
    if (expectedOmitted > 0) {
      assert.match(injection.text, /xiaoshe_memory_list/u)
      assert.match(injection.text, /omitted constraints may still apply/iu)
    }
  }
})

test('a 4000-character Chinese memory is included whole when its rendered frame fits', () => {
  const text = '验'.repeat(4_000)
  const injection = selectMemoryInjection(snapshot([entry('long-chinese', text)]))
  assert.deepEqual(injection.items.map(item => item.id), ['long-chinese'])
  assert.equal(injection.omitted, 0)
  assert.match(injection.text, new RegExp(`\\n${text}\\n`, 'u'))
  assert.ok(injection.text.length <= 16_000)
})

test('selection measures escaped output, skips an oversized complete entry, and never emits partial memory text', () => {
  const expanding = '<'.repeat(4_000)
  const injection = selectMemoryInjection(snapshot([
    entry('expands-past-budget', expanding),
    entry('small-memory', 'keep this complete'),
  ]), undefined, { maxChars: 5_000 })

  assert.deepEqual(injection.items.map(item => item.id), ['small-memory'])
  assert.equal(injection.omitted, 1)
  assert.doesNotMatch(injection.text, /expands-past-budget/u)
  assert.doesNotMatch(injection.text, /&lt;&lt;&lt;/u)
  assert.match(injection.text, /keep this complete/u)
  assert.ok(injection.text.length <= 5_000)
})

test('real Host rendering keeps an unknown memory variable reference literal', () => {
  const injection = selectMemoryInjection(snapshot([
    entry('literal-{{missing}}', 'Keep {{missing}} as memory data.'),
  ]))
  const sections = renderContextSections({
    sections: [],
    contexts: [{ name: 'xiaoshe:memory', text: injection.text }],
    tools: [],
    variables: {},
  })

  assert.equal(sections.length, 1)
  assert.doesNotMatch(sections[0].text, /\{\{/u)
  assert.match(sections[0].text, /&#123;&#123;missing&#125;&#125;/u)
  assert.deepEqual(injection.items.map(item => item.id), ['literal-{{missing}}'])
})

test('real Host rendering cannot expand a known memory variable beyond the accounted budget', () => {
  const injection = selectMemoryInjection(snapshot([
    entry('known-variable', 'Keep {{huge}} as memory data.'),
  ]))
  const sections = renderContextSections({
    sections: [],
    contexts: [{ name: 'xiaoshe:memory', text: injection.text }],
    tools: [],
    variables: { huge: 'X'.repeat(20_000) },
  })

  assert.equal(sections.length, 1)
  assert.ok(sections[0].text.length <= 16_000)
  assert.doesNotMatch(sections[0].text, /X{100}/u)
  assert.match(sections[0].text, /&#123;&#123;huge&#125;&#125;/u)
})

test('zero and tiny character budgets suppress the prompt without losing omitted metadata', () => {
  const memories = snapshot([entry('bounded', 'A complete memory that cannot fit a tiny prompt.')])
  for (const maxChars of [0, 20]) {
    const injection = selectMemoryInjection(memories, undefined, { maxChars })
    assert.deepEqual(injection.items, [])
    assert.equal(injection.omitted, 1)
    assert.equal(injection.text, '')
  }
})

test('selection excludes inactive and cross-project entries before budgeting', () => {
  const injection = selectMemoryInjection(snapshot([
    entry('global-active', 'global'),
    entry('global-forgotten', 'forgotten', { state: 'forgotten' }),
    entry('same-project', 'same', { scope: 'project', project: 'C:/work/current' }),
    entry('same-project-forgotten', 'same forgotten', {
      scope: 'project', project: 'C:/work/current', state: 'forgotten',
    }),
    entry('cross-project', 'other', { scope: 'project', project: 'C:/work/other' }),
  ]), 'c:\\WORK\\current\\')

  assert.deepEqual(injection.items.map(item => item.id), ['global-active', 'same-project'])
  assert.equal(injection.omitted, 0)
  assert.doesNotMatch(injection.text, /forgotten|cross-project/u)
})

test('query relevance is deterministic within global and project scopes, including Chinese', () => {
  const memories = snapshot([
    entry('global-tie-a', '部署前执行验收'),
    entry('project-relevant', '部署验收清单', { scope: 'project', project: 'C:/work/current' }),
    entry('global-irrelevant', '默认使用中文回答'),
    entry('global-tie-b', '部署后执行验收'),
    entry('project-irrelevant', '项目编码规范', { scope: 'project', project: 'C:/work/current' }),
  ])

  const stable = selectMemoryInjection(memories, 'C:/work/current')
  assert.deepEqual(stable.items.map(item => item.id), [
    'global-tie-a',
    'global-irrelevant',
    'global-tie-b',
    'project-relevant',
    'project-irrelevant',
  ])

  const ranked = selectMemoryInjection(memories, 'C:/work/current', { query: '部署 验收' })
  assert.deepEqual(ranked.items.map(item => item.id), [
    'global-tie-a',
    'global-tie-b',
    'global-irrelevant',
    'project-relevant',
    'project-irrelevant',
  ])
  assert.deepEqual(
    selectMemoryInjection(memories, 'C:/work/current', { query: '部署 验收' }).items,
    ranked.items,
  )
})

test('runtime options clamp hard ceilings and reject malformed values safely', () => {
  const state = { revision: 101, entries: manyEntries(101), audit: [], usage: [] }
  const service = createMemoryService({
    get: () => state,
    getSnapshot: () => ({ value: state, revision: 0, status: 'ready' }),
    watch: () => () => {},
    async update() { assert.fail('injection selection must stay read-only') },
  })
  const clamped = service.injection(undefined, { maxChars: 99_999, maxItems: 999 })
  assert.equal(clamped.items.length, 100)
  assert.ok(clamped.text.length <= 16_000)
  assert.equal(service.injection(undefined, { maxItems: -1 }).items.length, 0)
  assert.throws(
    () => service.injection(undefined, { maxChars: Number.NaN }),
    /maxChars/u,
  )
  assert.throws(
    () => service.injection(undefined, { query: 42 }),
    /query/u,
  )
})

test('Host audits only finalized bounded IDs and skips audit when the final memory context is suppressed', async () => {
  let state = {
    revision: 101,
    entries: manyEntries(101),
    audit: [],
    usage: [],
  }
  let settingsRevision = 0
  let promptRow
  const listeners = new Map()
  const scope = {
    get: () => state,
    getSnapshot: () => ({ value: state, revision: settingsRevision, status: 'ready' }),
    watch: () => () => {},
    async update(section, expectedRevision) { return this.replace(section, expectedRevision) },
    async replace(section, expectedRevision) {
      assert.equal(expectedRevision, settingsRevision)
      state = section
      settingsRevision += 1
    },
  }
  applyMemory({
    tools: { register: () => () => {} },
    settings: { register: () => scope },
    systemPrompt: { context(row) { promptRow = row; return () => {} } },
    webServer: { register: () => () => {} },
    on(event, listener) { listeners.set(event, listener); return () => {} },
    effect(execute) { return execute() },
    provide() { return () => {} },
  })

  assert.ok(listeners.has('system-prompt/finalized'))
  assert.equal(listeners.has('system-prompt/assemble'), false)

  const firstContext = { agent: { id: 'session-final', session: { header: {} } } }
  const boundedText = promptRow.text(firstContext)
  const finalAssembly = { contexts: [{ name: 'xiaoshe:memory', text: boundedText }] }
  await listeners.get('system-prompt/finalized')(finalAssembly, firstContext, async () => finalAssembly)
  await waitFor(() => state.usage.length === 100, 'final injected IDs were not audited')
  assert.deepEqual(state.usage.map(row => row.entry_id), manyEntries(100).map(item => item.id))

  const secondContext = { agent: { id: 'session-suppressed', session: { header: {} } } }
  promptRow.text(secondContext)
  const suppressed = { contexts: [] }
  await listeners.get('system-prompt/finalized')(suppressed, secondContext, async () => suppressed)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(state.usage.every(row => row.count === 1), 'suppressed prompt must not be audited')
})

test('successful real Host rendering audits the original ID rather than its encoded frame text', async () => {
  const originalId = 'memory-{{missing}}'
  let state = {
    revision: 1,
    entries: [entry(originalId, 'Literal {{missing}} and {{huge}} memory data.')],
    audit: [],
    usage: [],
  }
  let settingsRevision = 0
  let promptRow
  let finalized
  const scope = {
    get: () => state,
    getSnapshot: () => ({ value: state, revision: settingsRevision, status: 'ready' }),
    watch: () => () => {},
    async update(section, expectedRevision) { return this.replace(section, expectedRevision) },
    async replace(section, expectedRevision) {
      assert.equal(expectedRevision, settingsRevision)
      state = section
      settingsRevision += 1
    },
  }
  applyMemory({
    tools: { register: () => () => {} },
    settings: { register: () => scope },
    systemPrompt: { context(row) { promptRow = row; return () => {} } },
    webServer: { register: () => () => {} },
    on(event, listener) { assert.equal(event, 'system-prompt/finalized'); finalized = listener; return () => {} },
    effect(execute) { return execute() },
    provide() { return () => {} },
  })

  const context = { agent: { id: 'session-braces', session: { header: {} } } }
  const assembly = {
    sections: [],
    contexts: [{ name: 'xiaoshe:memory', text: promptRow.text(context) }],
    tools: [],
    variables: { huge: 'X'.repeat(20_000) },
  }
  const finalizedAssembly = await finalized(assembly, context, async () => assembly)
  const rendered = renderContextSections(finalizedAssembly)
  assert.equal(rendered.length, 1)
  assert.ok(rendered[0].text.length <= 16_000)
  await waitFor(() => state.usage.length === 1, 'rendered memory ID was not audited')
  assert.equal(state.usage[0].entry_id, originalId)
})
