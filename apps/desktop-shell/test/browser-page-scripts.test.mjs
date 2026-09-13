import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContext, runInContext } from 'node:vm'
import { snapshotScript, targetScript } from '../src/browser-page-scripts.mjs'

// Executes the actual injected script, not a second implementation of its id
// allocator. These small DOM fixtures test object/document identity only;
// Electron's isolated-world security guarantee needs native acceptance too.
function page() {
  class Element {
    constructor(name, { tag = 'BUTTON', type = '', value, visible = true, attrs = {} } = {}) {
      Object.assign(this, { tagName: tag, type, innerText: name, name: '', id: '', title: '', autocomplete: '',
        labels: [], disabled: false, isConnected: true, isContentEditable: false, visible, attrs, ownerDocument: undefined })
      if (value !== undefined) this.value = value
    }
    getAttribute(name) { return this.attrs[name] ?? null }
    getBoundingClientRect() { return { x: 10, y: 10, width: this.visible ? 100 : 0, height: this.visible ? 30 : 0 } }
    scrollIntoView() {}
    contains(other) { return other === this }
    focus() { this.focused = true }
    select() { this.selected = true }
  }
  class Input extends Element {
    constructor(name, options = {}) { super(name, { ...options, tag: 'INPUT', value: options.value ?? '' }) }
  }
  function document(elements = []) {
    const doc = { title: 'Fixture', body: { innerText: 'Fixture text' }, elements,
      querySelectorAll() { return this.elements }, elementFromPoint() { return this.hit ?? this.elements[0] ?? null } }
    for (const element of elements) element.ownerDocument = doc
    return doc
  }
  const doc = document()
  const context = createContext({ document: doc, location: { href: 'https://example.test/form' },
    innerWidth: 900, innerHeight: 700, scrollY: 0,
    getComputedStyle: el => ({ visibility: el.visible ? 'visible' : 'hidden', display: 'block' }),
    HTMLInputElement: Input, HTMLTextAreaElement: class extends Element {}, setTimeout: callback => callback() })
  const mainWorld = createContext({ document: doc })
  const set = elements => { doc.elements = elements; for (const element of elements) element.ownerDocument = doc }
  const snapshot = id => JSON.parse(JSON.stringify(runInContext(snapshotScript(id), context)))
  return { context, mainWorld, doc, Element, Input, document, set, snapshot }
}

test('real DOM nodes retain opaque ids through reorder and insertion, including type value readback', () => {
  const p = page(); const input = new p.Input('Result', { value: '' }); const save = new p.Element('Save')
  p.set([input, save])
  assert.deepEqual(p.snapshot('before').elements.map(el => el.element_id), ['e1', 'e2'])
  const added = new p.Element('Validation notice')
  input.value = 'typed result'
  p.set([added, save, input])
  const after = p.snapshot('after')
  assert.deepEqual(after.elements.map(el => el.element_id), ['e3', 'e2', 'e1'])
  assert.equal(after.elements.find(el => el.element_id === 'e1').value, 'typed result')
  assert.equal(after.snapshot_id, 'after')
  assert.equal(p.context.__xiaosheBrowserSnapshot.elements.get('e1'), input)
})

test('deleted/replaced nodes cannot lend their identity to an equal id/name node', async () => {
  const p = page(); const old = new p.Input('Same name'); old.id = 'same-id'; old.name = 'same-name'
  p.set([old]); assert.equal(p.snapshot('original').elements[0].element_id, 'e1')
  old.isConnected = false
  const replacement = new p.Input('Same name'); replacement.id = old.id; replacement.name = old.name
  p.set([replacement])
  await assert.rejects(runInContext(targetScript('original', 'e1', 'type', true), p.context), /目标元素已改变/u)
  assert.equal(p.snapshot('replacement').elements[0].element_id, 'e2')
  await assert.rejects(runInContext(targetScript('replacement', 'e1', 'type', true), p.context), /目标元素已改变/u)
  // Reinserting the *same* object is identity preservation, not id reuse.
  old.isConnected = true; p.set([replacement, old])
  assert.deepEqual(p.snapshot('reinserted').elements.map(el => el.element_id), ['e2', 'e1'])
})

