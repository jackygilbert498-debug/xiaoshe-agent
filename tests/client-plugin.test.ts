import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Registration {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => {
    apply(ctx: unknown): void
    inject: string[]
  }
}

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))

async function loadClient(status = 200, responseBody: Record<string, unknown> = {}) {
  let registration: Registration | undefined
  let querySelectorImpl: (selector: string) => unknown = () => null
  const requests: Array<{ path: string; options?: Record<string, unknown> }> = []
  const storage = new Map<string, string>()
  const nodes = new Map<string, { id: string; textContent: string; attributes: Map<string, string>; remove(): void }>()
  const bodyAttributes = new Map<string, string>()
  const observerOptions: Array<Record<string, unknown>> = []
  function element(id = '') {
    const attributes = new Map<string, string>()
    return {
      id,
      textContent: '',
      attributes,
      setAttribute(name: string, value: string) { attributes.set(name, value) },
      getAttribute(name: string) { return attributes.get(name) ?? null },
      removeAttribute(name: string) { attributes.delete(name) },
      remove() { nodes.delete(this.id) },
    }
  }
  const nativeIcon = element()
  nativeIcon.setAttribute('rel', 'icon')
  nativeIcon.setAttribute('type', 'image/svg+xml')
  nativeIcon.setAttribute('href', '/favicon.svg')
  const document = {
    title: 'DSH Local Build',
    head: {
      appendChild(node: { id: string }) { nodes.set(node.id, node as never) },
    },
    body: {
      setAttribute(name: string, value: string) { bodyAttributes.set(name, value) },
      removeAttribute(name: string) { bodyAttributes.delete(name) },
      getAttribute(name: string) { return bodyAttributes.get(name) ?? null },
    },
    querySelector(selector: string) { return querySelectorImpl(selector) },
    querySelectorAll(selector: string) { return selector === "link[rel~='icon']" ? [nativeIcon] : [] },
    getElementById(id: string) { return nodes.get(id) ?? null },
    createElement() { return element() },
  }
  class Observer {
    observe(_target: unknown, options?: Record<string, unknown>): void {
      observerOptions.push(options ?? {})
    }
    disconnect(): void {}
  }
  const source = await readFile(clientPath, 'utf8')
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value: Registration) { registration = value } } },
    document,
    MutationObserver: Observer,
    fetch: async (path: unknown, options?: Record<string, unknown>) => {
      requests.push({ path: String(path), ...(options === undefined ? {} : { options }) })
      return { status, ok: status >= 200 && status < 300, json: async () => responseBody }
    },
    localStorage: {
      getItem(key: string) { return storage.get(key) ?? null },
      setItem(key: string, value: string) { storage.set(key, value) },
    },
    Event: class TestEvent {
      readonly type: string
      readonly bubbles: boolean
      constructor(type: string, init?: { bubbles?: boolean }) {
        this.type = type
        this.bubbles = init?.bubbles === true
      }
    },
    console,
    setTimeout,
    clearTimeout,
  })
  if (registration === undefined) throw new Error('client bundle did not register')
  return {
    registration,
    document,
    nodes,
    nativeIcon,
    requests,
    storage,
    observerOptions,
    setQuerySelector(impl: (selector: string) => unknown) { querySelectorImpl = impl },
  }
}

function reactFixture(
  open = false,
  override?: (initial: unknown, index: number) => unknown,
) {
  let stateIndex = 0
  return {
    createElement(type: unknown, props: unknown, ...children: unknown[]) {
      return { type, props, children }
    },
    useEffect() {},
    useId() { return ':fixture:' },
    useState<T>(initial: T | (() => T)) {
      const value = typeof initial === 'function' ? (initial as () => T)() : initial
      const index = stateIndex++
      let current = (override === undefined
        ? (open ? true : value)
        : override(value, index)) as T
      return [current, (next: T | ((value: T) => T)) => {
        current = typeof next === 'function' ? (next as (value: T) => T)(current) : next
      }] as const
    },
  }
}

