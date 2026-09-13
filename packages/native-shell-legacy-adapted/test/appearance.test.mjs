import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const client = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const hostSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const hostCode = ts.transpileModule(hostSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const host = await import(`data:text/javascript;base64,${Buffer.from(hostCode).toString('base64')}`)

const element = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) })
const nodes = tree => typeof tree === 'object' && tree !== null ? [tree, ...tree.children.flatMap(nodes)] : []
const luminance = hex => {
  const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
}
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)

test('Host rejects unknown fields, unknown palettes and CSS injection before persisting', () => {
  for (const input of [{ preset: 'javascript' }, { customAccent: 'red;display:none' }, { customAccent: '#fff' }, { model: 'changed' }, []]) {
    assert.throws(() => host.appearanceSettingsSchema(input), TypeError)
  }
  assert.deepEqual(host.appearanceSettingsSchema({ preset: 'custom', customAccent: '#ABCDEF' }), { preset: 'custom', customAccent: '#abcdef' })
  assert.deepEqual(host.appearanceSettingsSchema(undefined), {})
})

test('malformed stored settings cannot inject CSS or remove the safe default palette', () => {
  assert.deepEqual(client.normalizeAppearance({ preset: 'invalid', customAccent: 'url(secret)' }), { preset: 'moss', customAccent: '#4d6e54' })
  assert.equal(client.normalizeAppearance({ preset: 'custom', customAccent: '#AABBCC' }).customAccent, '#aabbcc')
})

test('every palette and extreme custom accent keeps text and selected controls readable in both modes', () => {
  for (const preset of ['moss', 'graphite', 'ocean', 'sand', 'custom']) {
    for (const customAccent of ['#ffffff', '#000000', '#ffff00', '#00ff00', '#0000ff', '#aabbcc']) {
      for (const mode of ['light', 'dark']) {
        const tokens = client.appearanceTokens({ preset, customAccent }, mode)
        for (const [fg, bg] of [['--ink', '--surface'], ['--ink3', '--surface'], ['--cta-ink', '--cta'], ['--accent-deep', '--accent-bg']]) {
          assert.ok(contrast(tokens[fg], tokens[bg]) >= 4.5, `${preset}/${mode}/${customAccent}: ${fg} on ${bg}`)
        }
      }
    }
  }
})

function settingsScope() {
  let snapshot = { status: 'ready', value: { preset: 'moss', customAccent: '#4d6e54' }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' }
  const listeners = new Set()
  const writes = []
  const scope = {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    mutate(ops) { return new Promise((resolve, reject) => writes.push({ ops, reject, accept() {
      const value = { ...snapshot.value }
      for (const op of ops) { assert.equal(op.op, 'set'); assert.equal(op.path.length, 1); value[op.path[0]] = op.value }
      snapshot = { ...snapshot, value, user: value, revision: snapshot.revision + 1 }
      for (const fn of listeners) fn()
      resolve()
    } })) },
  }
  return { scope, writes, listeners }
}

test('rapid selections persist the newest choice atomically without displaying an older acknowledgement', async () => {
  const { scope, writes, listeners } = settingsScope()
  const store = client.createAppearancePreference(scope)
  const first = store.save({ preset: 'graphite', customAccent: '#112233' })
  const last = store.save({ preset: 'custom', customAccent: '#aabbcc' })
  assert.equal(store.getSnapshot().status, 'saving')
  writes[0].accept()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.getSnapshot().value.customAccent, '#aabbcc')
  assert.equal(store.getSnapshot().status, 'saving')
  writes[1].accept()
  await Promise.all([first, last])
  assert.equal(store.getSnapshot().status, 'ready')
  assert.deepEqual(scope.getSnapshot().value, { preset: 'custom', customAccent: '#aabbcc' })
  store.dispose()
  assert.equal(listeners.size, 0)
  const reopened = client.createAppearancePreference(scope)
  assert.deepEqual(reopened.getSnapshot().value, { preset: 'custom', customAccent: '#aabbcc' })
  reopened.dispose()
})

test('failed writes stay explicitly unsaved; retry does not reset other settings', async () => {
  const { scope, writes } = settingsScope()
  const store = client.createAppearancePreference(scope)
  const attempt = store.save({ preset: 'ocean', customAccent: '#123456' })
  writes[0].reject(new Error('disk not writable'))
  await attempt
  assert.equal(store.getSnapshot().status, 'error')
  assert.equal(store.getSnapshot().value.preset, 'ocean')
  assert.equal(scope.getSnapshot().value.preset, 'moss')
  const retry = store.save(store.getSnapshot().value)
  writes[1].accept()
  await retry
  assert.equal(store.getSnapshot().status, 'ready')
  assert.deepEqual(writes[1].ops.map(op => op.path), [['preset'], ['customAccent']])
  store.dispose()
})

test('unavailable settings never claim durable saving or attempt a write', async () => {
  const store = client.createAppearancePreference()
  await store.save({ preset: 'sand', customAccent: '#123456' })
  assert.equal(store.getSnapshot().status, 'unavailable')
  assert.equal(store.getSnapshot().writable, false)
  store.dispose()
})

test('a missing namespace remains read-only even when the global host document is writable', async () => {
  for (const status of ['loading', 'unavailable', 'degraded']) {
    const { scope } = settingsScope()
    scope.getSnapshot = () => ({ status, value: undefined, base: undefined, user: undefined, revision: undefined, mode: 'host', writable: true })
    scope.mutate = () => { throw Error('unavailable namespace must never be mutated') }
    const store = client.createAppearancePreference(scope)
    assert.equal(store.getSnapshot().writable, false)
    await store.save({ preset: 'ocean', customAccent: '#123456' })
    assert.equal(store.getSnapshot().status, 'unavailable')
    store.dispose()
  }
})

test('drafting hides starter actions from keyboard navigation without removing the reserved region', () => {
  const rendered = client.renderEmptyStage(element, { drafting: true, needsModelSetup: true, onModelSettings() {}, onStarter() { throw new Error('hidden starter called') } })
  const all = nodes(rendered)
  const region = all.find(node => node.props['aria-label'] === '任务草稿')
  assert.equal(region.props['aria-hidden'], true)
  assert.equal(region.props['data-drafting'], true)
  assert.equal(region.children.length, 3)
  for (const button of region.children) { assert.equal(button.props.tabIndex, -1); assert.equal(button.props.disabled, true) }
  assert.ok(all.some(node => node.props.role === 'status'), 'setup warning must not disappear with starters')
  assert.equal(client.taskStarterDraft('', 1, 'organize'), undefined)
  assert.equal(client.taskStarterDraft('user draft', 0, 'organize'), undefined)
})
