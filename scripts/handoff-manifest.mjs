#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IGNORED_DIRS = new Set([
  '.git',
  '.artifacts',
  '.cache',
  '.dsh-build',
  '.pnpm-store',
  '.pytest_cache',
  '.sessions',
  '.state',
  '.storages',
  '.session',
  '.vitest',
  '.worktrees',
  '__pycache__',
  'coverage',
  'dist',
  'dist-exe',
  'logs',
  'node_modules',
  'tmp',
])
const DSH_IGNORED_DIRS = new Set(['lib'])

function toPosix(value) {
  return value.split(sep).join('/')
}

function parseArgs(argv) {
  const command = argv[2]
  let root = SCRIPT_ROOT
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === '--root' && argv[index + 1]) {
      root = resolve(argv[index + 1])
      index += 1
      continue
    }
    throw new Error(`未知参数：${argv[index]}`)
  }
  if (!['generate', 'verify'].includes(command)) {
    throw new Error('用法：node scripts/handoff-manifest.mjs <generate|verify> [--root <XS目录>]')
  }
  return { command, root }
}

function shouldIgnore(relativePath, isDirectory) {
  const normalized = toPosix(relativePath)
  const parts = normalized.split('/')
  if (isDirectory && parts.some((part) => IGNORED_DIRS.has(part))) return true
  if (isDirectory && parts[0] === 'runtime' && parts[1] === 'DSH' && parts.some((part) => DSH_IGNORED_DIRS.has(part))) return true
  if (isDirectory && parts[0] === 'packages' && parts.length >= 3 && parts[2] === 'lib') return true
  if (isDirectory && normalized === 'runtime/xiaoshe-legacy/Harness交接') return true
  if (parts.includes('.DS_Store')) return true
  const basename = parts.at(-1) ?? ''
  if ((basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example'))
    || basename === '.credentials.yaml' || basename === 'mcp.json' || basename === 'ui_token'
    || basename.startsWith('model_secrets.bin')) return true
  if (/\.(?:log|pyc|tsbuildinfo)$/u.test(normalized) && normalized !== 'docs/evidence/macos-terminal-screen-smoke.log') return true
  if (normalized === '交接工具/完整性清单.json') return true
  if (/^交接工具\/XS-完整交接包-.*\.(?:tar\.gz|zip)(?:\.sha256)?$/u.test(normalized)) return true
  return false
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function collectFiles(root) {
  const entries = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      const absolutePath = join(directory, child.name)
      const relativePath = toPosix(relative(root, absolutePath))
      if (shouldIgnore(relativePath, child.isDirectory())) continue
      if (child.isDirectory()) {
        pending.push(absolutePath)
        continue
      }
      if (shouldIgnore(relativePath, false)) continue
      const stat = await lstat(absolutePath)
      if (stat.isSymbolicLink()) {
        const target = await readlink(absolutePath)
        entries.push({
          path: relativePath,
          type: 'symlink',
          size: Buffer.byteLength(target),
          sha256: createHash('sha256').update(`symlink:${target}`).digest('hex'),
        })
      } else if (stat.isFile()) {
        entries.push({ path: relativePath, type: 'file', size: stat.size, sha256: await sha256File(absolutePath) })
      }
    }
  }
  const portableEntries = new Map(entries.map((entry) => [entry.path, entry]))
  for (const entry of collectGitSymlinkEntries(root)) portableEntries.set(entry.path, entry)
  return [...portableEntries.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function collectGitSymlinkEntries(root) {
  const entries = []
  const repositories = [
    { prefix: '', path: root },
    { prefix: 'runtime/DSH', path: join(root, 'runtime', 'DSH') },
    { prefix: 'runtime/xiaoshe-legacy', path: join(root, 'runtime', 'xiaoshe-legacy') },
  ]
  for (const repository of repositories) {
    const index = runGit(repository.path, ['ls-files', '--stage', '-z']) ?? ''
    for (const record of index.split('\0').filter(Boolean)) {
      const match = /^120000 ([0-9a-f]+) 0\t(.+)$/su.exec(record)
      if (match === null) continue
      const [, objectId, repoPath] = match
      const path = repository.prefix === '' ? repoPath : `${repository.prefix}/${repoPath}`
      if (shouldIgnore(path, false)) continue
      const blob = spawnSync('git', ['-C', repository.path, 'cat-file', 'blob', objectId], {
        encoding: null,
        maxBuffer: 1024 * 1024,
      })
      if (blob.status !== 0) throw new Error(`Git symlink blob cannot be read: ${path}`)
      const target = blob.stdout.toString('utf8')
      entries.push({
        path,
        type: 'symlink',
        size: blob.stdout.byteLength,
        sha256: createHash('sha256').update(`symlink:${target}`).digest('hex'),
      })
    }
  }
  return entries
}

function runGit(repo, args, { optional = false } = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    if (optional) return null
    throw new Error(`Git 校验失败（${toPosix(relative(SCRIPT_ROOT, repo)) || '.'}）：${result.stderr.trim()}`)
  }
  return result.stdout
}

function gitSnapshot(root, relativeRepo) {
  const repo = join(root, relativeRepo)
  const head = runGit(repo, ['rev-parse', 'HEAD'])?.trim()
  const branch = runGit(repo, ['branch', '--show-current'])?.trim() || '(detached)'
  const statusArgs = [
    'status', '--porcelain=v1', '--untracked-files=all', '-z', '--', '.',
    // 使用 glob pathspec，确保 Windows Git 也会把敏感文件和可再生成产物排除在工作树指纹外。
    ':(exclude,glob)**/.env', ':(exclude,glob)**/.env.*', ':(exclude,glob)**/.credentials.yaml',
    ':(exclude,glob)**/mcp.json', ':(exclude,glob)**/model_secrets.bin*',
    ':(exclude,glob)**/.state/**', ':(exclude,glob)**/.session/**', ':(exclude,glob)**/.sessions/**',
    ':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/coverage/**', ':(exclude,glob)**/dist/**',
    ':(exclude,glob)packages/*/lib/**', ':(exclude,glob)runtime/DSH/lib/**',
    ':(exclude,glob)runtime/xiaoshe-legacy/Harness交接/**',
  ]
  // runtime 是独立仓库，交接清单是可再生成产物；它们不应污染 XS 本体的工作树指纹。
  if (!relativeRepo) statusArgs.push(
    ':(exclude,glob)runtime/**',
    ':(exclude,glob)交接工具/完整性清单.json',
    ':(exclude,glob)交接工具/XS-完整交接包-*',
  )
  const status = runGit(repo, statusArgs) ?? ''
  return {
    path: relativeRepo || '.',
    head,
    branch,
    dirtyEntryCount: status.split('\0').filter(Boolean).length,
    statusSha256: createHash('sha256').update(status).digest('hex'),
  }
}

async function generate(root, manifestPath) {
  for (const required of ['package.json', 'runtime/DSH/package.json', 'runtime/xiaoshe-legacy/run.py']) {
    await lstat(join(root, required)).catch(() => {
      throw new Error(`交接载荷不完整，缺少：${required}`)
    })
  }
  const files = await collectFiles(root)
  const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0)
  const manifest = {
    schema: 'xiaoshe-handoff-manifest/v1',
    generatedAt: new Date().toISOString(),
    policy: {
      includes: ['XS 产品层与 Git 工作树', 'DSH 完整源码与 Git 历史', '旧小蛇兼容层当前未提交工作树', '交接文档和接收工具'],
      excludes: ['凭据、API Key、Token', '个人会话与本机运行状态', 'node_modules、构建产物、日志与缓存', '旧的重复 Harness交接包'],
    },
    summary: { fileCount: files.length, totalBytes },
    git: [gitSnapshot(root, ''), gitSnapshot(root, 'runtime/DSH'), gitSnapshot(root, 'runtime/xiaoshe-legacy')],
    files,
  }
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`[完成] 已生成完整性清单：${manifest.summary.fileCount} 个文件，${manifest.summary.totalBytes} 字节\n`)
}

