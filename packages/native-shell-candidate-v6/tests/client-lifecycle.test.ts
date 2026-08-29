import { describe, expect, it } from 'vitest'
import {
  BROWSER_BRAND_ICON_HREF,
  apply,
  brandBrowserTitle,
  createSearchCoordinator,
  mountBrowserBrand,
} from '../src/client/index.js'
import { contextFixture, reactFixture } from './fixture.js'

describe('V6 Client lifecycle', () => {
  it('owns only the V6 root seat and releases it', () => {
    const seats = new Map<string, unknown>()
    const ctx = contextFixture({
      inject(name, setup) { expect(name).toBe('root'); return setup() },
      register(options, component) {
        seats.set(`${options.name}:${options.id ?? ''}`, component)
        return () => seats.delete(`${options.name}:${options.id ?? ''}`)
      },
    })
    const dispose = apply(ctx, reactFixture())
    expect([...seats.keys()]).toEqual(['root:xiaoshe-native-shell-candidate-v6'])
    dispose()
    expect(seats.size).toBe(0)
  })

  it('aborts stale searches and refuses work after disposal', async () => {
    const signals: AbortSignal[] = []
    const coordinator = createSearchCoordinator(async (_query, signal) => {
      signals.push(signal)
      return { ok: true, value: { items: [] } }
    })
    await coordinator.search('one')
    await coordinator.search('two')
    expect(signals[0]?.aborted).toBe(true)
    coordinator.dispose()
    expect(signals[1]?.aborted).toBe(true)
    await expect(coordinator.search('three')).resolves.toEqual({ ok: false, error: { message: '搜索已停止' } })
  })

  it('brands only browser metadata with the V6 canonical endpoint', () => {
    expect(brandBrowserTitle('')).toBe('小蛇')
    expect(brandBrowserTitle('DSH Local Build')).toBe('小蛇')
    expect(brandBrowserTitle('整理交接 — DSH Local Build')).toBe('整理交接 — 小蛇')
    expect(BROWSER_BRAND_ICON_HREF).toMatch(/^\/api\/xiaoshe\/candidate-v6-brand-icon\?v=[a-f0-9]{16}$/u)

    type FakeLink = {
      id: string
      removed: boolean
      getAttribute(name: string): string | null
      setAttribute(name: string, value: string): void
      removeAttribute(name: string): void
      remove(): void
    }
    const links: FakeLink[] = []
    const makeLink = (attributes: Record<string, string> = {}): FakeLink => {
      const values = new Map(Object.entries(attributes))
      const link: FakeLink = {
        id: attributes.id ?? '', removed: false,
        getAttribute: name => name === 'id' ? link.id || null : values.get(name) ?? null,
        setAttribute(name, value) { if (name === 'id') link.id = value; else values.set(name, value) },
        removeAttribute(name) { if (name === 'id') link.id = ''; else values.delete(name) },
        remove() { link.removed = true },
      }
      return link
    }
    const hostIcon = makeLink({ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' })
    links.push(hostIcon)
    const fakeDocument = {
      title: 'DSH Local Build',
      head: {
        querySelectorAll: () => links.filter(link => !link.removed),
        appendChild: (link: FakeLink) => { links.push(link); return link },
      },
      createElement: () => makeLink(),
      getElementById: (id: string) => links.find(link => !link.removed && link.id === id) ?? null,
    }
    let replay: (() => void) | undefined
    let disconnected = false
    const dispose = mountBrowserBrand(fakeDocument as unknown as Document, callback => {
      replay = callback
      return { observe() {}, disconnect() { disconnected = true } }
    })

    expect(fakeDocument.title).toBe('小蛇')
    expect(hostIcon.getAttribute('href')).toBe(BROWSER_BRAND_ICON_HREF)
    expect(links.some(link => link.id === 'xiaoshe-candidate-v6-browser-icon' && !link.removed)).toBe(true)
    fakeDocument.title = '整理交接 — DSH Local Build'
    replay?.()
    expect(fakeDocument.title).toBe('整理交接 — 小蛇')

    dispose()
    expect(disconnected).toBe(true)
    expect(fakeDocument.title).toBe('DSH Local Build')
    expect(hostIcon.getAttribute('href')).toBe('/favicon.svg')
  })
})
