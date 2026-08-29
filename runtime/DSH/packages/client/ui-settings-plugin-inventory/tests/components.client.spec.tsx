// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type {
  PluginInventorySettingsTabInjected,
  PluginInventorySettingsTabProps,
} from '../src/client/PluginInventorySettingsTab.tsx'
import { en, zh, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

type Snapshot = Awaited<ReturnType<PluginInventorySettingsTabInjected['list']>>
function props(
  list: PluginInventorySettingsTabInjected['list'],
  locale: Record<PluginInventoryLocaleKey, string> = en,
): PluginInventorySettingsTabProps {
  return {
    t: ((key: PluginInventoryLocaleKey): string => locale[key]) as PluginInventorySettingsTabProps['t'],
    list,
  } as PluginInventorySettingsTabProps
}

const SNAPSHOT = {
  entries: [
    { entryId: '8a1b2c3d', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true, fiberPhase: 'active' },
    { entryId: 'hmr-shadow', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true, fiberPhase: 'active' },
    { entryId: 'pending', moduleName: 'cordis:pending-name', enabled: true, fiberPhase: 'pending' },
    { entryId: 'loading', moduleName: '@fixture/loading-name', enabled: true, fiberPhase: 'loading' },
    { entryId: 'failed', moduleName: '@fixture/failed-name', enabled: true, fiberPhase: 'failed' },
    { entryId: 'unloading', moduleName: '@fixture/unloading-name', enabled: true, fiberPhase: 'unloading' },
    { entryId: 'unobserved', moduleName: '@fixture/unobserved-name', enabled: true, fiberPhase: null },
    { entryId: 'disabled-entry', moduleName: '@deepseek-ai/dsh-host-directory-picker-native', enabled: false, fiberPhase: null },
    { entryId: 'xiaoshe-memory', moduleName: '@xiaoshe/memory', enabled: true, fiberPhase: 'active' },
  ],
} as unknown as Snapshot

describe('PluginInventorySettingsTab', () => {
  it('renders runtime status only for enabled plugins', async () => {
    const deferred = Promise.withResolvers<Snapshot>()
    const list = vi.fn(() => deferred.promise)
    const view = render(<PluginInventorySettingsTab {...props(list)} />)
    expect(screen.getByText(en.loading)).toBeTruthy()

    await act(async () => { deferred.resolve(SNAPSHOT) })
    expect(list).toHaveBeenCalledOnce()
    expect(screen.getByRole('searchbox', { name: en.search })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.catalog })).toBeTruthy()
    expect(view.container.querySelector('[data-plugin-count]')?.textContent).toBe('8')
    expect(view.container.querySelector('[data-plugin-instance-count]')?.textContent).toBe('9')
    expect(view.container.querySelectorAll('[data-plugin-module]')).toHaveLength(8)
    expect(view.container.querySelectorAll('[data-phase]')).toHaveLength(7)
    expect(screen.getByText(en.disabledTag)).toBeTruthy()
    expect(view.container.querySelector('[data-plugin-group="product"]')).toBeTruthy()
    expect(view.container.querySelector('[data-plugin-group="runtime"]')).toBeTruthy()
    const hmrCard = view.container.querySelector('[data-plugin-module="@deepseek-ai/cordis-plugin-hmr"]')
    const active = hmrCard?.querySelector('button') as HTMLButtonElement
    expect(active.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(active)
    expect(active.getAttribute('aria-expanded')).toBe('true')
    expect(hmrCard?.querySelectorAll('[data-loader-entry]')).toHaveLength(2)
    expect(hmrCard?.textContent).toContain('2 instances')
    expect(screen.getByText(en.configuration)).toBeTruthy()
    expect(screen.getByText(en.cordis)).toBeTruthy()
    fireEvent.click(active)
    expect(view.container.querySelector('[data-loader-entry]')).toBeNull()

    fireEvent.click(active)
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), {
      target: { value: 'disabled-entry' },
    })
    expect(view.container.querySelector('[data-loader-entry]')).toBeNull()
    const disabledCard = view.container.querySelector('[data-plugin-module="@deepseek-ai/dsh-host-directory-picker-native"]')
    fireEvent.click(disabledCard?.querySelector('button') as HTMLButtonElement)
    expect(screen.queryByText(en.cordis)).toBeNull()
    expect(screen.queryByText(en.unobserved)).toBeNull()
  })

  it('filters by module name or Loader entry id', async () => {
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT)} />)
    const search = await screen.findByRole('searchbox', { name: en.search })

    fireEvent.change(search, { target: { value: 'disabled-entry' } })
    expect(document.querySelectorAll('[data-plugin-module]')).toHaveLength(1)
    expect(document.querySelector('[data-plugin-module]')?.getAttribute('data-plugin-module')).toBe('@deepseek-ai/dsh-host-directory-picker-native')

    fireEvent.change(search, { target: { value: 'cordis-plugin-hmr' } })
    expect(document.querySelectorAll('[data-plugin-module]')).toHaveLength(1)
    expect(document.querySelector('[data-plugin-module]')?.getAttribute('data-plugin-module')).toBe('@deepseek-ai/cordis-plugin-hmr')

    fireEvent.change(search, { target: { value: 'hmr-shadow' } })
    expect(document.querySelectorAll('[data-plugin-module]')).toHaveLength(1)

    fireEvent.change(search, { target: { value: 'not-a-plugin' } })
    expect(document.querySelectorAll('[data-plugin-module]')).toHaveLength(0)
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })

  it('uses product names and plain-language purposes for known Xiaoshe modules', async () => {
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, zh)} />)
    expect(await screen.findByText('记忆')).toBeTruthy()
    expect(screen.getByText('保存并提供跨会话、跨项目可复用的长期记忆。')).toBeTruthy()
    expect(screen.getByText('小蛇与桌面')).toBeTruthy()
    expect(screen.getByText('8 个组件 · 9 个运行实例')).toBeTruthy()
  })

  it('folds related internal modules into one user-facing capability without hiding technical truth', async () => {
    const familySnapshot = {
      entries: [
        { entryId: 'session-core', moduleName: '@deepseek-ai/dsh-session', enabled: true, fiberPhase: 'active' },
        { entryId: 'session-log', moduleName: '@deepseek-ai/dsh-session-log-export', enabled: true, fiberPhase: 'active' },
      ],
    } as unknown as Snapshot
    const view = render(<PluginInventorySettingsTab {...props(async () => familySnapshot, zh)} />)

    expect(await screen.findByText('会话')).toBeTruthy()
    expect(view.container.querySelector('[data-plugin-count]')?.textContent).toBe('2')
    expect(view.container.querySelectorAll('[data-plugin-capability]')).toHaveLength(1)
    const capability = view.container.querySelector('[data-plugin-capability]')!
    fireEvent.click(capability.querySelector('button') as HTMLButtonElement)
    expect(capability.querySelectorAll('[data-technical-module]')).toHaveLength(2)
    expect(capability.querySelectorAll('[data-loader-entry]')).toHaveLength(2)
  })

  it('shows a generic failure and retries into the empty state', async () => {
    const list = vi.fn<PluginInventorySettingsTabInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ entries: [] })
    render(<PluginInventorySettingsTab {...props(list)} />)

    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('contains a synchronous Remote failure and ignores a result after unmount', async () => {
    const syncFailure = vi.fn(() => { throw new Error('namespace unavailable') }) as PluginInventorySettingsTabInjected['list']
    const failed = render(<PluginInventorySettingsTab {...props(syncFailure)} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    failed.unmount()

    const deferred = Promise.withResolvers<Snapshot>()
    const pending = render(<PluginInventorySettingsTab {...props(() => deferred.promise)} />)
    pending.unmount()
    await act(async () => { deferred.resolve(SNAPSHOT) })

    const deferredFailure = Promise.withResolvers<Snapshot>()
    const pendingFailure = render(<PluginInventorySettingsTab {...props(() => deferredFailure.promise)} />)
    pendingFailure.unmount()
    await act(async () => { deferredFailure.reject(new Error('late failure')) })
  })
})
