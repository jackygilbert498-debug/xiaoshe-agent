import { spawn } from 'node:child_process'

export interface GitChange { readonly kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'; readonly path: string; readonly originalPath?: string; readonly staged?: boolean }
export interface GitResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean; readonly truncated: boolean }
export type GitRun = (cwd: string, args: readonly string[], signal?: AbortSignal) => Promise<GitResult>

export class WorkspaceGit {
  constructor(private readonly run: GitRun = runGit) {}
  async status(root: string, signal?: AbortSignal): Promise<readonly GitChange[]> {
    const result = await this.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=normal'], signal)
    assertGit(result, 'git status')
    return parseGitStatusPorcelainV2(result.stdout)
  }
  async diff(root: string, options: { readonly staged?: boolean; readonly path?: string; readonly maxBytes?: number } = {}, signal?: AbortSignal): Promise<{ readonly text: string; readonly truncated: boolean }> {
    const args = ['diff', '--no-ext-diff', '--no-color', '--unified=3', ...(options.staged === true ? ['--cached'] : []), ...(options.path === undefined ? [] : ['--', options.path])]
    const result = await this.run(root, args, signal); assertGit(result, 'git diff')
    const max = options.maxBytes ?? 512 * 1024; const bytes = Buffer.from(result.stdout)
    return Object.freeze({ text: bytes.subarray(0, max).toString('utf8'), truncated: result.truncated || bytes.byteLength > max })
  }
}

export function parseGitStatusPorcelainV2(value: string): readonly GitChange[] {
  const parts = value.split('\0'); const output: GitChange[] = []
  for (let index = 0; index < parts.length; index++) {
    const row = parts[index]; if (row === undefined || row === '') continue
    if (row.startsWith('? ')) { output.push({ kind: 'untracked', path: row.slice(2) }); continue }
    if (row.startsWith('u ')) { output.push({ kind: 'conflicted', path: row.split(' ').at(-1)! }); continue }
    const fields = row.split(' '); if (fields[0] !== '1' && fields[0] !== '2') continue
    const xy = fields[1] ?? '..'; const path = fields.at(-1)!; const renamed = fields[0] === '2'
    const originalPath = renamed ? parts[++index] : undefined
    output.push({ kind: renamed ? 'renamed' : changeKind(xy), path, ...(originalPath === undefined ? {} : { originalPath }), staged: xy[0] !== '.' })
  }
  return Object.freeze(output.sort((a, b) => a.path.localeCompare(b.path)))
}
export function parseNameStatus(value: string): readonly GitChange[] {
  const output: GitChange[] = []
  for (const line of value.split(/\r?\n/u)) {
    if (line === '') continue
    const [code = '', first = '', second] = line.split('\t')
    if (code.startsWith('R') && second !== undefined) output.push({ kind: 'renamed', path: second, originalPath: first })
    else output.push({ kind: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified', path: first })
  }
  return Object.freeze(output)
}
function changeKind(xy: string): GitChange['kind'] { return xy.includes('A') ? 'added' : xy.includes('D') ? 'deleted' : 'modified' }
function assertGit(result: GitResult, label: string): void { if (result.exitCode !== 0 || result.timedOut) throw new Error(`${label} failed: ${result.stderr.slice(-500)}`) }

export async function runGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<GitResult> {
  if (args.some(value => /[\r\n\0]/u.test(value))) throw new TypeError('git argument contains a control character')
  return runBounded('git', args, cwd, 30_000, 1024 * 1024, signal)
}
export async function runBounded(command: string, args: readonly string[], cwd: string, timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, shell: false, windowsHide: true, env: safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0); let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0); let truncated = false; let timedOut = false
    const add = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => { const next = Buffer.concat([current, chunk]); if (next.byteLength <= maxBytes) return next; truncated = true; return next.subarray(next.byteLength - maxBytes) }
    child.stdout?.on('data', (chunk: Buffer) => { stdout = add(stdout, chunk) }); child.stderr?.on('data', (chunk: Buffer) => { stderr = add(stderr, chunk) })
    const stop = (): void => { if (child.exitCode === null) child.kill() }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs); timer.unref()
    signal?.addEventListener('abort', stop, { once: true })
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolvePromise({ exitCode: code ?? -1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut, truncated }) })
  })
}
function safeEnvironment(): NodeJS.ProcessEnv { return Object.fromEntries(['PATH', 'PATHEXT', 'SystemRoot', 'HOME', 'USERPROFILE', 'TMP', 'TEMP'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])) }
