import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import type {
  DshContextLike,
  JsonValue,
  PreToolDecision,
  PromptAssemblyContextLike,
  PromptAssemblyLike,
  ToolDefinitionLike,
  ToolExecutionLike,
} from '../src/types.js'

function context() {
  const definitions: ToolDefinitionLike[] = []
  let listener: ((exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
  let assemblyListener: ((
    assembly: PromptAssemblyLike,
    context: PromptAssemblyContextLike,
    next: () => Promise<PromptAssemblyLike>,
  ) => Promise<PromptAssemblyLike>) | undefined
  const cleanups: Array<() => void | Promise<void>> = []
  const settingsValues = new Map<string, Record<string, JsonValue>>()
  const settingsNamespaces: string[] = []
  const promptSections: Array<{ name: string; order: number; text: string | (() => string) }> = []
  const promptContexts: Array<{ name: string; order: number; text: string | ((context: PromptAssemblyContextLike) => string) }> = []
  const providers = new Map<string, unknown>()
  const ctx: DshContextLike = {
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {
          const index = definitions.indexOf(definition)
          if (index >= 0) definitions.splice(index, 1)
        }
      },
      schemas() { return definitions.map(definition => ({ name: definition.name })) },
    },
    settings: {
      register(namespace, _schema, options) {
        settingsNamespaces.push(namespace)
        const watchers: Array<(next: Record<string, JsonValue>, previous: Record<string, JsonValue>) => void | Promise<void>> = []
        if (!settingsValues.has(namespace)) settingsValues.set(namespace, { ...(options?.base ?? {}) })
        return {
          get: () => settingsValues.get(namespace) ?? {},
          watch(callback) {
            watchers.push(callback)
            return () => {
              const index = watchers.indexOf(callback)
              if (index >= 0) watchers.splice(index, 1)
            }
          },
          async update(patch) {
            const previous = settingsValues.get(namespace) ?? {}
            const next = { ...previous, ...patch }
            settingsValues.set(namespace, next)
            await Promise.all(watchers.map(async watcher => await watcher(next, previous)))
          },
        }
      },
    },
    webServer: { register() { return () => {} } },
    systemPrompt: {
      section(section) {
        promptSections.push(section)
        return () => {
          const index = promptSections.indexOf(section)
          if (index >= 0) promptSections.splice(index, 1)
        }
      },
      context(row) {
        promptContexts.push(row)
        return () => {
          const index = promptContexts.indexOf(row)
          if (index >= 0) promptContexts.splice(index, 1)
        }
      },
    },
    on(event: 'tools/pre-execute' | 'system-prompt/assemble', value: unknown) {
      if (event === 'tools/pre-execute') {
        listener = value as typeof listener
        return () => { listener = undefined }
      }
      assemblyListener = value as typeof assemblyListener
      return () => { assemblyListener = undefined }
    },
    effect(execute) { cleanups.push(execute()) },
    provide(name, value) {
      providers.set(name, value)
      const dispose = () => { providers.delete(name) }
      cleanups.push(dispose)
      return dispose
    },
    get: name => providers.get(name),
  }
  return {
    ctx,
    definitions,
    settingsNamespaces,
    promptSections,
    promptContexts,
    setSettings(namespace: string, patch: Record<string, JsonValue>) {
      settingsValues.set(namespace, { ...(settingsValues.get(namespace) ?? {}), ...patch })
    },
    listener: () => {
      if (listener === undefined) throw new Error('listener not registered')
      return listener
    },
    cleanup: async () => {
      for (const cleanup of cleanups.reverse()) await cleanup()
    },
  }
}

