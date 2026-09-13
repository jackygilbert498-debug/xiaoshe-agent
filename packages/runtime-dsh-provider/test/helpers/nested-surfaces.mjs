import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from '../../../../runtime/DSH/node_modules/tsx/dist/esm/api/index.mjs'

// Use the real source composition, including both presentation seams. No
// credentials, remote model, listening server, or user workspace is involved.
register({ tsconfig: fileURLToPath(new URL('../../../../runtime/DSH/tsconfig.base.json', import.meta.url)) })
const dsh = '../../../../runtime/DSH/'
const { Context } = await import(`${dsh}vendor/cordis/src/index.ts`)
const { SessionStore } = await import(`${dsh}packages/core/session/src/index.ts`)
const { SystemPrompt } = await import(`${dsh}packages/core/system-prompt/src/index.ts`)
const { ToolRuntime } = await import(`${dsh}packages/core/tools/src/index.ts`)
const { WorkerThreadCodeRuntime } = await import(`${dsh}packages/code-runtime/code-runtime-worker-thread/src/index.ts`)
const { LocalFileSystem } = await import(`${dsh}packages/fs/fs-local/src/index.ts`)
const { apply: applyFs } = await import(`${dsh}packages/fs/tool-fs/src/index.ts`)
const { createToolResultMessage } = await import(`${dsh}packages/llm/llm/src/index.ts`)
const { SessionHistoryController } = await import(`${dsh}packages/api/session-controller/src/history.ts`)
const { default: SessionQuery } = await import(`${dsh}packages/session-query/session-query/src/index.ts`)
const { default: SessionProjections } = await import(`${dsh}packages/session/session-projection/src/index.ts`)
const { UserQuestionService } = await import(`${dsh}packages/interaction/user-questions/src/index.ts`)
const { ConversationNodeAssembler } = await import(`${dsh}packages/client/ui-conversation/src/client/conversation/assembler.ts`)
const { toolDefinition } = await import(`${dsh}packages/client/ui-chat/src/client/conversation-nodes/tool.ts`)
const { chatViewDefinition } = await import(`${dsh}packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts`)
export const { projectDshWorkSurfaces, DshWorkSurfaceRegistry } = await import('../../src/client/surfaces.ts')
const { DshRunCenter } = await import('../../src/client/index.ts')
const { registerWorkSurfaceView, WORK_SURFACE_VIEW } = await import('../../src/client/surface-view.ts')
const { ConversationEventRegistry } = await import(`${dsh}packages/client/ui-conversation/src/client/conversation/event-registry.ts`)
const { ConversationViewRegistry } = await import(`${dsh}packages/client/ui-conversation/src/client/conversation/view-registry.ts`)
const { executeToolCalls } = await import(`${dsh}packages/core/agent-loop/src/tool-calls.ts`)

export function observable(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    publish(next) { value = next; for (const listener of listeners) listener() },
  }
}

