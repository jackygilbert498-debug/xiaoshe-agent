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
const defaultBackgrounds = { customSurfaceLight: '#fcfcfc', customBackgroundLight: '#f4f4f5', customSurfaceDark: '#1c1d1f', customBackgroundDark: '#17181a' }

test('Host rejects unknown fields, unknown palettes and CSS injection before persisting', () => {
  for (const input of [{ preset: 'javascript' }, { customAccent: 'red;display:none' }, { customAccent: '#fff' }, { model: 'changed' }, []]) {
    assert.throws(() => host.appearanceSettingsSchema(input), TypeError)
  }
  assert.deepEqual(host.appearanceSettingsSchema({ preset: 'custom', customAccent: '#ABCDEF' }), { preset: 'custom', customAccent: '#abcdef' })
  assert.deepEqual(host.appearanceSettingsSchema(undefined), {})
})

test('malformed stored settings cannot inject CSS or remove the safe default palette', () => {
  assert.deepEqual(client.normalizeAppearance({ preset: 'invalid', customAccent: 'url(secret)' }), { preset: 'moss', customAccent: '#4d6e54', ...defaultBackgrounds })
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
  assert.deepEqual(scope.getSnapshot().value, { preset: 'custom', customAccent: '#aabbcc', ...defaultBackgrounds })
  store.dispose()
  assert.equal(listeners.size, 0)
  const reopened = client.createAppearancePreference(scope)
  assert.deepEqual(reopened.getSnapshot().value, { preset: 'custom', customAccent: '#aabbcc', ...defaultBackgrounds })
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
  assert.deepEqual(writes[1].ops.map(op => op.path), [['preset'], ['customAccent'], ...Object.keys(defaultBackgrounds).map(key => [key])])
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

test('three-color custom settings reject malformed surfaces while retaining old accent-only files', () => {
  const value = { preset: 'custom', customAccent: '#ABCDEF', customSurfaceLight: '#F0F1F2', customBackgroundLight: '#E0E1E2', customSurfaceDark: '#101214', customBackgroundDark: '#070809' }
  assert.deepEqual(host.appearanceSettingsSchema(value), { ...value, customAccent: '#abcdef', customSurfaceLight: '#f0f1f2', customBackgroundLight: '#e0e1e2' })
  for (const key of Object.keys(defaultBackgrounds)) {
    for (const invalid of ['#fff', 'url(https://example.com)', null, {}, '#abcdzz']) assert.throws(() => host.appearanceSettingsSchema({ [key]: invalid }), TypeError)
  }
  assert.deepEqual(client.customPaletteColors({ preset: 'custom', customAccent: '#112233' }, 'dark'), ['#112233', '#1c1d1f', '#17181a'])
})

test('editing a custom color preserves the other mode and switching presets does not erase it', async () => {
  const { scope, writes } = settingsScope()
  const store = client.createAppearancePreference(scope)
  const custom = client.updateCustomPalette(store.getSnapshot().value, 'dark', ['#b088ee', '#121314', '#060708'])
  const save = store.save(custom); writes[0].accept(); await save
  const preset = store.save({ ...store.getSnapshot().value, preset: 'sand' }); writes[1].accept(); await preset
  const restore = store.save({ ...store.getSnapshot().value, preset: 'custom' }); writes[2].accept(); await restore
  const reopened = client.createAppearancePreference(scope)
  assert.deepEqual(client.customPaletteColors(reopened.getSnapshot().value, 'dark'), ['#b088ee', '#121314', '#060708'])
  assert.deepEqual(client.customPaletteColors(reopened.getSnapshot().value, 'light'), ['#b088ee', '#fcfcfc', '#f4f4f5'])
  reopened.dispose(); store.dispose()
})

test('custom surfaces reach the real theme tokens and text adapts to the chosen surface', () => {
  for (const [surface, background] of [['#102030', '#050607'], ['#faf0dd', '#ede0c9'], ['#ffffff', '#000000'], ['#000000', '#ffffff']]) {
    const value = client.updateCustomPalette({ preset: 'moss', customAccent: '#000000' }, 'dark', ['#ee8844', surface, background])
    const tokens = client.appearanceTokens(value, 'dark')
    assert.equal(tokens['--surface'], surface)
    assert.equal(tokens['--bg'], background)
    for (const [fg, bg] of [['--ink', '--surface'], ['--ink3', '--surface'], ['--cta-ink', '--cta'], ['--sidebar-ink', '--bg']]) assert.ok(contrast(tokens[fg], tokens[bg]) >= 4.5)
  }
})

test('custom accent fills keep the exact chosen color while text, focus and hover remain readable', () => {
  for (const mode of ['light', 'dark']) {
    for (const accent of ['#f3c5a6', '#8eaebe', '#eeeeee', '#ffffff', '#000000', '#777777', '#ffff00', '#0000ff']) {
      for (const surface of ['#f5eee2', '#1c1d1f']) {
        const value = client.updateCustomPalette({}, mode, [accent, surface, '#8eaebe'])
        const tokens = client.appearanceTokens(value, mode)
        assert.equal(tokens['--cta'], accent, 'picked accent must not be darkened to satisfy text-on-surface contrast')
        assert.ok(contrast(tokens['--cta-ink'], tokens['--cta']) >= 4.5)
        assert.ok(contrast(tokens['--cta-ink'], tokens['--cta-deep']) >= 4.5, 'hover keeps the button label readable')
        assert.ok(contrast(tokens['--accent'], surface) >= 4.5, 'focus and small colored text have their own accessible tone')
        assert.ok(contrast(tokens['--accent-deep'], tokens['--accent-bg']) >= 4.5)
      }
    }
  }
})

function pixels(...groups) {
  return new Uint8ClampedArray(groups.flatMap(([count, rgba]) => Array.from({ length: count }, () => rgba).flat()))
}

test('image extraction reports representative colors in sampled area order and ignores transparent pixels', () => {
  assert.equal(typeof client.extractImagePalette, 'function', 'local image palette extractor is available')
  const colors = client.extractImagePalette(pixels([60, [238, 238, 238, 255]], [30, [34, 34, 34, 255]], [10, [200, 64, 32, 255]], [100, [0, 255, 0, 0]]))
  assert.deepEqual(colors.map(({ color, share }) => [color, Math.round(share * 100)]), [['#eeeeee', 60], ['#222222', 30], ['#c84020', 10]])
})

test('similar shades are merged rather than occupying all three color slots', () => {
  assert.equal(typeof client.extractImagePalette, 'function')
  const colors = client.extractImagePalette(pixels([30, [240, 240, 240, 255]], [30, [244, 244, 244, 255]], [30, [34, 34, 34, 255]], [10, [200, 64, 32, 255]]))
  assert.equal(colors.length, 3)
  assert.equal(Math.round(colors[0].share * 100), 60)
  assert.equal(colors[1].color, '#222222')
  assert.equal(colors[2].color, '#c84020')
})

// Independently specified area fixture, matching the distinct color families in
// the reported architecture illustration without copying a user's photograph.
const illustrationAreas = [
  [3400, [245, 238, 226, 255]], // cream: 34% of the whole image
  [2800, [242, 196, 166, 255]], // peach: 28%
  [1700, [143, 172, 184, 255]], // blue-gray: 17%
  [1400, [22, 114, 161, 255]],  // blue: 14%, must not be reassigned to a top color
  [700, [192, 104, 65, 255]],   // terracotta: 7%
]

test('all five distinct source families remain available with their whole-image areas', () => {
  const result = client.extractImagePalette(pixels(...illustrationAreas))
  assert.deepEqual(result, [
    { color: '#f5eee2', share: .34 }, { color: '#f2c4a6', share: .28 }, { color: '#8facb8', share: .17 },
    { color: '#1672a1', share: .14 }, { color: '#c06841', share: .07 },
  ])
  assert.ok(Math.abs(result.reduce((sum, entry) => sum + entry.share, 0) - 1) < 1e-10)
})

test('texture and quantization boundaries neither fragment a dominant family nor merge distinct pastel surfaces', () => {
  const textured = pixels(...illustrationAreas)
  for (let pixel = 0; pixel < textured.length / 4; pixel++) {
    const variation = (pixel % 9) - 4
    for (let channel = 0; channel < 3; channel++) textured[pixel * 4 + channel] += variation
  }
  const result = client.extractImagePalette(textured)
  assert.equal(result.length, 5)
  for (const [index, area] of [[0, .34], [1, .28], [2, .17]]) assert.ok(Math.abs(result[index].share - area) < .003, `color family ${index} keeps its area`)
  assert.ok(result[0].color !== result[1].color, 'cream and peach remain separate')
})

test('mild lighting variation across a surface does not split its area into multiple recommended slots', () => {
  const shaded = pixels(...illustrationAreas)
  for (let pixel = 0; pixel < shaded.length / 4; pixel++) {
    const variation = (pixel % 25) - 12
    for (let channel = 0; channel < 3; channel++) shaded[pixel * 4 + channel] += variation
  }
  const result = client.extractImagePalette(shaded)
  for (const [index, area] of [[0, .34], [1, .28], [2, .17]]) assert.ok(Math.abs(result[index].share - area) < .005, `shaded family ${index} keeps its area`)
})

test('rare distinct colors are selectable without inflating the larger families', () => {
  const result = client.extractImagePalette(pixels(
    [5000, [245, 238, 226, 255]], [3000, [242, 196, 166, 255]], [1900, [143, 172, 184, 255]], [100, [22, 114, 161, 255]],
  ))
  assert.deepEqual(result.map(entry => entry.share), [.5, .3, .19, .01])
})

test('eight candidates bound a noisy palette without redistributing omitted area', () => {
  const result = client.extractImagePalette(pixels(
    [900, [255, 0, 0, 255]], [800, [0, 255, 0, 255]], [700, [0, 0, 255, 255]],
    [600, [255, 255, 0, 255]], [500, [0, 255, 255, 255]], [400, [255, 0, 255, 255]],
    [300, [255, 255, 255, 255]], [200, [0, 0, 0, 255]], [100, [255, 128, 0, 255]],
  ))
  assert.deepEqual(result.map(entry => entry.color), ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#ffffff', '#000000'])
  assert.equal(result[0].share, .2)
  assert.ok(Math.abs(result.reduce((sum, entry) => sum + entry.share, 0) - 44 / 45) < 1e-10, 'the ninth color keeps its own area')
})

test('reordering equally sized regions does not change the recommended palette or its percentages', () => {
  const regions = [[100, [245, 238, 226, 255]], [100, [242, 196, 166, 255]], [100, [143, 172, 184, 255]], [100, [22, 114, 161, 255]]]
  assert.deepEqual(client.extractImagePalette(pixels(...regions)), client.extractImagePalette(pixels(...regions.toReversed())))
})

test('empty and transparent images fail clearly and a single-color image does not invent extra colors', () => {
  assert.equal(typeof client.extractImagePalette, 'function')
  assert.throws(() => client.extractImagePalette(new Uint8ClampedArray()), /像素|颜色/)
  assert.throws(() => client.extractImagePalette(new Uint8ClampedArray(3)), /像素/)
  assert.throws(() => client.extractImagePalette(pixels([20, [0, 0, 0, 0]])), /透明|颜色/)
  assert.deepEqual(client.extractImagePalette(pixels([100, [80, 112, 144, 255]])), [{ color: '#507090', share: 1 }])
})

test('image proposal prioritizes area for surfaces and vivid color for accent without persisting', () => {
  assert.equal(typeof client.paletteFromImage, 'function')
  const before = client.normalizeAppearance({ preset: 'sand', customAccent: '#abcdef' })
  const proposed = client.paletteFromImage([{ color: '#eeeeee', share: .6 }, { color: '#222222', share: .3 }, { color: '#c84020', share: .1 }], before, 'light')
  assert.deepEqual(client.customPaletteColors(proposed, 'light'), ['#c84020', '#eeeeee', '#222222'])
  assert.equal(before.preset, 'sand')
  assert.equal(before.customAccent, '#abcdef')
  const mono = client.paletteFromImage([{ color: '#507090', share: 1 }], before, 'dark')
  assert.deepEqual(client.customPaletteColors(mono, 'dark'), ['#507090', '#1c1d1f', '#17181a'])
})

test('local image decoder rejects oversize, empty and unsupported files before decoding', async () => {
  assert.equal(typeof client.readImagePalette, 'function')
  for (const input of [{ size: 11 * 1024 * 1024, type: 'image/png' }, { size: 0, type: 'image/png' }, { size: 20, type: 'image/svg+xml' }, { size: 20, type: 'text/plain' }]) {
    await assert.rejects(() => client.readImagePalette(input), /图片|PNG|10 MB/)
  }
})

// Render the registered production section; only the host persistence and React
// hook scheduler are controlled here. No duplicate palette component or reducer.
function appearanceSection() {
  const { scope, writes } = settingsScope()
  const slots = [], hooks = [], effects = []
  let cursor = 0
  let theme = { preference: 'dark', active: { id: 'ink-jade', colorScheme: 'dark' }, revision: 0, fontSize: 14 }
  const fontWrites = []
  const react = {
    createElement: element,
    useState(initial) {
      const index = cursor++
      if (!Object.hasOwn(hooks, index)) hooks[index] = initial
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }]
    },
    useRef(initial) { return react.useState({ current: initial })[0] },
    useSyncExternalStore(_subscribe, get) { return get() },
    useEffect(effect, deps) {
      const index = cursor++
      if (!hooks[index] || deps.some((value, key) => !Object.is(value, hooks[index].deps[key]))) {
        effects.push(() => { hooks[index]?.cleanup?.(); hooks[index] = { deps, cleanup: effect() } })
      }
    },
  }
  const dispose = client.apply({ settingsScope: { bind: () => scope }, on: () => () => {}, theme: {
    getTheme: () => theme, setTheme(mode) { theme = { ...theme, preference: mode, active: { id: mode, colorScheme: mode }, revision: theme.revision + 1 } }, overrideTokens: () => () => {},
    setFontSize(value) { fontWrites.push(value); theme = { ...theme, fontSize: value, revision: theme.revision + 1 } },
  }, slots: { inject: (_name, install) => install(), register: (definition, component) => { slots.push({ definition, component }); return () => {} } } }, react, { MarkdownText: () => null })
  const Component = slots.find(value => value.definition.id === 'appearance').component
  const render = () => { cursor = 0; Component(); while (effects.length) effects.shift()(); cursor = 0; return Component() }
  const find = label => nodes(render()).find(node => node.props['aria-label'] === label)
  return { writes, fontWrites, scope, render, find, dispose: () => { for (const hook of hooks) hook?.cleanup?.(); dispose() } }
}

test('Appearance font buttons use the existing theme service and respect both limits without touching colors', () => {
  const ui = appearanceSection()
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal(ui.find('放大正文').props.disabled, false)
      ui.find('放大正文').props.onClick()
    }
    assert.equal(ui.find('放大正文').props.disabled, true)
    for (let i = 0; i < 5; i++) ui.find('缩小正文').props.onClick()
    assert.equal(ui.find('缩小正文').props.disabled, true)
    assert.deepEqual(ui.fontWrites, [15, 16, 17, 16, 15, 14, 13, 12])
    assert.equal(ui.writes.length, 0)
  } finally { ui.dispose() }
})