test('visibility and the row cap do not renumber or recycle previously observed nodes', () => {
  const p = page(); const hidden = new p.Element('Hidden', { visible: false }); const visible = new p.Element('Visible')
  p.set([hidden, visible]); assert.deepEqual(p.snapshot('hidden').elements.map(el => el.element_id), ['e1'])
  hidden.visible = true
  assert.deepEqual(p.snapshot('shown').elements.map(el => el.element_id), ['e2', 'e1'])
  visible.visible = false; p.snapshot('hidden-again'); visible.visible = true
  assert.deepEqual(p.snapshot('shown-again').elements.map(el => el.element_id), ['e2', 'e1'])
  const many = Array.from({ length: 161 }, (_, i) => new p.Element(`item-${i}`))
  p.set(many)
  const capped = p.snapshot('capped')
  assert.equal(capped.elements.length, 160); assert.equal(capped.truncated, true)
  p.set([many[160], ...many.slice(0, 159)])
  const shifted = p.snapshot('shifted')
  assert.equal(shifted.elements[0].element_id, 'e163')
  assert.equal(shifted.elements[1].element_id, capped.elements[0].element_id)
})

test('a new document has a separate namespace and old snapshot targets remain invalid', async () => {
  const p = page(); const old = new p.Input('Old')
  p.set([old]); p.snapshot('old-document')
  const next = new p.Input('Next'); const doc2 = p.document([next])
  p.context.document = doc2
  await assert.rejects(runInContext(targetScript('old-document', 'e1', 'type', true), p.context), /快照已过期/u)
  assert.equal(p.snapshot('new-document').elements[0].element_id, 'e1')
  assert.equal(p.context.__xiaosheBrowserSnapshot.elements.get('e1'), next)
  assert.notEqual(p.context.__xiaosheBrowserElementIdentities.get(p.doc), p.context.__xiaosheBrowserElementIdentities.get(doc2))
  p.context.document = p.doc
  p.snapshot('original-returned')
  old.ownerDocument = doc2
  await assert.rejects(runInContext(targetScript('original-returned', 'e1', 'type', true), p.context), /目标元素已改变/u)
})

test('document replacement during target layout settling cannot revive an old element identity', async () => {
  const p = page(); const input = new p.Input('Input')
  p.set([input]); p.snapshot('before-navigation')
  let settle
  p.context.setTimeout = callback => { settle = callback }
  const action = runInContext(targetScript('before-navigation', 'e1', 'type', true), p.context)
  const rejection = assert.rejects(action, /页面或控制权已改变/u)
  p.context.document = p.document([new p.Input('Other')])
  settle()
  await rejection
  assert.equal(input.focused, undefined)
})

test('id counters stop at the safe integer boundary and never wrap or accept corrupt state', () => {
  const p = page(); const first = new p.Element('first')
  p.set([first]); p.snapshot('initial')
  const state = p.context.__xiaosheBrowserElementIdentities.get(p.doc)
  state.nextId = Number.MAX_SAFE_INTEGER - 1
  const last = new p.Element('last'); p.set([first, last])
  assert.deepEqual(p.snapshot('last-id').elements.map(el => el.element_id), ['e1', `e${Number.MAX_SAFE_INTEGER}`])
  assert.deepEqual(p.snapshot('known-ids').elements.map(el => el.element_id), ['e1', `e${Number.MAX_SAFE_INTEGER}`])
  p.set([new p.Element('overflow')])
  assert.throws(() => p.snapshot('overflow'), /超出安全范围/u)
  assert.equal(p.context.__xiaosheBrowserSnapshot, undefined)
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    state.nextId = value
    assert.throws(() => p.snapshot('invalid'), /身份状态无效/u)
  }
})

test('page-main globals/DOM labels cannot control isolated identities and sensitive values stay omitted', async () => {
  const p = page(); const input = new p.Input('Result', { value: 'public value' })
  const password = new p.Input('Password', { type: 'password', value: 'must-not-leak' })
  const file = new p.Input('File', { type: 'file', value: 'must-not-leak-path' })
  p.set([input, password, file]); p.snapshot('initial')
  runInContext('globalThis.__xiaosheBrowserElementIdentities = new WeakMap(); globalThis.__xiaosheBrowserSnapshot = { id: "forged" }; document.elements[0].id = "e999"; document.elements[0].name = "e999"', p.mainWorld)
  const observed = p.snapshot('isolated')
  assert.deepEqual(observed.elements.map(el => el.element_id), ['e1', 'e2', 'e3'])
  assert.equal(observed.elements[0].value, 'public value')
  for (const row of observed.elements.slice(1)) { assert.equal(row.requires_user, true); assert.equal(Object.hasOwn(row, 'value'), false) }
  assert.equal(JSON.stringify(observed).includes('must-not-leak'), false)
  await assert.rejects(runInContext(targetScript('forged', 'e1', 'type', true), p.context), /快照已过期/u)
  await assert.rejects(runInContext(targetScript('isolated', 'e2', 'type', true), p.context), /需要用户接管/u)
  await runInContext(targetScript('isolated', 'e1', 'type', true), p.context)
  assert.equal(input.focused, true); assert.equal(input.selected, true)
})
