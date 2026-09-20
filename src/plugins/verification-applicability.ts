import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path'
import { standaloneArtifactKind, isPlainDocumentWrite } from '@xiaoshe/verification-policy'
import { observeDataFile, type OutputObservation } from './verification-file-proofs.js'

export interface ArtifactContext {
  readonly path: string
  readonly kind: 'script' | 'plist' | 'document'
  readonly context: string
}
export interface ArtifactRead extends ArtifactContext { readonly observation: OutputObservation }
export interface ArtifactMutation extends ArtifactContext { readonly expected: string }

export function prepareArtifact(tool: string, raw: unknown, cwd: string | undefined): ArtifactMutation | undefined {
  const context = artifactContext(tool, raw, cwd)
  if (!context || !raw || typeof raw !== 'object') return undefined
  const args = raw as Record<string, unknown>
  if (tool === 'write' && typeof args.content === 'string' && Buffer.byteLength(args.content) <= 8 * 1024 * 1024) {
    return { ...context, expected: args.content }
  }
  if (tool !== 'edit' || typeof args.old_string !== 'string' || !args.old_string
    || typeof args.new_string !== 'string' || args.replace_all !== undefined && typeof args.replace_all !== 'boolean') return undefined
  const before = observeDataFile(context.path)
  if (!before) return undefined
  const parts = before.content.split(args.old_string)
  if (parts.length < 2 || args.replace_all !== true && parts.length !== 2) return undefined
  const expected = parts.join(args.new_string)
  if (context.kind === 'document' && !isPlainDocumentWrite('write', { file_path: `output/${context.path.split('/').at(-1)}`, content: expected })) return undefined
  return Buffer.byteLength(expected) <= 8 * 1024 * 1024 ? { ...context, expected } : undefined
}

const inside = (root: string, target: string): boolean => {
  const part = relative(root, target)
  return part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part)
}
// Absence is checked within the actual workspace and every ancestor of the
// target inside it. Unknown/unreadable/linking contexts retain existing gates.
const PROJECT_ENTRY = /^(?:package\.json|tsconfig(?:\..+)?\.json|jsconfig\.json|(?:gnu)?makefile|cmakelists\.txt|cargo\.toml|go\.mod|pyproject\.toml|setup\.(?:py|cfg)|tox\.ini|pom\.xml|build\.gradle(?:\.kts)?|build\.xml|(?:build|compile|typecheck|check-types)\.(?:sh|bash|zsh)|meson\.build|build\.bazel|justfile|taskfile\.ya?ml|deno\.jsonc?|.*\.(?:sln|csproj|fsproj|vcxproj))$/iu

export function artifactContext(tool: string, raw: unknown, cwd: string | undefined): ArtifactContext | undefined {
  const kind = standaloneArtifactKind(tool, raw)
  if (!kind || !cwd || !raw || typeof raw !== 'object') return undefined
  const target = (raw as { file_path: string }).file_path
  try {
    const workspace = realpathSync.native(resolve(cwd))
    const path = resolve(workspace, target)
    if (path === workspace) return undefined
    // The read tool already enforced access. An explicitly addressed file can
    // live outside cwd (e.g. ~/Library/LaunchAgents); inspect ancestor names,
    // not their contents, to avoid assuming its project has no build entry.
    const boundary = inside(workspace, path) ? workspace : parse(path).root
    const directories: string[] = []
    let directory = dirname(path)
    for (let count = 0; count < 64; count++) {
      if (!inside(boundary, directory) || realpathSync.native(directory) !== directory
        || !lstatSync(directory).isDirectory()) return undefined
      const names = readdirSync(directory)
      if (names.length > 20_000 || names.some(name => PROJECT_ENTRY.test(name))) return undefined
      directories.push(directory)
      if (directory === boundary) break
      directory = dirname(directory)
    }
    if (directories.at(-1) !== boundary) return undefined
    try { if (!lstatSync(path).isFile() || realpathSync.native(path) !== path) return undefined }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined }
    return { path, kind, context: createHash('sha256').update(JSON.stringify({ workspace, directories, kind })).digest('hex') }
  } catch { return undefined }
}

export function artifactRead(raw: unknown, value: unknown, cwd: string | undefined): ArtifactRead | undefined {
  const context = artifactContext('read', raw, cwd)
  if (!context || !raw || typeof raw !== 'object' || Object.keys(raw).some(key => key !== 'file_path')
    || !value || typeof value !== 'object') return undefined
  const result = value as Record<string, unknown>
  const observation = observeDataFile(context.path)
  if (observation && context.kind === 'document'
    && !isPlainDocumentWrite('write', { file_path: `output/${context.path.split('/').at(-1)}`, content: observation.content })) return undefined
  if (!observation || result.path !== context.path || result.offset !== 1
    || ['truncated', 'truncatedByBytes', 'spilled'].some(key => result[key] !== undefined && result[key] !== false)
    || result.spill != null && result.spill !== false || !Array.isArray(result.lines)) return undefined
  const lines = observation.content === '' ? [] : observation.content.split('\n').map(line => line.replace(/\r$/u, ''))
  if (observation.content.endsWith('\n')) lines.pop()
  if (result.totalLines !== lines.length || result.lines.length !== lines.length
    || !result.lines.every((line, index) => line?.number === index + 1 && line?.text === lines[index])) return undefined
  return { ...context, observation }
}
