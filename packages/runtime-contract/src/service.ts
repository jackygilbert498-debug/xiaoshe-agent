import type {
  CreateSessionInput,
  ForkSessionInput,
  RuntimeCommandResult,
  SendTurnInput,
  StopRunInput,
} from './commands.js'
import type { RuntimeSessionSnapshot } from './state.js'

/** Minimal product lifecycle facade; adjacent capabilities remain separate Services. */
export interface AgentRuntimeSession {
  getSnapshot(): RuntimeSessionSnapshot
  subscribe(listener: () => void): () => void
  createSession(input: CreateSessionInput): Promise<RuntimeCommandResult<{ sessionId: string }>>
  sendTurn(input: SendTurnInput): Promise<RuntimeCommandResult<{ accepted: true }>>
  stopRun(input: StopRunInput): Promise<RuntimeCommandResult<{ accepted: true }>>
  forkSession(input: ForkSessionInput): Promise<RuntimeCommandResult<{ sessionId: string }>>
}
