import { describe, expect, it } from 'vitest'
import {
  BROWSER_BRAND_ICON_HREF,
  apply,
  brandBrowserTitle,
  clearComposerDraft,
  COMPOSER_DRAFT_STORAGE_PREFIX,
  createSearchCoordinator,
  mountBrowserBrand,
  readComposerDraft,
  writeComposerDraft,
} from '../src/client/index.js'
import { contextFixture, reactFixture } from './fixture.js'

describe('Legacy-adapted Client lifecycle', () => {
  it('isolates recoverable text and image drafts by session and fails closed on damaged storage', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    const image = { id: 'i1', name: 'screen.png', size: 3, mediaType: 'image/png' as const, data: 'AQID' }

    expect(writeComposerDraft(storage, 's1', { text: '会话一', images: [image] })).toEqual({ ok: true })
    expect(writeComposerDraft(storage, 's2', { text: '会话二', images: [] })).toEqual({ ok: true })
    expect(readComposerDraft(storage, 's1')).toEqual({ text: '会话一', images: [image] })
    expect(readComposerDraft(storage, 's2')).toEqual({ text: '会话二', images: [] })

    clearComposerDraft(storage, 's1')
    expect(readComposerDraft(storage, 's1')).toEqual({ text: '', images: [] })
    expect(readComposerDraft(storage, 's2').text).toBe('会话二')

    values.set(`${COMPOSER_DRAFT_STORAGE_PREFIX}${encodeURIComponent('broken')}`, '{bad json')
    expect(readComposerDraft(storage, 'broken')).toEqual({ text: '', images: [] })

    const quotaStorage = { ...storage, setItem: () => { throw new DOMException('quota', 'QuotaExceededError') } }
    expect(writeComposerDraft(quotaStorage, undefined, { text: '临时草稿', images: [] })).toMatchObject({
      ok: false,
      reason: 'storage-unavailable',
    })
  })

  it('owns the adapted root plus its feature-owned settings pages and releases all seats', () => {
    const seats = new Map<string, unknown>()
    const ctx = contextFixture({
      inject(name, setup) { expect(['settings.trigger', 'settings.header', 'settings.general.item', 'settings.section', 'root']).toContain(name); return setup() },
      register(options, component) {
        seats.set(`${options.name}:${options.id ?? ''}`, component)
        return () => seats.delete(`${options.name}:${options.id ?? ''}`)
      },
    })
    const dispose = apply(ctx, reactFixture())
    expect([...seats.keys()]).toEqual([
      'settings.trigger:xiaoshe-settings-trigger',
      'settings.header:xiaoshe-settings-header',
      'settings.general.item:xiaoshe-composer-enter',
      'settings.section:security',
      'settings.section:shortcuts',
      'settings.section:about',
      'root:xiaoshe-native-shell-legacy-adapted',
    ])
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

  it('brands only browser metadata with the Legacy-adapted canonical endpoint', () => {
    expect(brandBrowserTitle('')).toBe('小蛇')
    expect(brandBrowserTitle('DSH Local Build')).toBe('小蛇')
    expect(brandBrowserTitle('整理交接 — DSH Local Build')).toBe('整理交接 — 小蛇')
    expect(BROWSER_BRAND_ICON_HREF).toMatch(/^\/api\/xiaoshe\/legacy-adapted-brand-icon\?v=[a-f0-9]{16}$/u)

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
    expect(links.some(link => link.id === 'xiaoshe-legacy-adapted-browser-icon' && !link.removed)).toBe(true)
    const lateHostIcon = makeLink({ rel: 'shortcut icon', href: '/late-host.ico', type: 'image/x-icon' })
    links.push(lateHostIcon)
    fakeDocument.title = '整理交接 — DSH Local Build'
    replay?.()
    expect(fakeDocument.title).toBe('整理交接 — 小蛇')
    expect(lateHostIcon.getAttribute('rel')).toBe('alternate')
    expect(links.filter(link => !link.removed && link.getAttribute('rel')?.split(/\s+/u).includes('icon'))).toHaveLength(1)

    dispose()
    expect(disconnected).toBe(true)
    expect(fakeDocument.title).toBe('DSH Local Build')
    expect(hostIcon.getAttribute('href')).toBe('/favicon.svg')
    expect(lateHostIcon.getAttribute('rel')).toBe('shortcut icon')
  })
})