test('the registered settings page stages all three custom colors and saves only on apply', async () => {
  const ui = appearanceSection()
  try {
    const swatch = ui.find('编辑主界面底色')
    assert.ok(swatch, 'each of the three swatches must be editable')
    swatch.props.onClick()
    ui.find('主界面底色十六进制值').props.onChange({ currentTarget: { value: '#112233' } })
    assert.equal(ui.writes.length, 0, 'preview never saves automatically')
    const preview = ui.find('当前外观示意')
    assert.equal(preview.props.style['--surface'], '#112233')
    ui.find('应用自定义配色').props.onClick()
    assert.equal(ui.writes.length, 1)
    ui.writes[0].accept(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(ui.scope.getSnapshot().value.customSurfaceDark, '#112233')
    assert.equal(ui.scope.getSnapshot().value.customSurfaceLight, '#fcfcfc')
    ui.find('编辑侧栏底色').props.onClick()
    ui.find('侧栏底色十六进制值').props.onChange({ currentTarget: { value: '#gggggg' } })
    assert.equal(ui.find('应用自定义配色').props.disabled, true, 'invalid draft cannot be saved')
  } finally { ui.dispose() }
})

test('click-based swapping exchanges exactly two colors, not role positions, and can be cancelled', () => {
  const labels = ['强调色', '主界面底色', '侧栏底色']
  for (const [from, to, want] of [
    [0, 1, ['#1c1d1f', '#4d6e54', '#17181a']],
    [0, 2, ['#17181a', '#1c1d1f', '#4d6e54']],
    [1, 2, ['#4d6e54', '#17181a', '#1c1d1f']],
  ]) {
    const ui = appearanceSection()
    try {
      ui.find(`编辑${labels[from]}`).props.onClick()
      const begin = ui.find('交换颜色')
      assert.ok(begin, 'swapping has a click/keyboard alternative to dragging')
      begin.props.onClick()
      ui.find(`编辑${labels[to]}`).props.onClick()
      const slots = ui.find('自定义三色').children
      assert.deepEqual(slots.map(node => node.props['aria-label']), labels.map(label => `编辑${label}`))
      assert.deepEqual(slots.map(node => node.children.find(child => child.type === 'small').children[0]), want)
      assert.equal(ui.find(`${labels[from]}十六进制值`).props.value, want[from], 'editor stays with the selected role')
      assert.equal(ui.writes.length, 0)
      ui.find('取消配色调整').props.onClick()
      assert.deepEqual(ui.find('自定义三色').children.map(node => node.children.find(child => child.type === 'small').children[0]), ['#4d6e54', '#1c1d1f', '#17181a'])
    } finally { ui.dispose() }
  }
})

test('cancelling an armed swap or choosing the same slot never creates an edit', () => {
  const ui = appearanceSection()
  try {
    const begin = ui.find('交换颜色')
    assert.ok(begin)
    begin.props.onClick()
    ui.find('取消颜色互换').props.onClick()
    assert.equal(ui.find('应用自定义配色').props.disabled, true)
    ui.find('交换颜色').props.onClick()
    ui.find('编辑强调色').props.onClick()
    assert.equal(ui.find('应用自定义配色').props.disabled, true)
    assert.equal(ui.writes.length, 0)
  } finally { ui.dispose() }
})

test('local image result is a draft and a late decode cannot override a newer choice', async t => {
  const originalBitmap = globalThis.createImageBitmap, originalDocument = globalThis.document
  t.after(() => { globalThis.createImageBitmap = originalBitmap; globalThis.document = originalDocument })
  let finishDecode
  let closed = 0
  globalThis.createImageBitmap = () => new Promise(resolve => { finishDecode = () => resolve({ close() { closed++ } }) })
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels([60, [238, 238, 238, 255]], [30, [34, 34, 34, 255]], [10, [200, 64, 32, 255]]) }) }), toDataURL: () => 'data:image/png;base64,fixture' }) }
  const ui = appearanceSection()
  try {
    assert.ok(ui.find('从图片提取配色'), 'image input is part of the actual settings page')
    const first = ui.find('从图片提取配色').props.onChange({ currentTarget: { files: [{ size: 100, type: 'image/png', name: 'first.png' }], value: 'first.png' } })
    finishDecode(); await first
    assert.equal(ui.writes.length, 0)
    assert.equal(ui.find('当前外观示意').props.style['--surface'], '#eeeeee')
    const later = ui.find('从图片提取配色').props.onChange({ currentTarget: { files: [{ size: 100, type: 'image/png', name: 'later.png' }], value: 'later.png' } })
    ui.find('取消配色调整').props.onClick()
    finishDecode(); await later
    assert.equal(ui.find('当前外观示意').props.style['--surface'], '#1c1f1d', 'cancel retains the applied preset')
    assert.equal(closed, 2, 'every decoded bitmap is released, including ignored results')
    assert.equal(ui.writes.length, 0)
  } finally { ui.dispose() }
})

