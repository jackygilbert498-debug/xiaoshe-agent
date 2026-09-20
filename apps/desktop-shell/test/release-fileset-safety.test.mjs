import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'

import { sourceIsRequired } from '../scripts/verify-artifact.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireApp = createRequire(join(appRoot, 'package.json'))
const requireBuilder = createRequire(requireApp.resolve('electron-builder'))
const { copyFiles, FileMatcher, getFileMatchers, getMainFileMatchers, getNodeModuleFileMatcher } = requireBuilder('app-builder-lib/out/fileMatcher')
const { NodeModuleCopyHelper } = requireBuilder('app-builder-lib/out/util/NodeModuleCopyHelper')
const asar = requireBuilder('@electron/asar')

const sensitive = [
  '.env', '.env.production', 'release.pem', 'release.key',
  '.credentials/account.json', 'provider-token.json', 'client-secret.yaml',
  'credentials.local.json', 'secrets.local.txt', 'apiToken.json',
  'clientSecret.yml', 'serviceCredentials.json',
  '.npmrc', '.pnpmrc', '.yarnrc', '.yarnrc.yml', '.netrc', '.pypirc',
  'id_rsa', 'id_ed25519', 'service-account-prod.json',
  'token', 'secret',
]
const safeNames = ['.env.example', 'credentials.ts', 'token.ts', 'model_secrets.py', 'credentials/types.ts']
const testOnlyNames = [
  'test/fixture.mjs', 'tests/scenario.ts', '__tests__/unit.js',
  'feature.test.mjs', 'feature.spec.ts', 'feature_test.py', 'test_feature.py',
]
const requiredAcceptanceScripts = [
  'acceptance/macos-desktop-actions.py',
  'acceptance/windows-desktop.ps1',
  'acceptance/harness-performance-complex-smoke.mjs',
  'acceptance/local-acceptance-base.mjs',
]

test('every directory fileset excludes local credentials through electron-builder actual matcher', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-release-fileset-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configuration = parse(await readFile(join(appRoot, 'electron-builder.yml'), 'utf8'))
  const directories = new Set(['runtime', 'packages', 'scripts', 'setup', 'python', 'src'])
  const entries = configuration.extraResources.filter(entry => directories.has(String(entry.from).replace(/^\.\.\/\.\.\//u, '')))
  assert.equal(entries.length, directories.size)

  for (const entry of entries) {
    const name = String(entry.from).replace(/^\.\.\/\.\.\//u, '')
    const source = join(root, 'source', name)
    const destination = join(root, 'destination', name)
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'safe-source.ts'), 'export const safe = true\n')
    for (const relativePath of safeNames) {
      await mkdir(dirname(join(source, relativePath)), { recursive: true })
      await writeFile(join(source, relativePath), `safe-${relativePath}`)
    }
    for (const relativePath of testOnlyNames) {
      await mkdir(dirname(join(source, relativePath)), { recursive: true })
      await writeFile(join(source, relativePath), `test-only-${relativePath}`)
    }
    if (name === 'scripts') {
      for (const relativePath of requiredAcceptanceScripts) {
        await mkdir(dirname(join(source, relativePath)), { recursive: true })
        await writeFile(join(source, relativePath), `required-${relativePath}`)
      }
    }
    for (const relativePath of sensitive) {
      const target = join(source, relativePath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, `never-publish-${name}-${relativePath}`)
    }
    if (name === 'packages') {
      for (const relativePath of ['feature/.git/config', 'feature/.venv/pyvenv.cfg']) {
        const target = join(source, relativePath)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, `never-publish-${name}-${relativePath}`)
      }
    }
    await copyFiles([new FileMatcher(source, destination, value => value, entry.filter)])
    assert.equal(await readFile(join(destination, 'safe-source.ts'), 'utf8'), 'export const safe = true\n')
    for (const relativePath of safeNames) assert.equal(await readFile(join(destination, relativePath), 'utf8'), `safe-${relativePath}`)
    for (const relativePath of testOnlyNames) {
      await assert.rejects(readFile(join(destination, relativePath)), { code: 'ENOENT' }, `${name}/${relativePath}`)
    }
    if (name === 'scripts') {
      for (const relativePath of requiredAcceptanceScripts) {
        assert.equal(await readFile(join(destination, relativePath), 'utf8'), `required-${relativePath}`)
      }
    }
    for (const relativePath of sensitive) {
      await assert.rejects(readFile(join(destination, relativePath)), { code: 'ENOENT' }, `${name}/${relativePath}`)
    }
    if (name === 'packages') {
      for (const relativePath of ['feature/.git/config', 'feature/.venv/pyvenv.cfg']) {
        await assert.rejects(readFile(join(destination, relativePath)), { code: 'ENOENT' }, `${name}/${relativePath}`)
      }
    }
  }
})

