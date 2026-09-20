import { createKnowledgeService } from './service.js'
import { knowledgeSettingsSchema } from './schema.js'
import { render } from './selection.js'
import { createKnowledgeTools, type Agent, type Tool } from './tools.js'
import type { Json, Scope } from './types.js'

export const name = 'xiaoshe-project-knowledge'
export const inject = ['settings', 'tools', 'systemPrompt']
interface Assembly { contexts: Array<{ name: string; text: string }> }
interface AssemblyContext { agent?: Agent; signal?: AbortSignal }
interface Host {
  settings: { register(name: string, schema: typeof knowledgeSettingsSchema, options: {
    base: Record<string, Json>; applies: 'live'; recoverInvalidStored: boolean
  }): Scope }
  tools: { register(tool: Tool): () => void }
  systemPrompt: { section(row: { name: string; order: number; text: () => string }): () => void }
  on(event: 'system-prompt/assemble', callback: (assembly: Assembly, context: AssemblyContext, next: () => Promise<Assembly>) => Promise<Assembly>): () => void
  effect(callback: () => () => void, label: string): unknown
  provide(name: string, value: unknown): unknown
}

/** Recover task terms from authoritative user messages, never from tool results or generated summaries. */
function userQuery(agent: Agent): { query: string; key: string | null } {
  const events = agent.session?.snapshotEvents?.() ?? agent.session?.events ?? []
  for (let index = events.length - 1; index >= Math.max(0, events.length - 500); index--) {
    const event = events[index] as { type?: string; seq?: number; data?: { source?: { kind?: string }; content?: { type?: string; text?: string }[] } }
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user' || !Array.isArray(event.data.content)) continue
    const query = event.data.content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n').slice(0, 4000)
    return { query, key: `${event.seq ?? index}:${query}` }
  }
  return { query: '', key: null }
}

/** Optional projection: asynchronous IO is in the assembly waterfall, not the synchronous context provider. */
export function apply(ctx: Host): void {
  const settings = ctx.settings.register(name, knowledgeSettingsSchema, {
    base: { enabled: true, entries: [] }, applies: 'live', recoverInvalidStored: true,
  })
  const service = createKnowledgeService(settings)
  // Retain only at most eight ID/version pairs per live agent, never cached source
  // bodies. Revalidate on every assembly; writes become automatic context on the
  // next user message, not retroactive evidence for the turn that produced them.
  const turns = new WeakMap<Agent, { cwd: string; key: string | null; versions: Map<string, number> | undefined }>()
  for (const tool of createKnowledgeTools(service)) ctx.effect(() => ctx.tools.register(tool), `${name}: ${tool.name}`)
  ctx.effect(() => ctx.systemPrompt.section({ name: 'xiaoshe:project-knowledge-guidance', order: 350,
    text: () => service.enabled() ? '项目知识是可选、可重建的源码摘要，不是权限或完成门槛。有相关知识时先据此定位再读取实际源码；过期或缺失就直接读源码。重要代码/事实稳定后，可用 xiaoshe_knowledge_inspect → save 记录职责、接口、明确依赖及约束，供下次任务接手；不要为凑索引强制扫描全仓库，不记录密钥、临时猜测或未验证的成功结论。用户的任务边界和禁令始终优先。' : '',
  }), `${name}: guidance`)
  ctx.effect(() => ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    if (!context.agent?.session?.header?.cwd || !service.enabled()) return result
    try {
      const timeout = AbortSignal.timeout(1500)
      const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout
      const task = userQuery(context.agent)
      const cwd = context.agent.session.header.cwd
      let turn = turns.get(context.agent)
      // Absence inside a bounded event window is not a new user turn. Long
      // tool runs keep their cohort even after the initiating event ages out.
      if (!turn || turn.cwd !== cwd || (task.key !== null && turn.key !== task.key)) {
        turn = { cwd, key: task.key, versions: undefined }
        turns.set(context.agent, turn)
      }
      const knowledge = await service.query({ cwd: context.agent.session.header.cwd, query: task.query, contextOnly: true, signal })
      if (turns.get(context.agent) !== turn || knowledge.status !== 'ready' || signal.aborted) return result
      turn.versions ??= new Map(knowledge.entries.map(entry => [entry.id, entry.version]))
      const prior = knowledge.entries.filter(entry => turn.versions!.get(entry.id) === entry.version)
      const material = render(prior, knowledge.stale, knowledge.omitted + knowledge.entries.length - prior.length)
      if (!knowledge.text || signal.aborted) return result
      return { ...result, contexts: [...result.contexts.filter(row => row.name !== 'xiaoshe:project-knowledge'),
        { name: 'xiaoshe:project-knowledge', text: material.text }] }
    } catch { return result }
  }), `${name}: bounded prompt material`)
  ctx.provide('xiaosheProjectKnowledge', { service, settings })
}

export { createKnowledgeService, knowledgeSettingsSchema, createKnowledgeTools }
export type { KnowledgeService } from './service.js'
