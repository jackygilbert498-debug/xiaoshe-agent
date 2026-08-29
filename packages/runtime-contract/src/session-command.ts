import type { RuntimeCommandResult } from './commands.js'

/** Input for a command owned by the active Host session. */
export interface SessionCommandInput {
  readonly sessionId: string
  readonly line: string
}

/**
 * Narrow product seam for real Host slash commands.
 *
 * Keeping this separate from AgentRuntimeSession prevents product-only
 * commands from inflating the minimum conversation runtime contract.
 */
export interface SessionCommand {
  execute(input: SessionCommandInput): Promise<RuntimeCommandResult<{ readonly matched: boolean }>>
}
