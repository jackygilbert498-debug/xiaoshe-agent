import { expect } from 'vitest'
import type { AgentRuntimeSession } from '../src/index.js'

/** Shared behavioral contract for every AgentRuntimeSession provider. */
export async function verifyProviderContract(runtime: AgentRuntimeSession): Promise<void> {
  let notifications = 0
  const unsubscribe = runtime.subscribe(() => { notifications += 1 })
  const created = await runtime.createSession({ workspaceId: 'workspace-1' })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const sessionId = created.value.sessionId
  expect(runtime.getSnapshot().sessions[sessionId]).toMatchObject({ state: 'blank', sessionId })
  await expect(runtime.sendTurn({ sessionId, content: 'hello', mode: 'queue' }))
    .resolves.toEqual({ ok: true, value: { accepted: true } })
  expect(runtime.getSnapshot().sessions[sessionId]?.state).toBe('running')
  await expect(runtime.stopRun({ sessionId })).resolves.toEqual({ ok: true, value: { accepted: true } })
  expect(runtime.getSnapshot().sessions[sessionId]?.state).toBe('idle')
  const forked = await runtime.forkSession({ sessionId })
  expect(forked.ok).toBe(true)
  expect(notifications).toBeGreaterThanOrEqual(4)
  unsubscribe()
  const before = notifications
  await runtime.createSession({})
  expect(notifications).toBe(before)
}
