import { resolve } from 'node:path'
import { observeDataFile, sameOutputIdentity, type OutputObservation } from './verification-file-proofs.js'

const MAX_BYTES = 8 * 1024 * 1024
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const isJsonlPath = (value: unknown): value is string => typeof value === 'string' && /\.jsonl$/iu.test(value)

export interface JsonlExpectation {
  readonly path: string
  readonly content: string
  readonly before?: OutputObservation
}
export interface JsonlProof extends OutputObservation {
  readonly kind: 'mutation' | 'read'
  readonly before?: OutputObservation
}

export function jsonlRows(content: string): number | undefined {
  if (!content || Buffer.byteLength(content) > MAX_BYTES) return undefined
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  try {
    for (const line of lines) JSON.parse(line)
    return lines.length
  } catch { return undefined }
}

/** Capture after pre-execute authorization, never from mutation-owned before
 * metadata. Exact literal substitution preserves every other byte, including
 * record order, English text and non-target fields, without schema guessing. */
export function prepareJsonlMutation(name: string, raw: unknown, cwd: string | undefined,
  isDataPath: (path: string) => boolean): JsonlExpectation | undefined {
  const args = object(raw)
  if (!args || !cwd || !['edit', 'write'].includes(name) || !isJsonlPath(args.file_path)) return undefined
  const path = resolve(cwd, args.file_path)
  if (!isDataPath(path)) return undefined
  const before = observeDataFile(path)
  let content: string
  if (name === 'write') {
    if (typeof args.content !== 'string') return undefined
    content = args.content
  } else {
    if (!before || jsonlRows(before.content) === undefined
      || typeof args.old_string !== 'string' || !args.old_string
      || typeof args.new_string !== 'string'
      || (args.replace_all !== undefined && typeof args.replace_all !== 'boolean')) return undefined
    const pieces = before.content.split(args.old_string)
    if (pieces.length < 2 || (args.replace_all !== true && pieces.length !== 2)) return undefined
    content = pieces.join(args.new_string)
  }
  if (jsonlRows(content) === undefined) return undefined
  return { path, content, ...(before ? { before } : {}) }
}

/** A tool success alone cannot certify even a byte. Independently observe the
 * entire bounded file and match both the argument-derived output and the real
 * first-party result. No proofs are restored from model-visible history. */
export function captureJsonlMutation(expected: JsonlExpectation | undefined, raw: unknown): JsonlProof | undefined {
  const value = object(raw)
  if (!expected || !value || value.path !== expected.path || value.after !== expected.content
    || (expected.before ? value.before !== expected.before.content : value.before !== null)) return undefined
  const current = observeDataFile(expected.path)
  if (!current || current.content !== expected.content) return undefined
  return { ...current, kind: 'mutation', ...(expected.before ? { before: expected.before } : {}) }
}

/** Even a short native read triggers an independent FULL host comparison.
 * Its returned window must match the same physical file, but does not stand
 * in for the unseen suffix. The host snapshot, not grep or a model claim,
 * supplies that full-content evidence. */
export function captureJsonlRead(rawArgs: unknown, rawValue: unknown, cwd?: string): JsonlProof | undefined {
  const args = object(rawArgs), value = object(rawValue)
  if (!args || !value || !cwd || !isJsonlPath(args.file_path)) return undefined
  const path = resolve(cwd, args.file_path)
  if (value.path !== path || !Array.isArray(value.lines)
    || value.lines.length === 0 || !Number.isSafeInteger(value.offset)) return undefined
  const current = observeDataFile(path)
  if (!current || jsonlRows(current.content) === undefined) return undefined
  const lines = current.content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (value.totalLines !== lines.length) return undefined
  const offset = value.offset as number
  if (offset < 1 || offset + value.lines.length - 1 > lines.length) return undefined
  for (const [i, raw] of value.lines.entries()) {
    const row = object(raw)
    if (row?.number !== offset + i || row.text !== lines[offset + i - 1]?.replace(/\r$/u, '')) return undefined
  }
  return { ...current, kind: 'read' }
}

export function sameJsonlProof(a: JsonlProof, b: JsonlProof): boolean {
  return sameOutputIdentity(a.identity, b.identity) && a.content === b.content
}
