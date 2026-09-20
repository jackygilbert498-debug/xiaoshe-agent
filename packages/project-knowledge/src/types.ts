/** Structural interfaces keep this optional plugin independent of a particular DSH build. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface Scope {
  getSnapshot(): { value: unknown; revision: number; status: 'ready' | 'degraded' }
  replace(value: Record<string, Json>, expectedRevision: number): Promise<void>
}
export interface Identity { root: string; git: string }
export interface Source { path: string; sha256: string }
export interface Document {
  title: string
  purpose: string
  interfaces: string[]
  relations: string[]
  constraints: string[]
  overview: boolean
}
export interface Entry {
  id: string
  identity: Identity
  sources: Source[]
  document: Document
  version: number
  validatedAt: string
}
export interface State { enabled: boolean; entries: Entry[] }
export interface Call { cwd: string; signal?: AbortSignal }
export interface Inspection extends Call { owner: string; paths: string[] }
export interface Save extends Call {
  owner: string; receipt: string; id?: string; expectedVersion: number; document: Document
}
export interface Query extends Call { query?: string; maxChars?: number; contextOnly?: boolean }
export interface QueryResult {
  status: 'ready' | 'disabled' | 'degraded'
  entries: Entry[]
  stale: number
  omitted: number
  text: string
  staleEntries: Array<{ id: string; version: number; path: string }>
}
export class KnowledgeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'KnowledgeError' }
}
export const fail = (code: string): never => { throw new KnowledgeError(code) }
