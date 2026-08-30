export const RUNTIME_COMMANDS = ['createSession', 'sendTurn', 'stopRun', 'forkSession'] as const

export type RuntimeCommandErrorKind =
  | 'unsupported'
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'transport'
  | 'provider'
  | 'needs_verification'

export interface RuntimeCommandError {
  readonly kind: RuntimeCommandErrorKind
  readonly message: string
  readonly code?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export type RuntimeCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RuntimeCommandError }

export type RuntimeImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Browser-safe image payload accepted by runtime providers. */
export interface RuntimeImageInput {
  readonly mediaType: RuntimeImageMediaType
  readonly data: string
  readonly name?: string
}

/** Provider-resolved admission limits surfaced before a user chooses files. */
export interface RuntimeImageInputLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly maxImagePixels: number
  readonly maxImageDimension: number
  readonly mediaTypes: readonly RuntimeImageMediaType[]
}

export interface CreateSessionInput { readonly workspaceId?: string }
export interface SendTurnInput {
  readonly sessionId: string
  readonly content: string
  readonly images?: readonly RuntimeImageInput[]
  readonly mode: 'queue' | 'steer'
}
export interface StopRunInput { readonly sessionId: string }
export interface ForkSessionInput { readonly sessionId: string; readonly atSourceSeq?: number }
