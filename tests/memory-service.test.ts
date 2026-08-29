import { describe, expect, it } from 'vitest'
import {
  createMemoryService,
  memorySettingsSchema,
  MemoryRevisionConflictError,
  type MemoryService,
} from '../src/memory-service.js'
import type { JsonValue, SettingsScopeLike } from '../src/types.js'

class TestSettings implements SettingsScopeLike {
  private value: Record<string, JsonValue>

  constructor(options: { deferUpdates?: boolean; initial?: Record<string, JsonValue> } = {}) {
    this.deferUpdates = options.deferUpdates === true
    this.value = options.initial ?? {}
  }

  private readonly deferUpdates: boolean

  get(): Record<string, JsonValue> { return this.value }
  watch(): () => void { return () => {} }
  async update(patch: Record<string, JsonValue>): Promise<void> {
    if (this.deferUpdates) await new Promise<void>(resolve => setTimeout(resolve, 0))
    this.value = { ...this.value, ...patch }
  }
}

function fixture(settings = new TestSettings()): { service: MemoryService; settings: TestSettings } {
  let id = 0
  let tick = 0
  const service = createMemoryService(settings, {
    createId: () => `memory-${++id}`,
    now: () => new Date(`2026-08-22T00:00:0${tick++}.000Z`),
  })
  return { service, settings }
}