async function verify(root, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.schema !== 'xiaoshe-handoff-manifest/v1') throw new Error('不支持的完整性清单版本')
  const actual = await collectFiles(root)
  const expectedMap = new Map(manifest.files.map((entry) => [entry.path, entry]))
  const actualMap = new Map(actual.map((entry) => [entry.path, entry]))
  const failures = []
  for (const [path, expected] of expectedMap) {
    const found = actualMap.get(path)
    if (!found) failures.push(`缺少：${path}`)
    else if (found.type !== expected.type || found.size !== expected.size || found.sha256 !== expected.sha256) failures.push(`变更：${path}`)
  }
  for (const path of actualMap.keys()) {
    if (!expectedMap.has(path)) failures.push(`额外：${path}`)
  }
  for (const expected of manifest.git) {
    const repo = join(root, expected.path === '.' ? '' : expected.path)
    runGit(repo, ['fsck', '--full', '--no-dangling'])
    const actualGit = gitSnapshot(root, expected.path === '.' ? '' : expected.path)
    if (actualGit.head !== expected.head) failures.push(`Git HEAD 不一致：${expected.path}`)
    if (actualGit.statusSha256 !== expected.statusSha256) failures.push(`Git 工作树不一致：${expected.path}`)
  }
  if (failures.length > 0) {
    const preview = failures.slice(0, 30).map((item) => `  - ${item}`).join('\n')
    throw new Error(`交接校验失败，共 ${failures.length} 项：\n${preview}${failures.length > 30 ? '\n  - ……' : ''}`)
  }
  process.stdout.write(`[通过] 文件哈希、Git 对象、HEAD 与工作树一致（${actual.length} 个文件）\n`)
}

try {
  const { command, root } = parseArgs(process.argv)
  const manifestPath = join(root, '交接工具', '完整性清单.json')
  if (command === 'generate') await generate(root, manifestPath)
  else await verify(root, manifestPath)
} catch (error) {
  process.stderr.write(`[错误] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
