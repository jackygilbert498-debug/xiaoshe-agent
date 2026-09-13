import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const IGNORE = new Set(['.git', 'node_modules', '.pnpm-store', '.venv', '__pycache__', '.pytest_cache', '.cache', 'test', 'tests', '__tests__', 'docs', 'output', 'artifacts', 'dist-desktop', '.xiaoshe', '.dsh', '.superpowers'])
const METADATA = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.build.json', 'cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml', 'cordis.yaml']
const PRODUCT_INPUTS = [...METADATA, 'src', 'dist', 'packages', 'python', 'scripts', 'setup']
const DSH_INPUTS = [...METADATA, 'apps', 'packages', 'scripts', 'native', 'python']
const LEGACY_INPUTS = ['run.py', 'harness', 'ui', 'requirements.txt', 'pyproject.toml']
const MAX_INPUT_ENTRIES = 100_000

function ignored(name, directory = '') {
  const runtimeText = directory.split(/[\\/]/u).some(part => ['src', 'lib', 'dist', 'prompts', 'skills', 'assets', 'resources'].includes(part))
  return IGNORE.has(name) || (/\.md$/iu.test(name) && (!runtimeText || /^(?:readme|changelog|license)(?:\.|$)/iu.test(name)))
    || /(?:\.(?:test|spec)\.[^/]+|\.py[co]|\.map)$/iu.test(name)
    || /^test_.*\.py$/iu.test(name) || /_test\.py$/iu.test(name)
}

function contained(root, path) {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}

function argumentsMap(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || values.has(key)) throw new Error('Usage: product-runtime-identity.mjs --root <path> --dsh-root <path> --profile-root <path>')
    values.set(key, value)
  }
  return values
}

async function digestTree(label, root, selection) {
  const canonicalRoot = await realpath(root)
  const files = new Set()
  const visited = new Set()
  async function visit(path, depth = 0) {
    if (visited.has(path)) return
    visited.add(path)
    if (visited.size > MAX_INPUT_ENTRIES || depth > 64) throw new Error('runtime identity input exceeds the bounded file inventory')
    const info = await lstat(path)
    if (info.isSymbolicLink() || !contained(canonicalRoot, await realpath(path))) throw new Error(`unsafe symbolic link in runtime identity input: ${path}`)
    if (info.isFile()) { files.add(path); return }
    if (!info.isDirectory()) throw new Error(`unsafe runtime identity entry: ${path}`)
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (ignored(entry.name, relative(canonicalRoot, path))) continue
      await visit(join(path, entry.name), depth + 1)
    }
  }
  if (selection === undefined) await visit(canonicalRoot)
  else for (const item of selection) {
    if (typeof item !== 'string' || item === '' || isAbsolute(item) || !contained(canonicalRoot, resolve(canonicalRoot, item))) throw new Error('unsafe runtime payload path')
    if (item.split(/[\\/]/u).some(part => IGNORE.has(part))) continue
    if (ignored(item.split(/[\\/]/u).at(-1), dirname(item))) continue
    const path = resolve(canonicalRoot, item)
    try { await lstat(path) } catch (error) { if (error?.code === 'ENOENT') continue; throw error }
    await visit(path)
  }
  const entries = []
  for (const path of [...files].sort()) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || !contained(canonicalRoot, await realpath(path))) throw new Error(`unsafe runtime identity file: ${path}`)
    entries.push([relative(canonicalRoot, path).split(sep).join('/'), createHash('sha256').update(await readFile(path)).digest('hex')])
  }
  return [label, canonicalRoot, entries]
}

async function digestOptionalTree(label, root, selection) {
  try { await lstat(root) } catch (error) { if (error?.code === 'ENOENT') return [label, []]; throw error }
  return await digestTree(label, root, selection)
}

/** Package payloads may include executable scripts but never an entire linked checkout. */
async function packageInputs(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const inputs = new Set([...METADATA, 'src', 'lib', 'dist', 'bin', 'scripts'])
  function add(value) {
    if (typeof value === 'string') {
      const path = value.replace(/^\.\//u, '')
      if (path.startsWith('!')) return
      if (isAbsolute(path) || path.split(/[\\/]/u).includes('..')) throw new Error('unsafe runtime payload path')
      // A declared glob scopes its containing directory; traversal still applies
      // the data/test exclusions and rejects links inside that scope.
      const wildcard = path.search(/[?*[{]/u)
      const fixed = wildcard < 0 ? path : path.slice(0, wildcard)
      const separator = Math.max(fixed.lastIndexOf('/'), fixed.lastIndexOf('\\'))
      const prefix = wildcard < 0 ? fixed : separator < 0 ? '.' : fixed.slice(0, separator)
      inputs.add(prefix || '.')
    } else if (Array.isArray(value)) value.forEach(add)
    else if (value && typeof value === 'object') Object.values(value).forEach(add)
  }
  add(manifest.files); add(manifest.main); add(manifest.exports); add(manifest.bin)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:js|mjs|cjs|json|wasm|node)$/u.test(entry.name) && !ignored(entry.name)) inputs.add(entry.name)
  }
  return [...inputs]
}

async function controlledProfilePackages(profileRoot, knownRoots) {
  const manifestPath = join(profileRoot, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const dependencies = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
  const inputs = []
  for (const [name, spec] of dependencies.sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof spec !== 'string') throw new TypeError(`invalid direct Profile dependency: ${name}`)
    const installed = join(profileRoot, 'node_modules', ...name.split('/'))
    let packageRoot
    try { packageRoot = await realpath(installed) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      if (!/^(?:file|link):/u.test(spec)) throw new Error(`direct Profile package is not installed: ${name}`)
      packageRoot = resolve(dirname(manifestPath), spec.replace(/^(?:file|link):/u, ''))
    }
    packageRoot = await realpath(packageRoot)
    if (knownRoots.has(packageRoot)) inputs.push([`profile-package:${name}`, packageRoot])
    else inputs.push(await digestTree(`profile-package:${name}`, packageRoot, await packageInputs(packageRoot)))
  }
  return inputs
}

/** Content and Profile digest used solely for startup reuse, never as a signing claim. */
export async function productRuntimeIdentity({ root, dshRoot, profileRoot }) {
  for (const path of [root, dshRoot, profileRoot]) if (!isAbsolute(path ?? '')) throw new TypeError('runtime identity paths must be absolute')
  const canonicalRoots = await Promise.all([root, dshRoot, profileRoot].map(path => realpath(path)))
  const inputs = await Promise.all([
    digestTree('product', root, [...new Set([...PRODUCT_INPUTS, ...await packageInputs(root)])]),
    digestTree('dsh', dshRoot, DSH_INPUTS),
    digestOptionalTree('legacy', join(root, 'runtime', 'xiaoshe-legacy'), LEGACY_INPUTS),
    digestTree('profile-config', profileRoot, ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml', 'cordis.yaml']),
  ])
  inputs.push(...await controlledProfilePackages(profileRoot, new Set(canonicalRoots)))
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const values = argumentsMap(process.argv.slice(2))
  const identity = await productRuntimeIdentity({ root: resolve(values.get('--root') ?? ''), dshRoot: resolve(values.get('--dsh-root') ?? ''), profileRoot: resolve(values.get('--profile-root') ?? '') })
  process.stdout.write(`${JSON.stringify({ schema: 'xiaoshe-runtime-identity/v1', identity })}\n`)
}
