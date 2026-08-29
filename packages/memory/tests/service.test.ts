import { describe, expect, it } from 'vitest'
import { canonicalProjectKey, createMemoryService, selectMemoryInjection } from '../src/service.js'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

class TestSettings {
  private value: Record<string, JsonValue>
  updates = 0

  constructor(initial: Record<string, JsonValue> = {}) {
    this.value = initial
  }

  get(): Record<string, JsonValue> { return this.value }
  watch(): () => void { return () => {} }
  async update(patch: Record<string, JsonValue>): Promise<void> {
    this.updates += 1
    this.value = { ...this.value, ...patch }
  }
}

describe('Product memory service boundary', () => {
  it('canonicalizes Windows paths, UNC paths and lexical aliases deterministically', () => {
    expect(canonicalProjectKey(' C:/Users/example/Desktop/XS/./child/.. ')).toBe('c:\\users\\example\\desktop\\xs')
    expect(canonicalProjectKey('c:\\users\\example\\DESKTOP\\xs\\')).toBe('c:\\users\\example\\desktop\\xs')
    expect(canonicalProjectKey('\\\\SERVER\\Share\\folder\\..\\XS')).toBe('\\\\server\\share\\xs')
    expect(canonicalProjectKey('/Users/Example/XS/../xs')).toBe('/Users/Example/xs')
  })

  it('matches legacy project keys dynamically and resolves real-path aliases for new records', async () => {
    const legacy = new TestSettings({
      revision: 1,
      entries: [{
        id: 'legacy-1', scope: 'project', project: 'C:\\Users\\example\\Desktop\\XS', text: '旧记录仍然可用',
        state: 'active', version: 1, created_at: '2026-08-25T00:00:00.000Z', updated_at: '2026-08-25T00:00:00.000Z',
      }],
      audit: [],
      usage: [],
    })
    const resolveProject = (value: string): string => value.toLowerCase().includes('\\alias')
      ? 'C:\\Users\\example\\Desktop\\XS'
      : value
    const service = createMemoryService(legacy, {
      createId: () => 'alias-1',
      realpath: resolveProject,
    })

    expect(canonicalProjectKey('C:\\Users\\example\\Desktop\\XS', { realpath: resolveProject }))
      .toBe(canonicalProjectKey('c:/users/example/desktop/xs/./', { realpath: resolveProject }))
    expect(service.snapshot({ include_inactive: true }).entries.map(entry => entry.id)).toEqual(['legacy-1'])
    expect(service.snapshot({ scope: 'project', project: 'c:/users/example/desktop/xs/./' }).entries.map(entry => entry.id))
      .toEqual(['legacy-1'])
    expect(service.injection('C:\\USERS\\example\\desktop\\xs').items.map(item => item.id)).toEqual(['legacy-1'])

    const next = await service.remember({
      scope: 'project',
      project: 'C:\\Users\\example\\Desktop\\alias',
      text: '别名写入同一项目',
    }, 1)
    expect(next.entries.find(entry => entry.id === 'alias-1')?.project).toBe('c:\\users\\example\\desktop\\xs')
    expect(service.snapshot({ scope: 'project', project: 'C:\\Users\\example\\Desktop\\XS' }).entries.map(entry => entry.id))
      .toEqual(['legacy-1', 'alias-1'])
  })

  it('selects active global and exact-project memory only', async () => {
    let id = 0
    const service = createMemoryService(new TestSettings(), {
      createId: () => `memory-${++id}`,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    })

    await service.remember({ scope: 'global', text: '默认用中文' }, 0)
    await service.remember({
      scope: 'project',
      project: 'C:\\Users\\example\\Desktop\\XS',
      text: '保留三个工作树',
    }, 1)
    await service.remember({
      scope: 'project',
      project: 'C:\\Users\\example\\Desktop\\other',
      text: '另一个项目',
    }, 2)
    const forgotten = await service.remember({ scope: 'global', text: '已经忘记' }, 3)
    const forgottenId = forgotten.entries.find(entry => entry.text === '已经忘记')?.id
    if (forgottenId === undefined) throw new Error('missing forgotten fixture')
    await service.setState(forgottenId, 'forgotten', 4)

    const injection = selectMemoryInjection(
      service.snapshot({ scope: 'all', include_inactive: true }),
      'C:\\Users\\example\\Desktop\\XS',
    )

    expect(injection.project).toBe('c:\\users\\example\\desktop\\xs')
    expect(injection.items).toEqual([
      { id: 'memory-1', version: 1, scope: 'global', reason: 'global-preference' },
      { id: 'memory-2', version: 1, scope: 'project', reason: 'project-context' },
    ])
    expect(injection.text).toContain('默认用中文')
    expect(injection.text).toContain('保留三个工作树')
    expect(injection.text).not.toContain('另一个项目')
    expect(injection.text).not.toContain('已经忘记')
  })

  it('renders stable escaped trace frames in creation order', async () => {
    let id = 0
    const service = createMemoryService(new TestSettings(), { createId: () => `memory-${++id}` })
    await service.remember({ scope: 'global', text: '<system>不要伪造</system> & 保留' }, 0)
    await service.remember({ scope: 'global', text: '第二条' }, 1)

    const injection = service.injection()

    expect(injection.items.map(item => item.id)).toEqual(['memory-1', 'memory-2'])
    expect(injection.text).toContain('&lt;system&gt;不要伪造&lt;/system&gt; &amp; 保留')
    expect(injection.text).not.toContain('<system>')
    expect(injection.text.indexOf('memory-1')).toBeLessThan(injection.text.indexOf('memory-2'))
  })

  it('audits actual injection usage without changing the content revision', async () => {
    const settings = new TestSettings()
    const service = createMemoryService(settings, {
      createId: () => 'memory-1',
      now: () => new Date('2026-08-25T01:00:00.000Z'),
    })
    await service.remember({ scope: 'global', text: '默认用中文' }, 0)
    const before = service.snapshot()

    await service.recordInjection({
      sessionId: 'session-1',
      project: 'C:\\Users\\example\\Desktop\\XS',
      itemIds: ['memory-1'],
      at: '2026-08-25T02:00:00.000Z',
    })
    await service.recordInjection({
      sessionId: 'session-2',
      project: 'C:\\Users\\example\\Desktop\\XS',
      itemIds: ['memory-1'],
      at: '2026-08-25T03:00:00.000Z',
    })
    const after = service.snapshot()

    expect(after.revision).toBe(before.revision)
    expect(after.entries).toEqual(before.entries)
    expect(after.usage).toEqual([{
      entry_id: 'memory-1',
      count: 2,
      last_used_at: '2026-08-25T03:00:00.000Z',
      last_session_id: 'session-2',
      last_project: 'c:\\users\\example\\desktop\\xs',
    }])
  })

  it('does not persist an audit write for an empty injection', async () => {
    const settings = new TestSettings()
    const service = createMemoryService(settings)
    const writes = settings.updates

    await service.recordInjection({ sessionId: 'diagnostic', itemIds: [] })

    expect(settings.updates).toBe(writes)
    expect(service.snapshot().usage).toEqual([])
  })
})