/** Actual nested tools -> Host history views -> client assembler -> registries. */
export async function nestedSurfaceFixture({ genericUi = true, mode = 'ptc', sessionId } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'xiaoshe-nested-materials-'))
  const ctx = new Context()
  new SessionStore(ctx)
  new SessionProjections(ctx)
  new SessionQuery(ctx)
  new UserQuestionService(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new WorkerThreadCodeRuntime(ctx, { computeMs: 10_000, maxWallMs: 30_000, maxOutputBytes: 1_000_000, maxOldGenerationSizeMb: 64 })
  new ToolRuntime(ctx, { mode })
  new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 1_000_000 })
  applyFs(ctx, { readLimit: 2000, readMaxLineLength: 32_768, readMaxBytes: 512_000, readStreamMinSize: 1_000_000 })
  const session = ctx.sessions.create(sessionId ?? `materials-${crypto.randomUUID()}`, { meta: { cwd } })
  const agent = { id: session.id, session, ctx }
  ctx.provide('agents', { requireInitiator: () => agent, get: () => undefined })
  ctx.provide('agentLoop', { config: { maxParallelToolCalls: 4 } })
  const conversationEvents = new ConversationEventRegistry(ctx)
  const conversationViews = new ConversationViewRegistry(ctx)
  if (genericUi) {
    conversationEvents.register(toolDefinition)
    conversationViews.register(chatViewDefinition)
  }
  const api = new SessionHistoryController(ctx, () => { throw new Error('history fixture must never activate an Agent') })
  const face = observable({ nodes: [], runningCalls: [], queue: [] })
  const list = observable({ current: session.id, ids: [session.id], byId: { [session.id]: { id: session.id, cwd, projectionValues: {} } }, jobsBySession: {}, subagentsByParent: {} })
  const sessions = { list, binding: id => id === session.id ? { session: face } : undefined }
  registerWorkSurfaceView({ conversationEvents, conversationViews })
  const registry = new DshWorkSurfaceRegistry(sessions)
  const center = new DshRunCenter(sessions, { api: {} }, registry)
  let callCount = 0
  const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash'
  const terminalCommand = value => {
    assert.match(value, /^[a-z0-9-]+$/u, 'terminal fixture output must stay literal')
    return process.platform === 'win32' ? `Write-Output '${value}'` : `printf '%s\\n' '${value}'`
  }
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  return {
    ctx, session, api, cwd, registry, center, face, list, shellTool, terminalCommand,
    async enableShell() {
      const { LocalSubprocessRuntime } = await import(`${dsh}packages/subprocess/subprocess-local/src/index.ts`)
      const { ShellEnvRegistry } = await import(`${dsh}packages/shell/shell-env/src/index.ts`)
      new LocalSubprocessRuntime(ctx)
      new ShellEnvRegistry(ctx, { dshHome: cwd })
      const config = { cwd, timeoutMs: 10_000, maxTimeoutMs: 10_000, maxOutputBytes: 640_000, maxSpillBytes: 1_000_000, graceMs: 500 }
      if (process.platform === 'win32') {
        const { PwshLocalExecutor } = await import(`${dsh}packages/shell/pwsh-local/src/index.ts`)
        const { apply } = await import(`${dsh}packages/shell/tool-pwsh/src/index.ts`)
        new PwshLocalExecutor(ctx, config)
        apply(ctx, { enableRunInBackground: false })
        return
      }
      const { LocalBashExecutor } = await import(`${dsh}packages/shell/bash-local/src/index.ts`)
      const { apply } = await import(`${dsh}packages/shell/tool-bash/src/index.ts`)
      new LocalBashExecutor(ctx, config)
      apply(ctx, { enableRunInBackground: false })
    },
    async seed(path, body) { await writeFile(join(cwd, path), body, 'utf8') },
    async read(path) { return readFile(join(cwd, path), 'utf8') },
    async removeOwnedFiles() { await rm(cwd, { recursive: true, force: true }) },
    async native(name, args) {
      await executeToolCalls(ctx, 1, 1, [{ type: 'tool_call', id: `native-${++callCount}`, name, arguments: JSON.stringify(args) }], new AbortController().signal, () => undefined)
    },
    async code(code) {
      const callId = `code-${++callCount}`
      const args = { code, description: 'Offline materials integration' }
      const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'run_code', arguments: JSON.stringify(args) })
      const result = await ctx.tools.execute({ callId, name: 'run_code', arguments: args, agent, signal: new AbortController().signal })
      session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: result.content, isError: result.isError }), ...(result.meta === undefined ? {} : { meta: result.meta }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      return result
    },
    async history() {
      const page = await api.page({ address: { kind: 'session', sessionId: session.id }, throughSeq: session.seq - 1, maxMessages: 100 }, new AbortController().signal)
      return page.records.filter(record => record.type === 'event')
    },
    project(entries, { incremental = false } = {}) {
      const assembler = new ConversationNodeAssembler(conversationEvents, conversationViews)
      assembler.activateTarget(WORK_SURFACE_VIEW)
      if (genericUi) assembler.activateTarget('chat')
      if (incremental) for (const entry of entries) assembler.append(entry)
      else assembler.replaceWindow(entries, false)
      assembler.flush()
      const snapshot = assembler.snapshot('chat')?.legacy ?? { nodes: [], runningCalls: [] }
      face.publish({ ...snapshot, views: { get: target => assembler.snapshot(target) }, queue: [] })
      return registry.getSnapshot().items
    },
    async dispose() {
      center.dispose(); registry.dispose()
      await ctx.fiber.dispose()
      // Only the mkdtemp directory owned by this fixture is removed.
      await rm(cwd, { recursive: true, force: true })
    },
  }
}

/** Produce only public synthetic tool evidence for the real Electron renderer. */
export async function materialJourneyEvidence() {
  const fixture = await nestedSurfaceFixture({ genericUi: false, mode: 'both', sessionId: 'acceptance-session' })
  try {
    await fixture.seed('journey-material.txt', 'journey-before')
    await fixture.native('read', { file_path: 'journey-material.txt' })
    await fixture.code("return await tools.edit({file_path:'journey-material.txt',old_string:'before',new_string:'after'})")
    await fixture.enableShell()
    await fixture.native(fixture.shellTool, { command: fixture.terminalCommand('journey-terminal-ok'), description: 'Read local integration evidence' })
    const entries = await fixture.history()
    fixture.project(entries)
    const surfaces = fixture.registry.getSnapshot()
    assert.deepEqual(surfaces.items.map(item => item.view.kind), ['text', 'diff', 'terminal'])
    return { surfaces, runCenter: fixture.center.getSnapshot(), evidence: {
      source: 'actual-offline-tools-host-history-provider', genericChatNodes: fixture.face.getSnapshot().nodes.length,
      rootCalls: entries.filter(row => row.event.type === 'tool/call').map(row => row.event.data.name),
      nestedCalls: entries.filter(row => row.event.type === 'tool/ptc-dispatch').map(row => row.event.data.name),
    } }
  } finally { await fixture.dispose() }
}
