import { describe, expect, it } from 'vitest'
import { apply, type MemoryHostContext } from '../src/index.js'
import type { MemoryService } from '../src/service.js'

type PromptContextInput = {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssemblyContext) => string)
}

type AssemblyContext = {
  readonly agent?: {
    readonly id: string
    readonly session: { readonly header: { readonly cwd?: string } }
  }
}

type Assembly = {
  readonly contexts: Array<{ readonly name: string; readonly text: string }>
}

it('registers dynamic Agent-scoped memory and audits only an emitted assembly', async () => {
  const effects: Array<() => void | Promise<void>> = []
  const promptRows: PromptContextInput[] = []
  let assembleListener: undefined | ((
    assembly: Assembly,
    context: AssemblyContext,
    next: () => Promise<Assembly>,
  ) => Promise<Assembly>)
  let provided: MemoryService | undefined
  let state: Record<string, unknown> = {}
  const host = {
    tools: { register: () => () => {} },
    settings: {
      register: () => ({
        get: () => state,
        watch: () => () => {},
        update: async (patch: Record<string, unknown>) => { state = { ...state, ...patch } },
      }),
    },
    systemPrompt: {
      context: (row: PromptContextInput) => {
        promptRows.push(row)
        return () => { promptRows.splice(promptRows.indexOf(row), 1) }
      },
    },
    webServer: { register: () => () => {} },
    on: (_event: string, listener: typeof assembleListener) => {
      assembleListener = listener
      return () => { assembleListener = undefined }
    },
    effect: (mount: () => () => void | Promise<void>) => { effects.push(mount()) },
    provide: (_name: string, value: { service: MemoryService }) => {
      provided = value.service
      return () => { provided = undefined }
    },
  }

  apply(host as unknown as MemoryHostContext)
  if (provided === undefined) throw new Error('memory service was not provided')
  await provided.remember({ scope: 'global', text: '默认用中文' }, 0)
  await provided.remember({
    scope: 'project',
    project: 'C:\\Users\\example\\Desktop\\XS',
    text: '保留工作树',
  }, 1)

  expect(promptRows).toHaveLength(1)
  const render = promptRows[0]?.text
  if (typeof render !== 'function' || assembleListener === undefined) {
    throw new Error('dynamic context or assembly listener is missing')
  }
  expect(render({})).toBe('')
  const assemblyContext: AssemblyContext = {
    agent: {
      id: 'session-1',
      session: { header: { cwd: 'C:\\Users\\example\\Desktop\\XS' } },
    },
  }
  const text = render(assemblyContext)
  const assembly: Assembly = { contexts: [{ name: 'xiaoshe:memory', text }] }
  await assembleListener(assembly, assemblyContext, async () => assembly)

  expect(provided.snapshot().usage).toMatchObject([
    { entry_id: expect.any(String), count: 1, last_session_id: 'session-1' },
    { entry_id: expect.any(String), count: 1, last_session_id: 'session-1' },
  ])

  await Promise.all(effects.splice(0).map(async dispose => await dispose()))
  expect(promptRows).toHaveLength(0)
  expect(assembleListener).toBeUndefined()
})