describe('Xiaoshe memory service', () => {
  it('persists a trimmed global memory through the DSH settings scope', async () => {
    const state = fixture()

    const snapshot = await state.service.remember({ scope: 'global', text: '  喜欢正山小种  ' }, 0)

    expect(snapshot).toMatchObject({
      api_version: 1,
      revision: 1,
      counts: { active: 1, global: 1, project: 0, forgotten: 0, superseded: 0 },
      entries: [{
        id: 'memory-1',
        scope: 'global',
        text: '喜欢正山小种',
        state: 'active',
        version: 1,
        created_at: '2026-08-22T00:00:00.000Z',
        updated_at: '2026-08-22T00:00:00.000Z',
      }],
    })

    const reloaded = createMemoryService(state.settings).snapshot({ scope: 'global' })
    expect(reloaded.revision).toBe(1)
    expect(reloaded.entries.map(entry => entry.text)).toEqual(['喜欢正山小种'])
  })

  it('edits project memory by superseding the prior version instead of erasing history', async () => {
    const state = fixture()
    const created = await state.service.remember({ scope: 'project', project: 'XS', text: '先完成 Windows' }, 0)
    const originalId = created.entries[0]?.id
    if (originalId === undefined) throw new Error('missing created memory')

    const edited = await state.service.remember({
      scope: 'project',
      project: 'XS',
      text: '先完成 Windows，再交接其他设备',
      replaces_id: originalId,
    }, 1)

    expect(edited).toMatchObject({
      revision: 2,
      counts: { active: 1, global: 0, project: 1, forgotten: 0, superseded: 1 },
      entries: [{
        id: 'memory-2',
        scope: 'project',
        project: 'XS',
        text: '先完成 Windows，再交接其他设备',
        state: 'active',
        version: 2,
        supersedes: originalId,
        created_at: '2026-08-22T00:00:01.000Z',
      }],
    })

    const history = state.service.snapshot({ scope: 'project', project: 'XS', include_inactive: true })
    expect(history.entries).toMatchObject([
      { id: originalId, state: 'superseded', superseded_by: 'memory-2' },
      { id: 'memory-2', state: 'active', supersedes: originalId },
    ])
  })

  it('forgets and restores memory without deleting the durable entry', async () => {
    const state = fixture()
    const created = await state.service.remember({ scope: 'global', text: '默认使用中文' }, 0)
    const id = created.entries[0]?.id
    if (id === undefined) throw new Error('missing created memory')

    const forgotten = await state.service.setState(id, 'forgotten', 1)
    expect(forgotten).toMatchObject({
      revision: 2,
      counts: { active: 0, forgotten: 1 },
      entries: [],
    })
    expect(state.service.snapshot({ include_inactive: true }).entries).toMatchObject([
      { id, state: 'forgotten', updated_at: '2026-08-22T00:00:01.000Z' },
    ])

    const restored = await state.service.setState(id, 'active', 2)
    expect(restored).toMatchObject({
      revision: 3,
      counts: { active: 1, forgotten: 0 },
      entries: [{ id, state: 'active', version: 1, updated_at: '2026-08-22T00:00:02.000Z' }],
    })
  })

  it('rejects a stale writer with the current revision instead of overwriting newer memory', async () => {
    const state = fixture()
    await state.service.remember({ scope: 'global', text: '第一条' }, 0)

    await expect(state.service.remember({ scope: 'global', text: '陈旧写入' }, 0))
      .rejects.toEqual(new MemoryRevisionConflictError(0, 1))
    expect(state.service.snapshot().entries.map(entry => entry.text)).toEqual(['第一条'])
  })

  it('serializes concurrent writers so identical expected revisions cannot both commit', async () => {
    const state = fixture(new TestSettings({ deferUpdates: true }))

    const results = await Promise.allSettled([
      state.service.remember({ scope: 'global', text: '并发一' }, 0),
      state.service.remember({ scope: 'global', text: '并发二' }, 0),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([
      { reason: new MemoryRevisionConflictError(0, 1) },
    ])
    expect(state.service.snapshot()).toMatchObject({ revision: 1, counts: { active: 1 } })
  })

  it('rejects malformed scope and oversized text before changing durable state', async () => {
    const state = fixture()

    await expect(state.service.remember({ scope: 'project', text: '缺少项目键' }, 0))
      .rejects.toThrow(/project/i)
    await expect(state.service.remember({ scope: 'global', project: 'XS', text: '错误项目键' }, 0))
      .rejects.toThrow(/project/i)
    await expect(state.service.remember({ scope: 'global', text: '字'.repeat(4_001) }, 0))
      .rejects.toThrow(/4000/)
    expect(state.service.snapshot()).toMatchObject({ revision: 0, entries: [] })
  })

  it('records bounded audit actions for create, edit, forget and restore', async () => {
    const state = fixture()
    const created = await state.service.remember({ scope: 'global', text: '初版' }, 0)
    const firstId = created.entries[0]?.id
    if (firstId === undefined) throw new Error('missing created memory')
    const edited = await state.service.remember({ scope: 'global', text: '新版', replaces_id: firstId }, 1)
    const secondId = edited.entries[0]?.id
    if (secondId === undefined) throw new Error('missing edited memory')
    await state.service.setState(secondId, 'forgotten', 2)
    const restored = await state.service.setState(secondId, 'active', 3)

    expect(restored.audit).toMatchObject([
      { revision: 1, action: 'create', entry_id: firstId },
      { revision: 2, action: 'edit', entry_id: secondId, previous_entry_id: firstId },
      { revision: 3, action: 'forget', entry_id: secondId },
      { revision: 4, action: 'restore', entry_id: secondId },
    ])
  })

  it('validates the complete memory settings value and refuses unknown persisted fields', () => {
    expect(memorySettingsSchema(undefined)).toEqual({})
    expect(memorySettingsSchema({ revision: 0, entries: [], audit: [] }))
      .toEqual({ revision: 0, entries: [], audit: [] })
    expect(() => memorySettingsSchema({ revision: 0, entries: [], audit: [], typo: true }))
      .toThrow(/Unknown/)
    expect(() => memorySettingsSchema({ revision: -1, entries: [], audit: [] }))
      .toThrow(/revision/)
  })

  it('refuses the 501st durable entry instead of growing the profile without a bound', async () => {
    const entries = Array.from({ length: 500 }, (_, index) => ({
      id: `seed-${index}`,
      scope: 'global',
      text: `seed ${index}`,
      state: 'active',
      version: 1,
      created_at: '2026-08-21T00:00:00.000Z',
      updated_at: '2026-08-21T00:00:00.000Z',
    })) as unknown as JsonValue
    const settings = new TestSettings({ initial: { revision: 500, entries, audit: [] } })
    const state = fixture(settings)

    await expect(state.service.remember({ scope: 'global', text: '第 501 条' }, 500))
      .rejects.toThrow(/500/)
    expect(state.service.snapshot()).toMatchObject({ revision: 500, counts: { active: 500 } })
  })
})
