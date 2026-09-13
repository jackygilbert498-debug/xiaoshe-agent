import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export interface WorkspacePathEntry { readonly id: string; readonly path: string }
export interface WorkspacePathSource { list(): readonly WorkspacePathEntry[] }
export interface ResolvedWorkspacePath {
  readonly workspaceId: string
  readonly root: string
  readonly relativePath: string
  readonly absolutePath: string
}

/** Canonical workspace-id to path boundary. Callers never submit an absolute target. */
export class WorkspacePathPolicy {
  constructor(private readonly source: WorkspacePathSource) {}

  async existing(workspaceId: string, relativePath: string, expected?: 'file' | 'directory'): Promise<ResolvedWorkspacePath> {
    const target = await this.#candidate(workspaceId, relativePath)
    const canonical = await realpath(target.absolutePath)
    assertContained(target.root, canonical)
    const stat = await lstat(canonical)
    if (stat.isSymbolicLink()) throw new TypeError('workspace path cannot end at a symbolic link')
    if (expected === 'file' && !stat.isFile()) throw new TypeError('workspace path must be a file')
    if (expected === 'directory' && !stat.isDirectory()) throw new TypeError('workspace path must be a directory')
    return Object.freeze({ ...target, absolutePath: canonical })
  }

  async forWrite(workspaceId: string, relativePath: string): Promise<ResolvedWorkspacePath> {
    const target = await this.#candidate(workspaceId, relativePath)
    const parent = await realpath(dirname(target.absolutePath))
    assertContained(target.root, parent)
    return Object.freeze({ ...target, absolutePath: resolve(parent, target.absolutePath.slice(dirname(target.absolutePath).length + 1)) })
  }

  async root(workspaceId: string): Promise<ResolvedWorkspacePath> { return this.existing(workspaceId, '.', 'directory') }

  async #candidate(workspaceId: string, input: string): Promise<ResolvedWorkspacePath> {
    if (typeof workspaceId !== 'string' || workspaceId === '' || workspaceId.length > 512 || /[\r\n\0]/u.test(workspaceId)) throw new TypeError('workspace id is invalid')
    if (typeof input !== 'string' || input === '' || input.length > 4_096 || /[\0\r\n]/u.test(input)) throw new TypeError('relative path contains unsupported control characters')
    if (isAbsolute(input) || /^[A-Za-z]:/u.test(input) || /^[/\\]{2}/u.test(input)) throw new TypeError('workspace path must be relative')
    const row = this.source.list().find(item => item.id === workspaceId)
    if (row === undefined) throw new TypeError(`unknown workspace ${workspaceId}`)
    const root = await realpath(resolve(row.path))
    const stat = await lstat(root)
    if (!stat.isDirectory()) throw new TypeError('workspace root must be a directory')
    const absolutePath = resolve(root, input)
    assertContained(root, absolutePath)
    const normalized = relative(root, absolutePath).split(sep).join('/') || '.'
    return Object.freeze({ workspaceId, root, relativePath: normalized, absolutePath })
  }
}

function assertContained(root: string, target: string): void {
  const value = relative(root, target)
  if (value === '') return
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new TypeError('workspace path escape is not allowed')
}
