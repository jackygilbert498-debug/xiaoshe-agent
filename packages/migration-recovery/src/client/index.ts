import type { MigrationConflict, MigrationPreview } from '../importer.js'
import type { WorkspacePathMapping } from '../path-map.js'
import type { MigrationImportChallenge, MigrationRecoverySnapshot } from '../service.js'

declare const require: (id: string) => unknown

interface ReactLike {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown
  useState<T>(initial: T): [T, (value: T | ((current: T) => T)) => void]
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, snapshot: () => T): T
}
interface SlotsLike {
  inject(name: string, setup: () => () => void): () => void
  register(options: { readonly name: string; readonly id: string; readonly order: number; readonly label: string; readonly inject?: () => unknown }, component: unknown): () => void
}
interface ClientContextLike {
  readonly slots: SlotsLike
  readonly workspaces: { pickDirectory(): Promise<string | null> }
  provide(name: string, value: unknown): unknown
  effect(execute: () => (() => void), label?: string): unknown
}
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface MigrationClientSnapshot {
  readonly status: 'idle' | 'working' | 'ready' | 'error'
  readonly host?: MigrationRecoverySnapshot
  readonly preview?: MigrationPreview
  readonly challenge?: Omit<MigrationImportChallenge, 'token'>
  readonly error?: string
}

class MigrationClientError extends Error {
  constructor(message: string, readonly body?: Readonly<Record<string, unknown>>) { super(message); this.name = 'MigrationClientError' }
}

/** Browser controller; the one-shot token stays private and never enters the UI snapshot. */
export class MigrationRecoveryClient {
  readonly #fetcher: FetchLike
  readonly #listeners = new Set<() => void>()
  #challenge: MigrationImportChallenge | undefined
  #snapshot: MigrationClientSnapshot = Object.freeze({ status: 'idle' })
  #disposed = false
  constructor(fetcher: FetchLike = globalThis.fetch.bind(globalThis)) { this.#fetcher = fetcher }
  getSnapshot = (): MigrationClientSnapshot => this.#snapshot
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  async load(): Promise<void> {
    await this.#run(async () => {
      const body = await this.#request('/api/xiaoshe/migration/status')
      this.#set({ status: 'ready', host: parseHostSnapshot(body) })
    })
  }
  async exportTo(target: string): Promise<void> {
    await this.#run(async () => {
      const body = await this.#request('/api/xiaoshe/migration/export', { target })
      this.#set({ status: 'ready', host: parseHostSnapshot(requiredRecord(body, 'snapshot')) })
    })
  }
  async inspect(bundlePath: string, mappings: readonly WorkspacePathMapping[]): Promise<void> {
    await this.#run(async () => {
      const body = await this.#request('/api/xiaoshe/migration/inspect', { bundlePath, mappings })
      this.#challenge = undefined
      this.#set({ status: 'ready', host: parseHostSnapshot(requiredRecord(body, 'snapshot')), preview: parsePreview(requiredRecord(body, 'preview')) })
    })
  }
  async prepare(bundlePath: string, mappings: readonly WorkspacePathMapping[]): Promise<void> {
    await this.#run(async () => {
      try {
        const body = await this.#request('/api/xiaoshe/migration/prepare', { bundlePath, mappings })
        this.#challenge = parseChallenge(requiredRecord(body, 'challenge'))
        const { token: _secret, ...visible } = this.#challenge
        this.#set({ status: 'ready', host: parseHostSnapshot(requiredRecord(body, 'snapshot')), challenge: Object.freeze(visible) })
      } catch (error) {
        if (error instanceof MigrationClientError && error.body?.kind === 'MIGRATION_CONFLICT' && isRecord(error.body.preview)) {
          this.#challenge = undefined
          this.#set({ status: 'error', preview: parsePreview(error.body.preview), error: '存在冲突，修正路径映射或清理目标冲突后重新预检。' })
          return
        }
        throw error
      }
    })
  }
  async confirm(): Promise<void> {
    const challenge = this.#challenge
    if (challenge === undefined) throw new Error('当前没有可确认的迁移预检')
    await this.#run(async () => {
      const body = await this.#request('/api/xiaoshe/migration/confirm', { challengeId: challenge.id, token: challenge.token })
      this.#challenge = undefined
      this.#set({ status: 'ready', host: parseHostSnapshot(requiredRecord(body, 'snapshot')) })
    })
  }
  clearChallenge(): void {
    this.#challenge = undefined
    const { challenge: _challenge, ...visible } = this.#snapshot
    this.#set({ ...visible, status: 'idle' })
  }
  dispose(): void { this.#disposed = true; this.#challenge = undefined; this.#listeners.clear() }

  async #run(action: () => Promise<void>): Promise<void> {
    if (this.#disposed) throw new Error('migration client is disposed')
    if (this.#snapshot.status === 'working') throw new Error('迁移操作正在进行')
    const { error: _error, ...visible } = this.#snapshot
    this.#set({ ...visible, status: 'working' })
    try { await action() }
    catch (error) { this.#set({ ...this.#snapshot, status: 'error', error: safeMessage(error) }); throw error }
  }
  async #request(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.#fetcher(path, body === undefined ? { method: 'GET', credentials: 'same-origin' } : {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    let value: unknown
    try { value = await response.json() } catch { throw new MigrationClientError(`迁移接口返回了无法解析的响应（HTTP ${response.status}）`) }
    if (!isRecord(value)) throw new MigrationClientError('迁移接口响应不是对象')
    if (!response.ok) throw new MigrationClientError(typeof value.error === 'string' ? value.error : `迁移请求失败（HTTP ${response.status}）`, value)
    return value
  }
  #set(snapshot: MigrationClientSnapshot): void {
    // Remove undefined optional fields so exact snapshots remain compact and stable.
    this.#snapshot = Object.freeze(Object.fromEntries(Object.entries(snapshot).filter(([, value]) => value !== undefined))) as MigrationClientSnapshot
    for (const listener of this.#listeners) listener()
  }
}

export const inject = ['slots', 'workspaces']

/** Contribute the migration surface to Settings; the native shell remains only the window owner. */
export function apply(
  ctx: ClientContextLike,
  react: ReactLike = require('react') as ReactLike,
  fetcher: FetchLike = globalThis.fetch.bind(globalThis),
): () => void {
  const client = new MigrationRecoveryClient(fetcher)
  const Section = createMigrationSection(react)
  ctx.provide('xiaosheMigrationRecoveryClient', client)
  void client.load()
  const release = ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'migration-recovery', order: 34, label: '迁移与恢复',
    inject: () => ({ client, pickDirectory: () => ctx.workspaces.pickDirectory() }),
  }, Section))
  ctx.effect(() => () => client.dispose(), 'xiaoshe-migration-recovery: client controller')
  return () => { release(); client.dispose() }
}