test('release identity uses the same test-only boundary while retaining operational acceptance scripts', () => {
  for (const directory of ['runtime', 'packages', 'scripts', 'setup', 'python', 'src']) {
    for (const relativePath of testOnlyNames) assert.equal(sourceIsRequired(`${directory}/${relativePath}`), false)
  }
  for (const relativePath of requiredAcceptanceScripts) assert.equal(sourceIsRequired(`scripts/${relativePath}`), true)
})

test('actual builder root-relative selection retains both helper copies across platform path rules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-shared-helper-fileset-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configuration = parse(await readFile(join(appRoot, 'electron-builder.yml'), 'utf8'))
  const shared = configuration.extraResources.filter(entry => entry.to === 'product')
  const helper = 'apps/desktop-shell/src/acceptance-isolation.mjs'
  assert.deepEqual(shared, [{ from: '../..', to: 'product', filter: [helper] }])
  const repository = join(root, 'source'), source = join(repository, 'apps/desktop-shell')
  await mkdir(join(source, 'src'), { recursive: true })
  const bytes = await readFile(join(appRoot, 'src/acceptance-isolation.mjs'))
  await writeFile(join(source, 'src/acceptance-isolation.mjs'), bytes)
  await writeFile(join(source, 'src/main.mjs'), 'export const fixture = true\n')
  await writeFile(join(source, 'package.json'), '{"name":"fixture"}\n')
  await writeFile(join(repository, 'must-not-copy.txt'), 'not the selected helper\n')
  // Match platformPackager's actual composition: extraResources are also
  // parsed as exclusions on every main matcher. The old isolated copy test
  // omitted that composition and could not detect a missing app.asar import.
  async function copyWith(mapping, name) {
    const destination = join(root, name), desktop = join(destination, 'desktop'), resources = join(destination, 'resources')
    const config = { ...configuration, extraResources: [mapping] }, outDir = join(root, 'out')
    const extra = getFileMatchers(config, 'extraResources', resources, {
      defaultSrc: source, globalOutDir: outDir, customBuildOptions: {}, macroExpander: value => value,
    })
    const excludes = []
    for (const matcher of extra) matcher.computeParsedPatterns(excludes, source)
    const info = { projectDir: source, buildResourcesDir: 'build', config, debugLogger: { isEnabled: false } }
    const main = getMainFileMatchers(source, desktop, value => value, {}, { info }, outDir, false)
    for (const matcher of main) matcher.excludePatterns = excludes
    await copyFiles(main); await copyFiles(extra)
    return { desktop, resources, excludes }
  }
  const old = await copyWith({ from: 'src/acceptance-isolation.mjs', to: `product/${helper}` }, 'old-direct')
  // electron-builder 26.15.3 gives this direct-file exclusion to minimatch as
  // a native path, while its copy filter normalizes file names to '/'. Windows
  // backslashes become escapes, so the old POSIX missing-file regression does
  // not reproduce there. Characterize that difference without skipping the
  // actual current-config copy, exclusion, archive and import assertions below.
  assert.equal(old.excludes[0].pattern, process.platform === 'win32'
    ? 'src\\acceptance-isolation.mjs' : 'src/acceptance-isolation.mjs')
  assert.equal(old.excludes[0].match('src/acceptance-isolation.mjs'), process.platform !== 'win32')
  if (process.platform === 'win32') assert.deepEqual(await readFile(join(old.desktop, 'src/acceptance-isolation.mjs')), bytes)
  else await assert.rejects(readFile(join(old.desktop, 'src/acceptance-isolation.mjs')), { code: 'ENOENT' })
  assert.deepEqual(await readFile(join(old.resources, 'product', helper)), bytes)
  const { desktop, resources } = await copyWith(shared[0], 'root-relative')
  assert.deepEqual(await readFile(join(desktop, 'src/acceptance-isolation.mjs')), bytes)
  assert.deepEqual(await readFile(join(resources, 'product', helper)), bytes)
  await assert.rejects(readFile(join(resources, 'product/apps/desktop-shell/src/main.mjs')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(resources, 'product/must-not-copy.txt')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(resources, 'product/apps/desktop-shell/package.json')), { code: 'ENOENT' })
  // This is only a synthetic archive, not an Electron package or app launch.
  const archive = join(root, 'synthetic.asar')
  await asar.createPackage(desktop, archive)
  assert.deepEqual(asar.extractFile(archive, 'src/acceptance-isolation.mjs'), bytes)
  assert.deepEqual(asar.listPackage(archive).map(path => path.replaceAll('\\', '/')).sort(), ['/package.json', '/src', '/src/acceptance-isolation.mjs', '/src/main.mjs'])
  const imported = await import(pathToFileURL(join(resources, 'product', helper)).href)
  assert.equal(imported.acceptanceServiceEnvironment({}), undefined, 'copied launch helper resolves without app.asar or Electron')
  assert.throws(() => imported.acceptanceServiceEnvironment({ XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1' }), /both acceptance gates/u)
})

test('actual builder dependency walker excludes otherwise auto-collected workspace modules from the shell', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-shell-dependency-fileset-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configuration = parse(await readFile(join(appRoot, 'electron-builder.yml'), 'utf8'))
  assert(configuration.files.includes('!node_modules/**'))
  const source = join(root, 'app'), moduleRoot = join(root, 'collected-module'), destination = join(root, 'desktop')
  await mkdir(source, { recursive: true }); await mkdir(join(moduleRoot, 'dist'), { recursive: true })
  await writeFile(join(moduleRoot, 'package.json'), '{"name":"synthetic-workspace-dependency","version":"1.0.0"}\n')
  await writeFile(join(moduleRoot, 'dist/index.js'), 'export const shouldNotShipInShell = true\n')
  async function collected(files) {
    const config = { ...configuration, files }, info = { config, appInfo: { type: 'module' }, debugLogger: { isEnabled: false }, getWorkspaceRoot: async () => root }
    const matcher = getNodeModuleFileMatcher(source, destination, value => value, {}, info)
    // computeNodeModuleFileSets creates one matcher per discovered dependency;
    // exercise that real walker, including its moduleFullFilePath annotations.
    const copier = new NodeModuleCopyHelper(new FileMatcher(moduleRoot, join(destination, 'node_modules/synthetic-workspace-dependency'), value => value, matcher.patterns), info)
    return copier.collectNodeModules({ dir: moduleRoot, name: 'synthetic-workspace-dependency' }, [], 'node_modules/synthetic-workspace-dependency')
  }
  const old = await collected(configuration.files.filter(pattern => pattern !== '!node_modules/**'))
  assert.deepEqual(old.sort(), [join(moduleRoot, 'dist/index.js'), join(moduleRoot, 'package.json')].sort())
  assert.deepEqual(await collected(configuration.files), [])
})

test('desktop app fileset excludes local credentials from app.asar inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-desktop-fileset-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configuration = parse(await readFile(join(appRoot, 'electron-builder.yml'), 'utf8'))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await mkdir(join(source, 'src'), { recursive: true })
  await writeFile(join(source, 'package.json'), '{"name":"desktop-fixture"}\n')
  await writeFile(join(source, 'src', 'main.mjs'), 'export const safe = true\n')
  for (const relativePath of safeNames) {
    await mkdir(dirname(join(source, 'src', relativePath)), { recursive: true })
    await writeFile(join(source, 'src', relativePath), `safe-${relativePath}`)
  }
  for (const relativePath of sensitive) {
    const target = join(source, 'src', relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `never-publish-desktop-${relativePath}`)
  }

  await copyFiles([new FileMatcher(source, destination, value => value, configuration.files)])
  assert.equal(await readFile(join(destination, 'src', 'main.mjs'), 'utf8'), 'export const safe = true\n')
  assert.equal(await readFile(join(destination, 'package.json'), 'utf8'), '{"name":"desktop-fixture"}\n')
  for (const relativePath of safeNames) assert.equal(await readFile(join(destination, 'src', relativePath), 'utf8'), `safe-${relativePath}`)
  for (const relativePath of sensitive) {
    await assert.rejects(readFile(join(destination, 'src', relativePath)), { code: 'ENOENT' }, `desktop/src/${relativePath}`)
  }
})