function nodeText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(nodeText).join('')
  if (typeof value !== 'object' || value === null) return ''
  const node = value as { children?: unknown[] }
  return nodeText(node.children ?? [])
}

function findNodes(value: unknown, predicate: (node: { type?: unknown; props?: Record<string, unknown> }) => boolean): Array<{ type?: unknown; props?: Record<string, unknown>; children?: unknown[] }> {
  if (Array.isArray(value)) return value.flatMap(child => findNodes(child, predicate))
  if (typeof value !== 'object' || value === null) return []
  const node = value as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
  return [
    ...(predicate(node) ? [node] : []),
    ...findNodes(node.children ?? [], predicate),
  ]
}

describe('browser product plugin', () => {
  it('does not start the archived ribbon background in the active product shell', async () => {
    const { registration, observerOptions } = await loadClient()
    const ctx = {
      slots: {
        inject(_name: string, callback: () => unknown) { return callback() },
        register() { return () => {} },
      },
      inject(_services: string[], callback: (scope: unknown) => void) { callback(ctx) },
      effect(execute: () => () => void) { return execute() },
    }
    const plugin = registration.factory((id) => {
      if (id === 'react') return reactFixture()
      throw new Error(`unexpected module ${id}`)
    })

    plugin.apply(ctx)

    expect(observerOptions).not.toContainEqual(expect.objectContaining({
      attributeFilter: ['data-phase'],
    }))
  })

  it('fills Xiaoshe brand slots and the settings card through declared seats', async () => {
    const clientSource = await readFile(clientPath, 'utf8')
    const { registration, document, nodes, nativeIcon, requests } = await loadClient()
    const entries: Array<{ spec: Record<string, unknown>; component: (props?: unknown) => unknown }> = []
    const cleanups: Array<() => void> = []
    const slots = {
      inject(_name: string, callback: () => unknown) {
        const result = callback()
        if (typeof result === 'object' && result !== null && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) { /* registrations execute while iterating */ }
        }
        return result
      },
      register(spec: Record<string, unknown>, component: (props?: unknown) => unknown) {
        entries.push({ spec, component })
        return () => {}
      },
    }
    const ctx = {
      slots,
      inject(_services: string[], callback: (scope: unknown) => void) { callback(ctx) },
      effect(execute: () => () => void) { cleanups.push(execute()) },
    }
    const plugin = registration.factory((id) => {
      if (id === 'react') return reactFixture(false, (initial, index) => {
        if (index === 0) return true
        if (index === 1) {
          return {
            response_style: 'pragmatic',
            bridge: { state: 'ready', platform: 'win32' },
            actions: { enabled: true, deployment_allowed: true, persistent: true },
            modlens_available: true,
            last_probe: { state: 'unknown', message: '尚未检测屏幕权限。' },
          }
        }
        return initial
      })
      throw new Error(`unexpected module ${id}`)
    })
    plugin.apply(ctx)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(registration.id).toBe('@xiaoshe/dsh-desktop-control')
    expect(document.title).toBe('小蛇')
    expect(nodes.get('xiaoshe-browser-favicon')?.attributes.get('rel')).toBe('icon')
    expect(nodes.get('xiaoshe-browser-favicon')?.attributes.get('type')).toBe('image/svg+xml')
    expect(nodes.get('xiaoshe-browser-favicon')?.attributes.get('href')).toBe('/xiaoshe/brand/favicon.svg?v=0.2.0')
    expect(nativeIcon.getAttribute('href')).toBe('/xiaoshe/brand/favicon.svg?v=0.2.0')
    expect(document.body.getAttribute('data-xiaoshe-shell')).toBe('product-v1')
    expect(nodes.get('xiaoshe-product-theme-v1')?.attributes.get('data-xiaoshe-theme')).toBe('product-shell-v1')
    const themeCss = nodes.get('xiaoshe-product-theme-v1')?.textContent ?? ''
    expect(themeCss).toContain('--xiaoshe-sheen-1: #23362d')
    expect(themeCss).toContain('--xiaoshe-sheen-4: #d7c27f')
    expect(themeCss).toContain('--xiaoshe-active-mark-opacity: 0.055')
    expect(themeCss).toContain('background-clip: text')
    expect(themeCss).toContain('[data-xiaoshe-hero-outline-mark]')
    expect(themeCss).toContain('[data-xiaoshe-task-record]')
    expect(themeCss).toContain('[data-xiaoshe-conversation-tabs]')
    expect(themeCss).toContain('[data-xiaoshe-auto-orchestration]')
    expect(themeCss).toContain('[data-xiaoshe-permission-control]')
    expect(clientSource).toContain("rename(button, 'Session log', '任务记录')")
    expect(clientSource).toContain("rename(tablist, '轨迹', '行动')")
    expect(clientSource).toContain("rename(button, '创建能力方案', '自动编排')")
    expect(clientSource).toContain("rename(labelNode, '创建能力方案', '自动编排')")
    expect(themeCss).toContain('font-family: "Noto Serif SC", "Songti SC", serif')
    expect(themeCss).toContain('filter: drop-shadow(0 4px 9px')
    expect(entries.map(entry => entry.spec.name)).toEqual([
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
      'shell.overlay',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'settings.general.item',
    ])
    expect(entries.slice(0, 3).map(entry => entry.spec.priority)).toEqual([-100, -100, -100])
    expect(entries.filter(entry => entry.spec.name === 'tool.call.toolview').map(entry => entry.spec.key)).toEqual([
      'screen_observe',
      'screen_zoom',
      'screen_verify',
      'screen_list_windows',
      'screen_click',
      'screen_type',
      'screen_press',
      'screen_focus_window',
    ])
    expect(entries.at(-1)?.spec).toMatchObject({ id: 'xiaoshe-desktop', key: 'xiaoshe-desktop', order: 20 })
    const settingsNode = entries.at(-1)?.component()
    expect(nodeText(settingsNode)).toContain('运行与偏好')
    expect(nodeText(settingsNode)).toContain('会话与项目')
    expect(nodeText(settingsNode)).toContain('长期记忆')
    expect(nodeText(settingsNode)).toContain('行动边界')
    expect(nodeText(settingsNode)).toContain('运行心跳')
    expect(nodeText(settingsNode)).toContain('表达方式亲和温暖、协作、贴心务实简洁、专注、直接')
    const modes = findNodes(settingsNode, node => node.props?.role === 'radio')
    expect(modes.map(node => node.props?.['aria-checked'])).toEqual([false, true])
    expect(modes.map(nodeText)).toEqual(['亲和温暖、协作、贴心', '务实简洁、专注、直接'])
    ;(modes[0]?.props?.onClick as (() => void) | undefined)?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(requests.find(request => request.path === '/xiaoshe/preferences')).toMatchObject({
      path: '/xiaoshe/preferences',
      options: { method: 'POST', body: JSON.stringify({ response_style: 'friendly' }) },
    })
    const nameNode = entries[1]?.component()
    expect(nodeText(nameNode)).toContain('小蛇DESKTOP · AGENT')
    const heroNode = entries.find(entry => entry.spec.name === 'conversation.hero.brand.mark')?.component()
    expect(nodeText(heroNode)).toContain('小蛇待命 · DESKTOP AGENT')
    expect(nodeText(heroNode)).toContain('看懂你的屏幕，接手电脑里的任务；关键动作先问你，做完再验证。')
    expect(nodeText(heroNode)).toContain('看得见桌面真能动手做关键操作可控')
    expect(nodeText(heroNode)).not.toContain('看看当前屏幕')
    expect(nodeText(heroNode)).not.toContain('预览版')
    const heroWord = findNodes(heroNode, node => node.props?.['data-xiaoshe-hero-word'] === '')
    expect(heroWord.map(nodeText)).toEqual(['小蛇'])
    expect(findNodes(heroNode, node => node.props?.['data-xiaoshe-hero-glyph'] !== undefined)).toHaveLength(0)
    expect(findNodes(heroNode, node => node.props?.['data-xiaoshe-hero-logo'] === '')).toHaveLength(0)
    expect(findNodes(heroNode, node => node.props?.['data-xiaoshe-hero-outline-mark'] === '')).toHaveLength(0)
    const renderedMark = entries.find(entry => entry.spec.name === 'sidebar.brand.mark')?.component({ size: 210 })
    expect((renderedMark as { type?: unknown })?.type).toBe('span')
    expect((renderedMark as { props?: Record<string, unknown> })?.props?.role).toBe('img')
    expect((renderedMark as { props?: Record<string, unknown> })?.props?.style).toMatchObject({
      maskImage: 'url(/xiaoshe/brand/favicon.svg?v=0.2.0)',
    })
    const inspector = entries.find(entry => entry.spec.name === 'shell.overlay')
    expect(inspector?.spec).toMatchObject({ id: 'xiaoshe-inspector', key: 'xiaoshe-inspector', order: 40 })
    const inspectorNode = inspector?.component()
    expect(nodeText(inspectorNode)).toContain('新会话')
    expect(nodeText(inspectorNode)).toContain('小蛇工作台')
    expect(nodeText(inspectorNode)).toContain('运行记忆边界')
    expect(nodeText(inspectorNode)).toContain('当前回合')
    expect(nodeText(inspectorNode)).toContain('行动脉络')
    expect(nodeText(inspectorNode)).toContain('当前环境')
    expect(findNodes(inspectorNode, node => node.props?.['data-xiaoshe-panel-icon'] === '')).toHaveLength(1)

    for (const cleanup of cleanups.reverse()) cleanup()
    expect(document.title).toBe('DSH Local Build')
    expect(nodes.has('xiaoshe-browser-favicon')).toBe(false)
    expect(nativeIcon.getAttribute('href')).toBe('/favicon.svg')
    expect(document.body.getAttribute('data-xiaoshe-shell')).toBeNull()
    expect(nodes.has('xiaoshe-product-theme-v1')).toBe(false)
  })

  it('persists the right workbench collapse preference without replacing the native left rail', async () => {
    const { registration, storage, setQuerySelector } = await loadClient()
    const entries: Array<{ spec: Record<string, unknown>; component: (props?: unknown) => unknown }> = []
    const slots = {
      inject(_name: string, callback: () => unknown) {
        const result = callback()
        if (typeof result === 'object' && result !== null && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) { /* drive generator */ }
        }
        return result
      },
      register(spec: Record<string, unknown>, component: (props?: unknown) => unknown) {
        entries.push({ spec, component })
        return () => {}
      },
    }
    const ctx = {
      slots,
      inject(_services: string[], callback: (scope: unknown) => void) { callback(ctx) },
      effect(execute: () => () => void) { execute() },
    }
    registration.factory((id) => {
      if (id === 'react') return reactFixture()
      throw new Error(`unexpected module ${id}`)
    }).apply(ctx)

    setQuerySelector(selector => selector === "[data-slot='root'] > div"
      ? { firstElementChild: { getBoundingClientRect: () => ({ width: 56 }) } }
      : selector === "[data-phase='active']" ? {} : null)
    const inspector = entries.find(entry => entry.spec.name === 'shell.overlay')?.component()
    expect((inspector as { props?: { style?: Record<string, string> } })?.props?.style?.['--xiaoshe-sidebar-width']).toBe('56px')
    expect(nodeText(inspector)).toContain('随当前会话')
    const collapse = findNodes(inspector, node => node.props?.['data-xiaoshe-inspector-collapse'] === '')[0]
    if (collapse === undefined) throw new Error('workbench collapse button was not rendered')
    expect(collapse.props?.['aria-label']).toBe('收起工作台')
    ;(collapse.props?.onClick as () => void)()
    expect(storage.get('xiaoshe.inspector.collapsed')).toBe('true')
  })

  it('renders the three product capabilities as static descriptions rather than generic task buttons', async () => {
    const { registration } = await loadClient()
    const entries: Array<{ spec: Record<string, unknown>; component: (props?: unknown) => unknown }> = []
    const slots = {
      inject(_name: string, callback: () => unknown) {
        const result = callback()
        if (typeof result === 'object' && result !== null && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) { /* drive generator */ }
        }
        return result
      },
      register(spec: Record<string, unknown>, component: (props?: unknown) => unknown) {
        entries.push({ spec, component })
        return () => {}
      },
    }
    const ctx = {
      slots,
      inject(_services: string[], callback: (scope: unknown) => void) { callback(ctx) },
      effect(execute: () => () => void) { execute() },
    }
    registration.factory((id) => {
      if (id === 'react') return reactFixture()
      throw new Error(`unexpected module ${id}`)
    }).apply(ctx)

    const hero = entries.find(entry => entry.spec.name === 'conversation.hero.brand.mark')?.component()
    const capabilities = findNodes(hero, node => node.props?.['data-xiaoshe-hero-capability'] === '')
    const heroMark = findNodes(hero, node => node.props?.['data-xiaoshe-hero-outline-mark'] === '')
    const officialSource = findNodes(hero, node => node.type === 'image' && node.props?.href === '/xiaoshe/brand/favicon.svg?v=0.2.0')
    expect(capabilities.map(nodeText)).toEqual(['看得见桌面', '真能动手做', '关键操作可控'])
    expect(heroMark).toHaveLength(0)
    expect(officialSource).toHaveLength(0)
    expect(findNodes(hero, node => node.props?.['data-xiaoshe-hero-logo'] === '')).toHaveLength(0)
    expect(findNodes(hero, node => node.props?.['data-xiaoshe-quick-prompt'] === '')).toHaveLength(0)
  })

  it('renders editable scoped memory and sends revision-guarded project writes', async () => {
    const snapshot = {
      api_version: 1,
      revision: 4,
      counts: { active: 2, global: 1, project: 1, forgotten: 1, superseded: 0 },
      entries: [
        { id: 'g1', scope: 'global', text: '默认使用自然中文回答', state: 'active', version: 1, created_at: '2026-08-22T00:00:00.000Z', updated_at: '2026-08-22T00:00:00.000Z' },
        { id: 'p1', scope: 'project', project: 'C:\\Users\\example\\Desktop\\XS', text: 'XS 项目使用 pnpm', state: 'active', version: 1, created_at: '2026-08-22T00:00:00.000Z', updated_at: '2026-08-22T00:00:00.000Z' },
        { id: 'f1', scope: 'global', text: '旧偏好', state: 'forgotten', version: 1, created_at: '2026-08-22T00:00:00.000Z', updated_at: '2026-08-22T00:00:00.000Z' },
      ],
      audit: [],
    }
    const { registration, requests } = await loadClient(200, snapshot)
    const entries: Array<{ spec: Record<string, unknown>; component: (props?: unknown) => unknown }> = []
    const slots = {
      inject(_name: string, callback: () => unknown) {
        const result = callback()
        if (typeof result === 'object' && result !== null && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) { /* drive generator */ }
        }
        return result
      },
      register(spec: Record<string, unknown>, component: (props?: unknown) => unknown) {
        entries.push({ spec, component })
        return () => {}
      },
    }
    const ctx = {
      slots,
      inject(_services: string[], callback: (scope: unknown) => void) { callback(ctx) },
      effect(execute: () => () => void) { execute() },
    }
    registration.factory((id) => {
      if (id !== 'react') throw new Error(`unexpected module ${id}`)
      return reactFixture(false, (value, index) => {
        if (index === 0) return 'memory'
        if (index === 7) return snapshot
        if (index === 8) return 'project'
        if (index === 9) return '更新后的项目偏好'
        return value
      })
    }).apply(ctx)

    const inspector = entries.find(entry => entry.spec.name === 'shell.overlay')?.component({
      useSessions(selector: (state: unknown) => unknown) {
        return selector({
          current: 's1',
          byId: { s1: { id: 's1', cwd: 'C:\\Users\\example\\Desktop\\XS' } },
        })
      },
      useWorkspaces(selector: (state: unknown) => unknown) {
        return selector({
          items: [{
            workspaceId: 'w1',
            title: 'XS',
            path: 'C:\\Users\\example\\Desktop\\XS',
            sessionIds: ['s1'],
          }],
        })
      },
    })
    const text = nodeText(inspector)
    expect(text).toContain('长期')
    expect(text).toContain('当前项目')
    expect(text).toContain('已遗忘')
    expect(text).toContain('默认使用自然中文回答')
    expect(text).toContain('XS 项目使用 pnpm')
    expect(text).toContain('旧偏好')
    expect(text).toContain('编辑')
    expect(text).toContain('遗忘')
    expect(text).toContain('恢复')

    const form = findNodes(inspector, node => node.props?.['data-xiaoshe-memory-form'] === '')[0]
    if (form === undefined) throw new Error('memory form was not rendered')
    await (form.props?.onSubmit as (event: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} })
    const write = requests.find(request => request.path === '/xiaoshe/memory' && request.options?.method === 'POST')
    expect(write?.options?.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(write?.options?.body))).toEqual({
      action: 'remember',
      expected_revision: 4,
      scope: 'project',
      project: 'C:\\Users\\example\\Desktop\\XS',
      text: '更新后的项目偏好',
    })
  })

  it('does not mount a dead settings card when the host route is absent', async () => {
    const { registration } = await loadClient(404)
    const names: string[] = []
    const slots = {
      inject(_name: string, callback: () => unknown) {
        const result = callback()
        if (typeof result === 'object' && result !== null && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) { /* drive generator */ }
        }
        return result
      },
      register(spec: { name: string }) { names.push(spec.name); return () => {} },
    }
    const ctx = {
      slots,
      inject(_services: string[], callback: (scope: unknown) => void) { callback(ctx) },
      effect(execute: () => () => void) { execute() },
    }
    registration.factory(() => reactFixture()).apply(ctx)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(names).toEqual([
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
      'shell.overlay',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
    ])
  })

  it('replays presenter-owned desktop evidence without exposing raw input text', async () => {
    const { registration } = await loadClient()
    const entries: Array<{ spec: Record<string, unknown>; component: (props?: unknown) => unknown }> = []
    const slots = {
      inject(_name: string, callback: () => unknown) {
        const result = callback()
        if (typeof result === 'object' && result !== null && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) { /* drive generator */ }
        }
        return result
      },
      register(spec: Record<string, unknown>, component: (props?: unknown) => unknown) {
        entries.push({ spec, component })
        return () => {}
      },
    }
    const ctx = {
      slots,
      inject(_services: string[], callback: (scope: unknown) => void) { callback(ctx) },
      effect(execute: () => () => void) { execute() },
    }
    registration.factory((id) => {
      if (id === 'react') return reactFixture(true)
      throw new Error(`unexpected module ${id}`)
    }).apply(ctx)

    const typeCard = entries.find(entry => entry.spec.key === 'screen_type')?.component
    if (typeCard === undefined) throw new Error('screen_type card was not registered')
    const rendered = typeCard({
      toolName: 'screen_type',
      block: {
        kind: 'tool-result',
        isError: false,
        call: { name: 'screen_type', argsRaw: '{"text":"private-secret"}' },
        callView: {
          card: 'generic',
          title: '向当前控件输入 14 个字符',
          rawInput: { text: '[已隐藏]', text_length: 14 },
        },
        resultView: {
          card: 'generic',
          title: '输入已完成 · 界面有变化',
          content: [{ type: 'text', text: '操作前 v4\n操作后 v5\n新增元素 0 个 · 移除元素 1 个' }],
        },
        content: [{ type: 'text', text: 'private-secret' }],
      },
    })
    const text = nodeText(rendered)
    expect(text).toContain('输入已完成 · 界面有变化')
    expect(text).toContain('操作前 v4')
    expect(text).toContain('操作后 v5')
    expect(text).not.toContain('private-secret')
  })
})