interface SectionProps { readonly client: MigrationRecoveryClient; readonly pickDirectory: () => Promise<string | null> }
function createMigrationSection(react: ReactLike): (props: SectionProps) => unknown {
  const e = react.createElement
  return function MigrationRecoverySection({ client, pickDirectory }: SectionProps): unknown {
    const snapshot = react.useSyncExternalStore(client.subscribe, client.getSnapshot)
    const [exportPath, setExportPath] = react.useState('')
    const [bundlePath, setBundlePath] = react.useState('')
    const [mappingText, setMappingText] = react.useState('')
    const [mappingError, setMappingError] = react.useState('')
    const busy = snapshot.status === 'working'
    const parse = (): readonly WorkspacePathMapping[] | undefined => {
      try { const value = parseWorkspaceMappings(mappingText); setMappingError(''); return value }
      catch (error) { setMappingError(safeMessage(error)); return undefined }
    }
    const chooseExport = async (): Promise<void> => {
      const directory = await pickDirectory(); if (directory !== null) setExportPath(defaultExportTarget(directory))
    }
    const chooseImport = async (): Promise<void> => { const directory = await pickDirectory(); if (directory !== null) setBundlePath(directory) }
    const withMappings = (action: (mappings: readonly WorkspacePathMapping[]) => Promise<void>): void => {
      const mappings = parse(); if (mappings !== undefined) void action(mappings).catch(() => undefined)
    }
    return e('div', { className: 'xs-migration' },
      e('style', null, MIGRATION_CSS),
      e('div', { className: 'xs-migration-head' },
        e('div', null, e('h2', null, '迁移与恢复'), e('p', null, '跨设备带走会话、可迁移设置、记忆与插件审计清单；密钥不会导出。')),
        e('span', { className: `xs-migration-state state-${snapshot.host?.state ?? snapshot.status}` }, statusLabel(snapshot))),
      snapshot.error === undefined && mappingError === '' ? null : e('p', { className: 'xs-migration-error', role: 'alert' }, mappingError || snapshot.error),
      e('section', { className: 'xs-migration-card' },
        e('div', { className: 'xs-migration-title' }, e('b', null, '导出这台设备'), e('span', null, '原子生成一个可检查目录；目标必须尚不存在。')),
        e('div', { className: 'xs-migration-row' },
          e('input', { value: exportPath, spellCheck: false, placeholder: '选择父目录后自动生成迁移包名', onChange: (event: { currentTarget: HTMLInputElement }) => setExportPath(event.currentTarget.value) }),
          e('button', { type: 'button', disabled: busy, onClick: () => { void chooseExport().catch(() => undefined) } }, '选择'),
          e('button', { type: 'button', className: 'primary', disabled: busy || exportPath.trim() === '', onClick: () => { void client.exportTo(exportPath.trim()).catch(() => undefined) } }, busy ? '处理中…' : '开始导出')),
        snapshot.host?.lastExport === undefined ? null : e('small', null, `最近导出：${snapshot.host.lastExport.path} · ${snapshot.host.lastExport.files} 个文件`)),
      e('section', { className: 'xs-migration-card' },
        e('div', { className: 'xs-migration-title' }, e('b', null, '导入到这台设备'), e('span', null, '先校验和预览；任何不同内容都阻止覆盖。中断后重新预检即可续跑。')),
        e('div', { className: 'xs-migration-row' },
          e('input', { value: bundlePath, spellCheck: false, placeholder: '选择含 manifest.json 的迁移目录', onChange: (event: { currentTarget: HTMLInputElement }) => setBundlePath(event.currentTarget.value) }),
          e('button', { type: 'button', disabled: busy, onClick: () => { void chooseImport().catch(() => undefined) } }, '选择')),
        e('label', { className: 'xs-migration-map' }, e('span', null, '工作区路径映射（每行：旧路径 => 新路径）'),
          e('textarea', { value: mappingText, rows: 3, spellCheck: false, placeholder: 'C:\\旧项目 => D:\\新项目\n/Users/old/project => /Users/new/project', onChange: (event: { currentTarget: HTMLTextAreaElement }) => setMappingText(event.currentTarget.value) })),
        e('div', { className: 'xs-migration-actions' },
          e('button', { type: 'button', disabled: busy || bundlePath.trim() === '', onClick: () => withMappings(mappings => client.inspect(bundlePath.trim(), mappings)) }, '仅预检'),
          e('button', { type: 'button', className: 'primary', disabled: busy || bundlePath.trim() === '', onClick: () => withMappings(mappings => client.prepare(bundlePath.trim(), mappings)) }, '准备导入')),
        renderPreview(e, snapshot.preview),
        snapshot.challenge === undefined ? null : e('div', { className: 'xs-migration-confirm' },
          e('b', null, `已绑定 ${snapshot.challenge.sessions} 条会话，确认有效至 ${new Date(snapshot.challenge.expiresAt).toLocaleTimeString()}`),
          e('ul', null, ...snapshot.challenge.disclosures.map((row, index) => e('li', { key: index }, row))),
          e('div', { className: 'xs-migration-actions' },
            e('button', { type: 'button', disabled: busy, onClick: () => client.clearChallenge() }, '取消'),
            e('button', { type: 'button', className: 'danger', disabled: busy, onClick: () => { void client.confirm().catch(() => undefined) } }, '确认写入本机')))),
      e('p', { className: 'xs-migration-note' }, '不会迁移 API 密钥、登录令牌、系统权限或本机绝对路径授权；它们必须在目标设备重新配置。'))
  }
}

