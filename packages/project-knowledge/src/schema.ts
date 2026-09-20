import { sourcePath } from './source.js'
import { fail, type Document, type Entry, type Json, type State } from './types.js'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_KNOWLEDGE')
  return value as Record<string, unknown>
}
function keys(raw: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(raw).some(key => !allowed.includes(key))) fail('INVALID_KNOWLEDGE')
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\u0000')) return fail('INVALID_KNOWLEDGE')
  return value
}
function lines(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 12) return fail('INVALID_KNOWLEDGE')
  return value.map(line => text(line, 240))
}
export function document(value: unknown): Document {
  const raw = record(value)
  keys(raw, ['title', 'purpose', 'interfaces', 'relations', 'constraints', 'overview'])
  if (typeof raw.overview !== 'boolean') return fail('INVALID_KNOWLEDGE')
  const parsed = { title: text(raw.title, 120), purpose: text(raw.purpose, 2000), interfaces: lines(raw.interfaces),
    relations: lines(raw.relations), constraints: lines(raw.constraints), overview: raw.overview }
  if (JSON.stringify(parsed).length > 6000) return fail('INVALID_KNOWLEDGE')
  return parsed
}
export function entry(value: unknown): Entry {
  const raw = record(value)
  keys(raw, ['id', 'identity', 'sources', 'document', 'version', 'validatedAt'])
  const id = record(raw.identity)
  keys(id, ['root', 'git'])
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1) return fail('INVALID_KNOWLEDGE')
  const date = text(raw.validatedAt, 40)
  if (!Number.isFinite(Date.parse(date))) return fail('INVALID_KNOWLEDGE')
  if (!Array.isArray(raw.sources) || !raw.sources.length || raw.sources.length > 8) return fail('INVALID_KNOWLEDGE')
  const sources = raw.sources.map(source => {
    const item = record(source); keys(item, ['path', 'sha256'])
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) return fail('INVALID_KNOWLEDGE')
    return { path: sourcePath(item.path), sha256: item.sha256 }
  })
  if (new Set(sources.map(source => source.path)).size !== sources.length) return fail('INVALID_KNOWLEDGE')
  return { id: text(raw.id, 80), identity: { root: text(id.root, 2000), git: text(id.git, 1200) }, sources,
    document: document(raw.document), version: raw.version as number, validatedAt: date }
}
export function state(value: unknown): State {
  const raw = record(value); keys(raw, ['enabled', 'entries'])
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return fail('INVALID_KNOWLEDGE')
  if (raw.entries !== undefined && (!Array.isArray(raw.entries) || raw.entries.length > 500)) return fail('INVALID_KNOWLEDGE')
  const entries = ((raw.entries ?? []) as unknown[]).map(entry)
  const unique = new Set(entries.map(item => `${item.identity.root}\0${item.sources[0]!.path}`))
  if (unique.size !== entries.length || new Set(entries.map(item => item.id)).size !== entries.length) return fail('INVALID_KNOWLEDGE')
  return { enabled: raw.enabled !== false, entries }
}
export const knowledgeSettingsSchema = Object.assign(
  (value: unknown): Record<string, Json> => state(value ?? {}) as unknown as Record<string, Json>,
  { toJSON: () => ({ uid: 0, refs: { 0: { type: 'object', meta: { default: { enabled: true, entries: [] } }, dict: {
    enabled: { type: 'boolean', meta: { default: true, description: '项目知识：按源码指纹核对并按需使用，可随时关闭。' } },
    entries: { type: 'array', inner: { type: 'any' }, meta: { default: [], hidden: true } },
  } } } }) },
)