test('candidate colors outside the initial three can be assigned to a selected fixed role without saving', async t => {
  const originalBitmap = globalThis.createImageBitmap, originalDocument = globalThis.document
  t.after(() => { globalThis.createImageBitmap = originalBitmap; globalThis.document = originalDocument })
  globalThis.createImageBitmap = async () => ({ close() {} })
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels(...illustrationAreas) }) }), toDataURL: () => 'data:image/png;base64,fixture' }) }
  const ui = appearanceSection()
  try {
    await ui.find('从图片提取配色').props.onChange({ currentTarget: { files: [{ size: 100, type: 'image/png', name: 'areas.png' }], value: 'areas.png' } })
    const shares = ui.find('主要颜色占比')
    const text = nodes(shares).flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ')
    assert.match(text, /34%/)
    assert.match(text, /28%/)
    assert.match(text, /17%/)
    assert.match(text, /14%/)
    assert.match(text, /7%/)
    assert.equal(nodes(shares).filter(node => node.type === 'button').length, 5)
    assert.equal(ui.writes.length, 0, 'reading area statistics never applies the proposal')
    assert.equal(ui.find('当前外观示意').props.style['--surface'], '#f5eee2')
    ui.find('将 #1672a1 用于强调色').props.onClick()
    assert.equal(ui.find('强调色十六进制值').props.value, '#1672a1', 'a fourth-ranked source color is usable')
    ui.find('编辑侧栏底色').props.onClick()
    ui.find('将 #c06841 用于侧栏底色').props.onClick()
    assert.equal(ui.find('当前外观示意').props.style['--bg'], '#c06841')
    assert.equal(ui.find('当前外观示意').props.style['--surface'], '#f5eee2', 'other roles do not change')
    assert.equal(ui.writes.length, 0)
    const unchangedText = nodes(ui.find('主要颜色占比')).flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ')
    assert.equal(unchangedText, text, 'assigning roles never rewrites source area statistics')
    ui.find('应用自定义配色').props.onClick()
    ui.writes[0].accept(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(ui.scope.getSnapshot().value.customAccent, '#1672a1')
    assert.equal(ui.scope.getSnapshot().value.customBackgroundDark, '#c06841')
    assert.equal(ui.scope.getSnapshot().value.customBackgroundLight, '#f4f4f5')
  } finally { ui.dispose() }
})
