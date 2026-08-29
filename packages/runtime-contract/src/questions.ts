import type { RuntimeCommandResult } from './commands.js'

/** One option offered by a runtime-owned user question. */
export interface UserQuestionOption {
  readonly label: string
  readonly description?: string
}

/** Optional presentation hint. It never changes which answers remain reachable. */
export interface UserQuestionIntent {
  readonly kind: 'plan-review'
  readonly approve: string
}

/** One question in a runtime request. */
export interface UserQuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly UserQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: UserQuestionIntent
}

/** A pending request projected from the runtime carrier. */
export interface UserQuestionRequest {
  readonly key: string
  readonly sessionId: string
  readonly questions: readonly UserQuestionItem[]
  /** Malformed requests remain visible and cancellable instead of deadlocking the session. */
  readonly error?: string
}

export interface UserQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

export interface UserQuestionAnswer {
  readonly answers: readonly UserQuestionAnswerItem[]
}

export interface UserQuestionInteractionSnapshot {
  readonly sessionId?: string
  readonly requests: readonly UserQuestionRequest[]
}

/** Separate interaction seam; product clients answer without mounting provider UI. */
export interface UserQuestionInteraction {
  getSnapshot(): UserQuestionInteractionSnapshot
  subscribe(listener: () => void): () => void
  answer(key: string, answer: UserQuestionAnswer): Promise<RuntimeCommandResult<{ accepted: true }>>
  cancel(key: string): Promise<RuntimeCommandResult<{ cancelled: true }>>
}
