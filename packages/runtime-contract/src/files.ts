import type { RuntimeCommandResult } from './commands.js'

/** Product admission bounds; backend limits may be stricter. Images stay separate. */
export const RUNTIME_FILE_LIMITS = Object.freeze({ maxFileBytes: 32 * 1024 * 1024, maxFilesPerMessage: 10, maxMessageFileBytes: 128 * 1024 * 1024 })
export interface RuntimeFileReceipt {
  readonly receiptId: string
  readonly name: string
  readonly bytes: number
  readonly mediaType?: string
}
export interface RuntimeFileUploadInput {
  readonly sessionId: string
  readonly file: Blob
  readonly name: string
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: { readonly loaded: number; readonly total?: number }) => void
}
export interface RuntimeFileReadInput {
  readonly sessionId: string
  /** Exact source path from an authoritative material in this session. */
  readonly path: string
  readonly signal?: AbortSignal
}
export interface RuntimeFileContent {
  readonly sessionId: string
  readonly path: string
  readonly name: string
  readonly mediaType: string
  readonly data: Uint8Array
  readonly bytes: number
  readonly version: string
}
export interface RuntimeFiles {
  readonly limits: typeof RUNTIME_FILE_LIMITS
  upload(input: RuntimeFileUploadInput): Promise<RuntimeCommandResult<RuntimeFileReceipt>>
  read(input: RuntimeFileReadInput): Promise<RuntimeCommandResult<RuntimeFileContent>>
}
