#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRODUCT_PACKAGES, rewriteWorkspaceDependencies } from './lib/relocatable-product-artifacts.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
const output = resolve(args.output ?? join(root, '交接工具', '离线工件', 'xiaoshe-product'))
assertSafeOutput(output)
const pnpmEntry = await resolvePnpmEntry()

progress('build locked Product packages')
await run(process.execPath, [pnpmEntry, '-r', '--filter', './packages/**', 'run', 'build'], root)
await run(process.execPath, [pnpmEntry, 'run', 'build'], root)

const parent = dirname(output)
await mkdir(parent, { recursive: true })
const temporary = await mkdtemp(join(parent, `.${basename(output)}.tmp-`))
try {
  const packageRows = []
  for (const row of PRODUCT_PACKAGES) {
    progress(`pack ${row.name}`)
    const source = resolve(root, row.relativeDirectory)
    const staging = join(temporary, '.staging', row.name.replaceAll('/', '__'))
    await stagePackage(source, staging, row.licenseRelativePath)
    const manifestPath = join(staging, 'package.json')
    const manifest = rewriteWorkspaceDependencies(JSON.parse(await readFile(manifestPath, 'utf8')))
    delete manifest.devDependencies
    delete manifest.scripts
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await run(process.execPath, [pnpmEntry, '--config.ignore-scripts=true', 'pack', '--pack-destination', temporary], staging)
    const tarball = join(temporary, row.filename)
    const info = await stat(tarball)
    packageRows.push({ ...row, size: info.size, sha256: await sha256(tarball) })
  }
  await rm(join(temporary, '.staging'), { recursive: true, force: true })
  await cp(join(root, 'scripts', 'install-relocatable-product-artifacts.mjs'), join(temporary, 'install.mjs'))
  await cp(join(root, 'scripts', 'relocatable-product-install-contract.mjs'), join(temporary, 'relocatable-product-install-contract.mjs'))
  await chmod(join(temporary, 'install.mjs'), 0o755)
  await writeFile(join(temporary, 'artifact-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'xiaoshe-relocatable-product-artifacts',
    packages: packageRows,
  }, null, 2)}\n`)
  await writeFile(join(temporary, 'README.md'), [
    '# 小蛇可重定位离线 Product 工件',
    '',
    '整个目录可移动到另一台设备或任意新路径。安装器会先验证全部 SHA-256，再按当前位置生成目标 Profile overrides。',
    '',
    '```bash',
    'node install.mjs --dsh-root /path/to/XS/runtime/DSH --dsh-home /path/to/new-dsh-home --profile xiaoshe-relocated',
    '```',
    '',
    '工件不包含 API Key、会话、设置、日志或系统权限。DSH 本体及其锁定依赖需先就绪。',
    '',
  ].join('\n'))
  await writeFile(join(temporary, '.xiaoshe-relocatable-artifacts'), 'schema=1\n')
  if (await exists(output)) {
    const marker = join(output, '.xiaoshe-relocatable-artifacts')
    if (!(await exists(marker))) throw new Error(`refusing to replace unmarked output directory: ${output}`)
    await rm(output, { recursive: true, force: true })
  }
  await rename(temporary, output)
  process.stdout.write(`${JSON.stringify({ status: 'PASS', output, packages: packageRows.length })}\n`)
} catch (error) {
  await rm(temporary, { recursive: true, force: true })
  throw error
}

async function stagePackage(source, staging, licenseRelativePath) {
  await mkdir(staging, { recursive: true })
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const entries = new Set(['package.json', 'README.md', 'LICENSE', ...(Array.isArray(manifest.files) ? manifest.files : [])])
  for (const entry of entries) {
    const from = join(source, entry)
    if (!(await exists(from))) continue
    const destination = join(staging, entry)
    await mkdir(dirname(destination), { recursive: true })
    const info = await lstat(from)
    if (info.isSymbolicLink()) throw new Error(`package input must not be a symlink: ${from}`)
    await cp(from, destination, { recursive: info.isDirectory() })
  }
  if (licenseRelativePath !== undefined && !(await exists(join(staging, 'LICENSE')))) {
    const from = resolve(root, licenseRelativePath)
    const info = await lstat(from)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`package license must be a regular file: ${from}`)
    await cp(from, join(staging, 'LICENSE'))
  }
}

function parseArgs(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 2) {
    if (values[index] !== '--output' || values[index + 1] === undefined) throw new Error('usage: build-relocatable-product-artifacts.mjs [--output <directory>]')
    result.output = values[index + 1]
  }
  return result
}

function assertSafeOutput(path) {
  if (!isAbsolute(path)) throw new Error('output must resolve to an absolute path')
  const relation = relative(root, path)
  if (relation === '' || relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    const allowedTemporaryRoots = [resolve(tmpdir()), ...(process.platform === 'darwin' ? ['/tmp', '/private/tmp'] : [])]
    if (!allowedTemporaryRoots.some(temporaryRoot => isWithin(temporaryRoot, path))) {
      throw new Error('output must be inside XS or the operating-system temporary directory')
    }
  }
}

function isWithin(parent, candidate) {
  const relation = relative(parent, candidate)
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(relation)
}

async function resolvePnpmEntry() {
  const candidates = [
    process.env.XIAOSHE_PNPM_CLI,
    process.env.npm_execpath?.includes('pnpm') === true ? process.env.npm_execpath : undefined,
    join(homedir(), '.local', 'share', 'xiaoshe-handoff', 'pnpm-11.7.0', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ].filter(value => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) if (await exists(candidate)) return candidate
  throw new Error('pnpm JavaScript entry could not be resolved')
}

async function run(command, commandArgs, cwd) {
  const child = spawn(command, commandArgs, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
  if (code !== 0) throw new Error(`${command} exited ${String(code)}\n${output.slice(-4_000)}`)
}

async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex') }
async function exists(path) { try { await access(path); return true } catch { return false } }
function progress(message) { process.stderr.write(`[relocatable-artifacts] ${message}\n`) }