function renderPreview(e: ReactLike['createElement'], preview: MigrationPreview | undefined): unknown {
  if (preview === undefined) return null
  const conflictRows = preview.conflicts.map(conflictLabel)
  return e('div', { className: `xs-migration-preview ${conflictRows.length === 0 ? 'ok' : 'blocked'}` },
    e('b', null, conflictRows.length === 0 ? `预检通过 · ${preview.sessions.length} 条会话` : `预检阻止 · ${conflictRows.length} 个冲突`),
    conflictRows.length === 0 ? e('span', null, `包指纹 ${preview.bundleHash.slice(0, 12)}…`) : e('ul', null, ...conflictRows.map((row, index) => e('li', { key: index }, row))))
}
function conflictLabel(conflict: MigrationConflict): string {
  if (conflict.kind === 'path-unmapped') return `未映射路径：${conflict.detail}`
  if (conflict.kind === 'session-different') return `会话 ${conflict.id} 已存在且内容不同`
  return `设置 ${conflict.id} 已存在且内容不同`
}
function statusLabel(snapshot: MigrationClientSnapshot): string {
  if (snapshot.status === 'working') return '处理中'
  if (snapshot.host?.state === 'succeeded') return '最近操作成功'
  if (snapshot.host?.state === 'failed' || snapshot.status === 'error') return '需要处理'
  if (snapshot.challenge !== undefined) return '等待确认'
  return '就绪'
}

export function parseWorkspaceMappings(value: string): readonly WorkspacePathMapping[] {
  const rows: WorkspacePathMapping[] = []
  for (const [index, raw] of value.split(/\r?\n/u).entries()) {
    const line = raw.trim(); if (line === '') continue
    const parts = line.split(/\s*(?:=>|→)\s*/u)
    if (parts.length !== 2 || parts[0]?.trim() === '' || parts[1]?.trim() === '') throw new TypeError(`第 ${index + 1} 行应为“旧路径 => 新路径”`)
    rows.push(Object.freeze({ from: parts[0]!.trim(), to: parts[1]!.trim() }))
  }
  if (rows.length > 200) throw new RangeError('路径映射不能超过 200 条')
  return Object.freeze(rows)
}
export function defaultExportTarget(directory: string, now = new Date()): string {
  const separator = /^[A-Za-z]:[\\/]/u.test(directory) || directory.includes('\\') ? '\\' : '/'
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  return `${directory.replace(/[\\/]+$/u, '')}${separator}小蛇迁移-${stamp}`
}