describe('plugin composition', () => {
  it('registers all tools and upgrades an allowed desktop action to one-shot approval', async () => {
    const state = context()
    apply(state.ctx)
    expect(state.definitions).toHaveLength(11)
    expect(state.settingsNamespaces).toEqual(['xiaoshe-desktop', 'xiaoshe-memory'])
    expect(state.promptSections).toEqual([expect.objectContaining({
      name: 'xiaoshe:product-identity',
      order: 1,
    })])
    expect(state.definitions.slice(-3).map(definition => definition.name)).toEqual([
      'xiaoshe_memory_list',
      'xiaoshe_memory_remember',
      'xiaoshe_memory_set_state',
    ])
    await expect(state.listener()({ name: 'screen_click' }, async () => ({ kind: 'allow' })))
      .resolves.toEqual({
        kind: 'ask',
        reason: 'This action will control the real desktop. Review the target shown in the tool call.',
      })
    await state.cleanup()
  })

  it('uses pragmatic wording by default and applies a saved friendly style to later prompts', async () => {
    const state = context()
    apply(state.ctx)
    const section = state.promptSections[0]
    if (section === undefined) throw new Error('missing product prompt section')
    const readPrompt = () => typeof section.text === 'function' ? section.text() : section.text

    expect(readPrompt()).toContain('默认不使用表情符号')
    expect(readPrompt()).toContain('不添加活泼收尾')

    state.setSettings('xiaoshe-desktop', { responseStyle: 'friendly' })
    expect(readPrompt()).toContain('可适量使用表情')
    expect(readPrompt()).not.toContain('默认不使用表情符号')
    await state.cleanup()
  })

  it('preserves a downstream denial instead of bypassing it', async () => {
    const state = context()
    apply(state.ctx)
    await expect(state.listener()({ name: 'screen_type' }, async () => ({ kind: 'deny', reason: 'sealed' })))
      .resolves.toEqual({ kind: 'deny', reason: 'sealed' })
    await state.cleanup()
  })

  it('requires one-shot approval before focusing a real window', async () => {
    const state = context()
    apply(state.ctx)
    await expect(state.listener()({ name: 'screen_focus_window' }, async () => ({ kind: 'allow' })))
      .resolves.toMatchObject({ kind: 'ask' })
    await state.cleanup()
  })

  it('leaves read-only tools on the downstream decision', async () => {
    const state = context()
    apply(state.ctx)
    await expect(state.listener()({ name: 'screen_observe' }, async () => ({ kind: 'allow' })))
      .resolves.toEqual({ kind: 'allow' })
    await state.cleanup()
  })

  it('registers no action tools when the deployment switch is off', async () => {
    const state = context()
    apply(state.ctx, { actionsEnabled: false })
    expect(state.definitions.map(item => item.name)).toEqual([
      'screen_observe', 'screen_zoom', 'screen_verify', 'screen_list_windows',
      'xiaoshe_memory_list', 'xiaoshe_memory_remember', 'xiaoshe_memory_set_state',
    ])
    await state.cleanup()
  })

  it('uses one shared durable service for list, remember, edit and forget tools', async () => {
    const state = context()
    apply(state.ctx)
    const execute = async (name: string, args: unknown) => {
      const definition = state.definitions.find(item => item.name === name)
      if (definition === undefined) throw new Error(`missing ${name}`)
      return await definition.execute(args, { signal: new AbortController().signal })
    }

    await expect(execute('xiaoshe_memory_list', {})).resolves.toMatchObject({ revision: 0, entries: [] })
    const created = await execute('xiaoshe_memory_remember', {
      expected_revision: 0, scope: 'global', text: '只使用合法 Logo',
    }) as { revision: number; entries: Array<{ id: string }> }
    const id = created.entries[0]?.id
    if (id === undefined) throw new Error('missing tool-created memory')
    await expect(execute('xiaoshe_memory_remember', {
      expected_revision: 1, scope: 'global', text: '只使用唯一合法 Logo', replaces_id: id,
    })).resolves.toMatchObject({ revision: 2, counts: { active: 1, superseded: 1 } })
    const active = await execute('xiaoshe_memory_list', { include_inactive: false }) as { entries: Array<{ id: string }> }
    const editedId = active.entries[0]?.id
    if (editedId === undefined) throw new Error('missing tool-edited memory')
    await expect(execute('xiaoshe_memory_set_state', {
      expected_revision: 2, id: editedId, state: 'forgotten',
    })).resolves.toMatchObject({ revision: 3, counts: { active: 0, forgotten: 1 } })
    await state.cleanup()
  })
})
