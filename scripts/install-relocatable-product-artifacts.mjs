#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOST_RUNTIME_LINKS,
  REQUIRED_PRODUCT_ROWS,
  renderHostRuntimeOverrides,
} from './relocatable-product-install-contract.mjs'

const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)))
const args = parseArgs(process.argv.slice(2))
const dshRoot = resolve(args.dshRoot)
const dshHome = resolve(args.dshHome)
const profile = args.profile
if (!/^xiaoshe-[a-z0-9-]{3,80}$/u.test(profile)) throw new Error('profile must be a dedicated xiaoshe-* profile name')
const cli = join(dshRoot, 'apps', 'cli', 'lib', 'bin.js')
await access(cli)
for (const row of HOST_RUNTIME_LINKS) await access(join(dshRoot, row.relativeDirectory))
const manifest = JSON.parse(await readFile(join(artifactRoot, 'artifact-manifest.json'), 'utf8'))
if (manifest?.kind !== 'xiaoshe-relocatable-product-artifacts' || !Array.isArray(manifest.packages)) throw new Error('invalid artifact manifest')
for (const row of manifest.packages) {
  const path = checkedArtifactPath(row.filename)
  const actual = createHash('sha256').update(await readFile(path)).digest('hex')
  if (actual !== row.sha256) throw new Error(`artifact hash mismatch: ${row.filename}`)
}

const env = { ...process.env, DSH_HOME: dshHome, CI: '1' }
const webBundle = `link:${join(dshRoot, 'packages', 'bundle', 'web-app')}`
await runDsh(['plugin', '--profile', profile, 'add', '--offline', webBundle])
const workspacePath = join(dshHome, 'profiles', profile, 'pnpm-workspace.yaml')
const workspace = await readFile(workspacePath, 'utf8')
const begin = '# >>> Xiaoshe relocatable Product artifacts >>>'
if (workspace.includes(begin) || /^overrides:/mu.test(workspace)) throw new Error('target Profile already has unmanaged overrides')
const overrideLines = [begin, 'overrides:']
for (const row of manifest.packages) overrideLines.push(`  '${row.name}': '${yamlQuote(portableFileSpec(checkedArtifactPath(row.filename)))}'`)
for (const [name, spec] of Object.entries(renderHostRuntimeOverrides(dshRoot))) overrideLines.push(`  '${name}': '${yamlQuote(spec)}'`)
overrideLines.push('# <<< Xiaoshe relocatable Product artifacts <<<')
await writeFile(workspacePath, `${workspace.trimEnd()}\n\n${overrideLines.join('\n')}\n`)

// Do not forward tarball paths through `dsh plugin add` one by one. DSH uses
// the Windows command shell to launch pnpm, and an absolute path containing
// spaces can be split before pnpm receives it. Declare the verified file URLs
// in the dedicated Profile first, then let the normal DSH plugin command run
// one path-free offline reconciliation/install pass.
const profileManifestPath = join(dshHome, 'profiles', profile, 'package.json')
const profileManifest = JSON.parse(await readFile(profileManifestPath, 'utf8'))
profileManifest.dependencies ??= {}
for (const row of manifest.packages) {
  if (Object.hasOwn(profileManifest.dependencies, row.name)) throw new Error(`target Profile already declares managed Product package: ${row.name}`)
  profileManifest.dependencies[row.name] = portableFileSpec(checkedArtifactPath(row.filename))
}
await writeFile(profileManifestPath, `${JSON.stringify(profileManifest, null, 2)}\n`)
await runDsh(['plugin', '--profile', profile, 'install', '--offline', '--no-frozen-lockfile'])
const dump = await runDsh(['--profile', profile, '--dump-config'])
if (!REQUIRED_PRODUCT_ROWS.every(name => dump.includes(name))) throw new Error('installed Product Profile is missing required rows')
process.stdout.write(`${JSON.stringify({ status: 'PASS', profile, dsh_home: dshHome, artifact_root: artifactRoot, packages: manifest.packages.length })}\n`)

function checkedArtifactPath(filename) {
  if (typeof filename !== 'string' || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') throw new Error('artifact filename escapes its directory')
  return join(artifactRoot, filename)
}

function parseArgs(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!['--dsh-root', '--dsh-home', '--profile'].includes(key) || value === undefined) throw new Error('usage: install.mjs --dsh-root <path> --dsh-home <path> --profile <xiaoshe-name>')
    result[key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value
  }
  if (!isAbsolute(result.dshRoot ?? '') || !isAbsolute(result.dshHome ?? '') || typeof result.profile !== 'string') throw new Error('dsh-root and dsh-home must be absolute and profile is required')
  return result
}

async function runDsh(args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: dshRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) }); child.stderr.on('data', chunk => { stderr += String(chunk) })
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
  if (code !== 0) throw new Error(`DSH CLI exited ${String(code)}\n${stderr.slice(-4_000)}\n${stdout.slice(-4_000)}`)
  return stdout
}

function yamlQuote(value) { return value.replaceAll("'", "''") }
function portableFileSpec(path) { return `file:${resolve(path).replaceAll('\\', '/')}` }