function parseHostSnapshot(value: unknown): MigrationRecoverySnapshot {
  if (!isRecord(value) || typeof value.state !== 'string' || typeof value.updatedAt !== 'number') throw new TypeError('迁移状态响应无效')
  return Object.freeze(structuredClone(value)) as unknown as MigrationRecoverySnapshot
}
function parsePreview(value: Record<string, unknown>): MigrationPreview {
  if (typeof value.bundlePath !== 'string' || typeof value.bundleHash !== 'string' || !Array.isArray(value.mappings) || !Array.isArray(value.sessions) || !Array.isArray(value.conflicts)) throw new TypeError('迁移预检响应无效')
  return Object.freeze(structuredClone(value)) as unknown as MigrationPreview
}
function parseChallenge(value: Record<string, unknown>): MigrationImportChallenge {
  if (typeof value.id !== 'string' || typeof value.token !== 'string' || typeof value.expiresAt !== 'string' || typeof value.bundlePath !== 'string' || typeof value.bundleHash !== 'string' || typeof value.sessions !== 'number' || !Array.isArray(value.disclosures)) throw new TypeError('迁移确认响应无效')
  return Object.freeze(structuredClone(value)) as unknown as MigrationImportChallenge
}
function requiredRecord(value: unknown, field: string): Record<string, unknown> { if (!isRecord(value) || !isRecord(value[field])) throw new TypeError(`迁移响应缺少 ${field}`); return value[field] }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) }

const MIGRATION_CSS = `
.xs-migration{display:grid;gap:16px;color:var(--fg,#26332d);max-width:760px}.xs-migration-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.xs-migration h2{font:600 20px/1.25 ui-sans-serif,system-ui;margin:0 0 5px}.xs-migration p{margin:0;color:color-mix(in srgb,currentColor 62%,transparent);line-height:1.65}.xs-migration-state{font-size:12px;padding:5px 10px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:999px;background:color-mix(in srgb,#789583 8%,transparent);white-space:nowrap}.xs-migration-card{display:grid;gap:12px;padding:16px;border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:14px;background:color-mix(in srgb,#789583 3.5%,transparent);box-shadow:0 8px 28px rgba(38,51,45,.035)}.xs-migration-title{display:grid;gap:3px}.xs-migration-title b{font-size:14px}.xs-migration-title span,.xs-migration small,.xs-migration-map span{font-size:12px;color:color-mix(in srgb,currentColor 55%,transparent)}.xs-migration-row{display:flex;gap:8px}.xs-migration input,.xs-migration textarea{box-sizing:border-box;min-width:0;width:100%;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:10px;background:color-mix(in srgb,canvas 92%,transparent);color:inherit;padding:9px 11px;font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;outline:none}.xs-migration input:focus,.xs-migration textarea:focus{border-color:#789583;box-shadow:0 0 0 3px rgba(120,149,131,.12)}.xs-migration button{border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:9px;background:color-mix(in srgb,canvas 92%,transparent);color:inherit;padding:8px 13px;white-space:nowrap;cursor:pointer}.xs-migration button:disabled{opacity:.45;cursor:not-allowed}.xs-migration button.primary{background:#34483e;color:#fff;border-color:#34483e}.xs-migration button.danger{background:#70443f;color:#fff;border-color:#70443f}.xs-migration-map{display:grid;gap:7px}.xs-migration-actions{display:flex;justify-content:flex-end;gap:8px}.xs-migration-preview,.xs-migration-confirm{display:grid;gap:7px;border-radius:11px;padding:11px 12px;font-size:12px}.xs-migration-preview.ok{background:rgba(120,149,131,.09);border-left:2px solid #789583}.xs-migration-preview.blocked,.xs-migration-error{background:rgba(155,93,78,.08);border-left:2px solid #9b5d4e}.xs-migration-preview ul,.xs-migration-confirm ul{margin:2px 0 0;padding-left:20px;display:grid;gap:4px}.xs-migration-confirm{border:1px solid rgba(155,93,78,.22);background:rgba(155,93,78,.045)}.xs-migration-error{padding:9px 11px!important;color:#7b453b!important}.xs-migration-note{font-size:12px!important;padding:0 2px}@media(max-width:680px){.xs-migration-head,.xs-migration-row{flex-direction:column}.xs-migration-row button{width:100%}.xs-migration-state{align-self:flex-start}}
`
