import type {
  AgentRuntimeSession,
  CreateSessionInput,
  ForkSessionInput,
  RuntimeCommandResult,
  RuntimeSessionProjection,
  RuntimeSessionSnapshot,
  SendTurnInput,
  StopRunInput,
} from './index.js'
import { RUNTIME_SESSION_SCHEMA_VERSION } from './version.js'

type RuntimeCommandName = 'createSession' | 'sendTurn' | 'stopRun' | 'forkSession'

export interface MemoryRuntimeSessionOptions {
  readonly createId?: () => string
  readonly unsupported?: readonly RuntimeCommandName[]
  readonly ambiguous?: readonly RuntimeCommandName[]
}

/** Deterministic test-only Provider; production composition never imports this subpath. */
export function createMemoryRuntimeSession(options: MemoryRuntimeSessionOptions = {}): AgentRuntimeSession {
  const sessions: Record<string, RuntimeSessionProjection> = {}
  const listeners = new Set<() => void>()
  const createId = options.createId ?? defaultSequence()
  let currentSessionId: string | undefined
  const blocked = (command: RuntimeCommandName): RuntimeCommandResult<never> | undefined => {
    if (options.unsupported?.includes(command) === true) {
      return { ok: false, error: { kind: 'unsupported', message: `${command} is unsupported by this provider` } }
    }
    if (options.ambiguous?.includes(command) === true) {
      return { ok: false, error: { kind: 'needs_verification', message: `${command} outcome is unknown` } }
    }
    return undefined
  }
  const publish = (): void => { for (const listener of listeners) listener() }
  const find = (sessionId: string): RuntimeSessionProjection | undefined => sessions[sessionId]
  const setState = (sessionId: string, state: RuntimeSessionProjection['state']): void => {
    sessions[sessionId] = { ...sessions[sessionId], schemaVersion: RUNTIME_SESSION_SCHEMA_VERSION, sessionId, state }
    currentSessionId = sessionId
    publish()
  }
  return {
    getSnapshot: () => ({ currentSessionId, sessions: { ...sessions } }),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async createSession(_input: CreateSessionInput) {
      const failure = blocked('createSession')
      if (failure !== undefined) return failure
      const sessionId = createId()
      if (sessionId === '' || sessions[sessionId] !== undefined) {
        return { ok: false, error: { kind: 'conflict', message: 'test provider generated a duplicate session id' } }
      }
      setState(sessionId, 'blank')
      return { ok: true, value: { sessionId } }
    },
    async sendTurn(input: SendTurnInput) {
      const failure = blocked('sendTurn')
      if (failure !== undefined) return failure
      if (input.content.trim() === '' && (input.images?.length ?? 0) === 0) {
        return invalid('content or images must not be blank')
      }
      if (find(input.sessionId) === undefined) return missing(input.sessionId)
      setState(input.sessionId, 'running')
      return { ok: true, value: { accepted: true as const } }
    },
    async stopRun(input: StopRunInput) {
      const failure = blocked('stopRun')
      if (failure !== undefined) return failure
      if (find(input.sessionId) === undefined) return missing(input.sessionId)
      setState(input.sessionId, 'idle')
      return { ok: true, value: { accepted: true as const } }
    },
    async forkSession(input: ForkSessionInput) {
      const failure = blocked('forkSession')
      if (failure !== undefined) return failure
      if (find(input.sessionId) === undefined) return missing(input.sessionId)
      const sessionId = createId()
      if (sessions[sessionId] !== undefined) {
        return { ok: false, error: { kind: 'conflict', message: 'test provider generated a duplicate session id' } }
      }
      setState(sessionId, 'idle')
      return { ok: true, value: { sessionId } }
    },
  }
}

function defaultSequence(): () => string {
  let value = 0
  return () => `memory-session-${++value}`
}

function missing(sessionId: string): RuntimeCommandResult<never> {
  return { ok: false, error: { kind: 'not_found', message: `unknown session: ${sessionId}` } }
}

function invalid(message: string): RuntimeCommandResult<never> {
  return { ok: false, error: { kind: 'invalid_request', message } }
}
