import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const smoke = resolve(import.meta.dirname, 'smoke-installed-profile.mjs')

async function fixture(t, health, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-installed-profile-smoke-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dshRoot = join(root, 'dsh')
  const entry = join(dshRoot, 'apps', 'cli', 'lib', 'bin.js')
  const userDshHome = join(root, 'user-dsh-home')
  const profileRoot = join(userDshHome, 'profiles', 'web')
  const userSettingsPath = join(userDshHome, 'settings.yaml')
  const sourcePluginRoot = join(root, 'source-plugin')
  const sourcePluginEntry = join(sourcePluginRoot, 'index.js')
  const statePath = join(root, 'state.json')
  const requestsPath = join(root, 'requests.txt')
  await mkdir(dirname(entry), { recursive: true })
  await mkdir(join(profileRoot, 'node_modules', '@fixture'), { recursive: true })
  await mkdir(sourcePluginRoot, { recursive: true })
  await writeFile(join(profileRoot, 'package.json'), '{}\n')
  const pluginFiles = ['assets/**/*.txt']
  if (options.externalLink) pluginFiles.push('external-link')
  await writeFile(join(sourcePluginRoot, 'package.json'), JSON.stringify({
    name: '@fixture/plugin',
    version: '1.0.0',
    main: './index.js',
    bin: { 'fixture-command': './bin.js' },
    files: pluginFiles,
  }))
  await writeFile(sourcePluginEntry, 'original-installed-module\n')
  await writeFile(join(sourcePluginRoot, 'bin.js'), '#!/usr/bin/env node\n')
  await chmod(join(sourcePluginRoot, 'bin.js'), 0o755)
  await mkdir(join(sourcePluginRoot, 'assets', 'nested'), { recursive: true })
  await writeFile(join(sourcePluginRoot, 'assets', 'nested', 'marker.txt'), 'glob-payload\n')
  if (options.externalLink) {
    const externalTarget = join(root, 'private-outside-package')
    await mkdir(externalTarget, { recursive: true })
    await writeFile(join(externalTarget, 'secret.txt'), 'must-not-enter-profile\n')
    await symlink(
      externalTarget,
      join(sourcePluginRoot, 'external-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  }
  await symlink(
    sourcePluginRoot,
    join(profileRoot, 'node_modules', '@fixture', 'plugin'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await writeFile(userSettingsPath, 'original-user-settings\n')
  if (options.fallback) {
    const fallback = join(profileRoot, '.dsh-module-fallback')
    await mkdir(fallback)
    await writeFile(join(fallback, 'package.json'), '{"generated":true}')
    await symlink(sourcePluginRoot, join(fallback, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  await writeFile(entry, `
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const arguments_ = process.argv.slice(2)
const port = Number(arguments_[arguments_.indexOf('--port') + 1])
fs.writeFileSync(path.join(process.env.DSH_HOME, 'settings.yaml'), 'smoke-mutated-settings\\n')
const isolatedPluginEntry = path.join(
  process.env.DSH_HOME,
  'profiles',
  'web',
  'node_modules',
  '@fixture',
  'plugin',
  'index.js',
)
if (fs.readFileSync(isolatedPluginEntry, 'utf8') !== 'original-installed-module\\n') {
  throw new Error('materialized package main entry is missing')
}
const isolatedPluginRoot = path.dirname(isolatedPluginEntry)
const globPayload = fs.readFileSync(path.join(isolatedPluginRoot, 'assets', 'nested', 'marker.txt'), 'utf8')
const binMode = fs.statSync(path.join(isolatedPluginRoot, 'bin.js')).mode & 0o777
fs.writeFileSync(isolatedPluginEntry, 'smoke-mutated-module\\n')
fs.writeFileSync(process.env.XIAOSHE_SMOKE_TEST_STATE, JSON.stringify({
  pid: process.pid,
  arguments_,
  dshHome: process.env.DSH_HOME,
  isolatedPluginEntry,
  globPayload,
  binMode,
  fallbackPresent: fs.existsSync(path.join(process.env.DSH_HOME, 'profiles', 'web', '.dsh-module-fallback')),
}))
const server = http.createServer((request, response) => {
  fs.appendFileSync(process.env.XIAOSHE_SMOKE_TEST_REQUESTS, request.url + '\\n')
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(${JSON.stringify(health)}))
})
server.listen(port, '127.0.0.1')
setInterval(() => {}, 1000)
`)
  return {
    root,
    dshRoot,
    profileRoot,
    userDshHome,
    userSettingsPath,
    sourcePluginEntry,
    statePath,
    requestsPath,
  }
}

function runSmoke(value, timeoutMs) {
  return spawnSync(process.execPath, [
    smoke,
    '--dsh-root', value.dshRoot,
    '--profile-root', value.profileRoot,
    '--timeout-ms', String(timeoutMs),
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    env: {
      ...process.env,
      DSH_HOME: value.userDshHome,
      XIAOSHE_SMOKE_TEST_STATE: value.statePath,
      XIAOSHE_SMOKE_TEST_REQUESTS: value.requestsPath,
    },
  })
}

async function assertOwnedProcessExited(statePath) {
  const { pid, arguments_ } = JSON.parse(await readFile(statePath, 'utf8'))
  assert.deepEqual(arguments_.slice(0, 5), ['web', '--no-open', '--host', '127.0.0.1', '--port'])
  assert.equal(arguments_.length, 6)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function assertUserProfileWasIsolated(value) {
  const { dshHome, isolatedPluginEntry, globPayload, binMode } = JSON.parse(await readFile(value.statePath, 'utf8'))
  assert.notEqual(resolve(dshHome), resolve(value.userDshHome))
  assert.equal(await readFile(value.userSettingsPath, 'utf8'), 'original-user-settings\n')
  assert.equal(
    await readFile(value.sourcePluginEntry, 'utf8'),
    'original-installed-module\n',
    'temporary plugin writes must not cross into the installed Profile dependency tree',
  )
  assert.equal(await exists(isolatedPluginEntry), false, 'materialized plugin copy must be removed with DSH_HOME')
  assert.equal(globPayload, 'glob-payload\n')
  if (process.platform !== 'win32') assert.notEqual(binMode & 0o111, 0, 'package bin must remain executable')
  assert.equal(await exists(dshHome), false, 'temporary DSH_HOME must be removed after the owned process exits')
}

test('installed Profile smoke reaches only product health and cleans its owned process', async t => {
  const value = await fixture(t, { product: '小蛇', bridge: { state: 'ready' } })
  const result = runSmoke(value, 2_000)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1))
  assert.equal(report.schema, 'xiaoshe-installed-profile-smoke/v1')
  assert.equal(report.status, 'ready')
  assert.match(await readFile(value.requestsPath, 'utf8'), /^\/xiaoshe\/desktop\/status\r?\n$/u)
  await assertOwnedProcessExited(value.statePath)
  await assertUserProfileWasIsolated(value)
})

test('installed Profile smoke excludes generated fallback links while retaining independent plugin payloads', async t => {
  const value = await fixture(t, { product: '小蛇', bridge: { state: 'ready' } }, { fallback: true })
  const result = runSmoke(value, 2_000)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(JSON.parse(await readFile(value.statePath, 'utf8')).fallbackPresent, false)
  await assertOwnedProcessExited(value.statePath)
  await assertUserProfileWasIsolated(value)
  assert.equal(await readFile(join(value.profileRoot, '.dsh-module-fallback/package.json'), 'utf8'), '{"generated":true}')
})

test('macOS Profile backup excludes complete generated module fallback as well as dependency trees', async () => {
  const source = await readFile(new URL('../setup/install-macos.sh', import.meta.url), 'utf8')
  assert.match(source, /\/usr\/bin\/rsync -a --exclude 'node_modules\/' --exclude '\.dsh-module-fallback\/'/u)
})

test('installed Profile smoke cleans its owned process after unhealthy status', async t => {
  const value = await fixture(t, { product: 'not-xiaoshe', bridge: { state: 'ready' } })
  const result = runSmoke(value, 300)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not ready before timeout/iu)
  assert.match(await readFile(value.requestsPath, 'utf8'), /\/xiaoshe\/desktop\/status/u)
  await assertOwnedProcessExited(value.statePath)
  await assertUserProfileWasIsolated(value)
})

test('installed Profile smoke cleans its temporary Profile when spawn fails', async t => {
  const value = await fixture(t, { product: '小蛇', bridge: { state: 'ready' } })
  const isolatedTemp = join(value.root, 'spawn-error-temp')
  await mkdir(isolatedTemp, { recursive: true })
  const arguments_ = [
    '--dsh-root', value.dshRoot,
    '--profile-root', value.profileRoot,
    '--timeout-ms', '300',
  ]
  const wrapper = [
    'Object.defineProperty(process, \"execPath\", { value: '
      + JSON.stringify(join(value.root, 'missing-node-executable')) + ' })',
    'process.argv = ' + JSON.stringify(['node', smoke, ...arguments_]),
    'await import(' + JSON.stringify(pathToFileURL(smoke).href) + ')',
  ].join(';')
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', wrapper], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    env: {
      ...process.env,
      TEMP: isolatedTemp,
      TMP: isolatedTemp,
      TMPDIR: isolatedTemp,
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ENOENT|spawn/iu)
  assert.deepEqual(
    (await readdir(isolatedTemp)).filter(name => name.startsWith('xiaoshe-installed-profile-runtime-')),
    [],
  )
})

test('installed Profile smoke rejects package payload links that escape the package root', async t => {
  const value = await fixture(
    t,
    { product: '小蛇', bridge: { state: 'ready' } },
    { externalLink: true },
  )
  const result = runSmoke(value, 2_000)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /dependency link escaped|outside package/iu)
  assert.equal(await exists(value.statePath), false, 'unsafe materialization must fail before process launch')
})
