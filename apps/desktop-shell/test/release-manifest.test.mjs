import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import {
  assertReleaseInputsSafe,
  collectRequiredSourceSnapshot,
  collectReleaseSourceInputs,
  sourceIsRequired,
  collectStableArtifactInventory,
  createReleaseManifest,
  createWindowsSigningEvidence,
  assertWindowsSigningEvidence,
  inspectAuthenticode,
  verifyPackagedApplicationSourceIdentity,
} from '../scripts/verify-artifact.mjs'

const run = promisify(execFile)
const requireApp = createRequire(new URL('../package.json', import.meta.url))
const requireBuilder = createRequire(requireApp.resolve('electron-builder'))
const asar = createRequire(requireBuilder.resolve('app-builder-lib'))('@electron/asar')

function signingManifestFixture() {
  return { schema: 'xiaoshe-desktop-release/v1', platform: 'win32',
    git: { commit: 'a'.repeat(40), requiredSources: { state: 'clean', dirty: [], sha256: 'b'.repeat(64) } },
    artifacts: Object.fromEntries(['executable', 'installer'].map((role, index) => [role, { sha256: String(index + 1).repeat(64),
      signing: { kind: 'authenticode', state: 'valid', nativeStatus: 'Valid', signerCertificateSha256: 'c'.repeat(64) } }])) }
}

test('Windows signing evidence binds separately inspected EXE and installer bytes and signer across reinspection', () => {
  const original = signingManifestFixture(), rechecked = structuredClone(original)
  const evidence = createWindowsSigningEvidence(original, rechecked)
  assert.equal(evidence.original.executable.sha256, '1'.repeat(64))
  assert.equal(evidence.original.installer.sha256, '2'.repeat(64))
  assert.deepEqual(evidence.original, evidence.rechecked)
  assert.equal(assertWindowsSigningEvidence(evidence, { sourceCommit: original.git.commit, sourceSha256: original.git.requiredSources.sha256,
    executableSha256: '1'.repeat(64), installerSha256: '2'.repeat(64) }), true)
  assert(!JSON.stringify(evidence).includes('thumbprint'))
})

test('unsigned/missing installer, non-native claims, changed signer or artifact cannot borrow an EXE signature', () => {
  for (const change of [
    (a, b) => { b.artifacts.installer.signing.state = 'unsigned'; b.artifacts.installer.signing.nativeStatus = 'NotSigned' },
    (a, b) => { delete b.artifacts.installer.signing },
    (a, b) => { delete a.artifacts.installer },
    (a, b) => { b.artifacts.executable.signing.nativeStatus = 'HashMismatch' },
    (a, b) => { b.artifacts.installer.signing.nativeStatus = 'UnknownError' },
    (a, b) => { b.platform = 'darwin' },
    (a, b) => { b.artifacts.installer.sha256 = '9'.repeat(64) },
    (a, b) => { b.artifacts.executable.sha256 = '9'.repeat(64) },
    (a, b) => { b.artifacts.installer.signing.signerCertificateSha256 = 'd'.repeat(64) },
    (a, b) => { a.artifacts.installer.signing.signerCertificateSha256 = b.artifacts.installer.signing.signerCertificateSha256 = 'd'.repeat(64) },
    (a, b) => { delete a.artifacts.executable.signing.signerCertificateSha256 },
    (a, b) => { b.git.requiredSources.sha256 = 'e'.repeat(64) },
    (a, b) => { b.git.requiredSources.dirty = ['changed'] },
  ]) {
    const a = signingManifestFixture(), b = structuredClone(a); change(a, b)
    assert.throws(() => createWindowsSigningEvidence(a, b), /Windows signing/u)
  }
})

test('PowerShell signing consumer really evaluates retained original/rechecked manifests, including UTF-8 BOM', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-signing-consumer-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const script = await readFile(new URL('../../../scripts/acceptance/windows-desktop.ps1', import.meta.url), 'utf8')
  const encoded = script.match(/^\s*\$SigningProbe = '([^\r\n]+)'\s*$/mu)?.[1]
  assert(encoded); assert(!encoded.includes('"'), 'do not rely on embedded double quotes crossing PowerShell 5.1')
  const code = encoded.replaceAll("''", "'"), original = signingManifestFixture()
  const before = join(directory, '原始 manifest.json'), after = join(directory, '复核 manifest.json')
  await writeFile(before, '\uFEFF' + JSON.stringify(original)); await writeFile(after, JSON.stringify(original))
  const verifier = fileURLToPath(new URL('../scripts/verify-artifact.mjs', import.meta.url))
  const result = await run(process.execPath, ['--input-type=module', '-e', code, verifier, before, after])
  assert.deepEqual(JSON.parse(result.stdout), createWindowsSigningEvidence(original, original))
  const changed = structuredClone(original); changed.artifacts.installer.signing.state = 'unsigned'
  await writeFile(after, JSON.stringify(changed))
  await assert.rejects(run(process.execPath, ['--input-type=module', '-e', code, verifier, before, after]), /Windows signing/u)
  // This runs the actual Node payload, not Windows PowerShell or Authenticode.
})

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'xiaoshe-release-manifest-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const repositoryRoot = join(temporary, 'source')
  const packageDir = join(temporary, 'package', 'win-unpacked')
  const product = join(packageDir, 'resources', 'product')
  const desktopApp = join(temporary, 'desktop-app')
  const rootFiles = [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.build.json',
    'README.md', 'cordis.patch.yml', '启动小蛇.ps1', '停止小蛇.ps1', '诊断小蛇-Windows.ps1',
  ]
  const sourceFiles = {
    'src/index.ts': 'export const product = "xiaoshe"\n',
    'src/credentials.ts': 'export type Credentials = Readonly<Record<string, string>>\n',
    'src/token.ts': 'export type Token = string\n',
    'python/model_secrets.py': 'MODEL_SECRETS_SUPPORTED = False\n',
    'scripts/start.mjs': 'export const start = true\n',
    'setup/install.ps1': 'Write-Output ready\n',
    'python/bridge.py': 'READY = True\n',
    'runtime/DSH/package.json': '{"name":"dsh","version":"1.0.0"}\n',
    'runtime/DSH/lib/index.js': 'export const dsh = true\n',
    'runtime/DSH/packages/credentials/credentials/src/types.ts': 'export interface Credentials {}\n',
    'packages/product-bundle/package.json': '{"name":"bundle","version":"1.0.0"}\n',
    'packages/product-bundle/cordis.patch.yml': 'plugins: []\n',
    'apps/desktop-shell/src/main.mjs': 'export const desktop = true\n',
    'apps/desktop-shell/src/acceptance-isolation.mjs': 'export const isolated = true\n',
    'apps/desktop-shell/src/payload.txt': 'x'.repeat(2_048),
    'apps/desktop-shell/package.json': '{"name":"desktop","version":"0.2.0"}\n',
    'apps/desktop-shell/electron-builder.yml': 'publish: null\n',
    'apps/desktop-shell/scripts/verify-artifact.mjs': 'export const verifier = true\n',
    'apps/desktop-shell/scripts/before-pack.mjs': 'export default async function beforePack() {}\n',
  }
  for (const name of rootFiles) sourceFiles[name] = name.endsWith('.json') ? '{}\n' : `${name}\n`
  for (const [relative, content] of Object.entries(sourceFiles)) {
    const path = join(repositoryRoot, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  await run('git', ['init', '--quiet'], { cwd: repositoryRoot })
  await run('git', ['config', 'user.email', 'release@example.invalid'], { cwd: repositoryRoot })
  await run('git', ['config', 'user.name', 'Release Test'], { cwd: repositoryRoot })
  await run('git', ['add', '.'], { cwd: repositoryRoot })
  await run('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repositoryRoot })

  for (const directory of ['runtime', 'packages', 'scripts', 'setup', 'python', 'src']) {
    await cp(join(repositoryRoot, directory), join(product, directory), { recursive: true })
  }
  for (const name of rootFiles) await cp(join(repositoryRoot, name), join(product, name))
  await mkdir(join(product, 'apps/desktop-shell/src'), { recursive: true })
  await cp(join(repositoryRoot, 'apps/desktop-shell/src/acceptance-isolation.mjs'), join(product, 'apps/desktop-shell/src/acceptance-isolation.mjs'))
  await mkdir(join(desktopApp, 'src'), { recursive: true })
  await cp(join(repositoryRoot, 'apps', 'desktop-shell', 'src'), join(desktopApp, 'src'), { recursive: true })
  await cp(join(repositoryRoot, 'apps', 'desktop-shell', 'package.json'), join(desktopApp, 'package.json'))
  await mkdir(join(packageDir, 'resources'), { recursive: true })
  await asar.createPackage(desktopApp, join(packageDir, 'resources', 'app.asar'))
  const executablePath = join(packageDir, '小蛇.exe')
  const installerPath = join(temporary, 'package', 'Xiaoshe-0.2.0-x64-setup.exe')
  await writeFile(executablePath, Buffer.alloc(2_048, 0x31))
  await writeFile(installerPath, Buffer.alloc(4_096, 0x32))
  return { repositoryRoot, packageDir, executablePath, installerPath, desktopApp }
}

test('source input metadata uses the sole release traversal without changing projected digest shapes', async t => {
  const paths = await fixture(t)
  const listing = await collectReleaseSourceInputs(paths.repositoryRoot)
  assert.equal(listing.projectedEntries, undefined, 'metadata listing does not open input contents')
  const withHashes = await collectReleaseSourceInputs(paths.repositoryRoot, { includeDigests: true })
  const snapshot = await collectRequiredSourceSnapshot(paths.repositoryRoot)
  assert.deepEqual(listing.inputs, withHashes.inputs)
  assert.equal(new Set(listing.inputs.map(input => input.path)).size, listing.inputs.length)
  assert.equal(listing.inputs.length + 1, snapshot.files, 'one raw helper has two shipped projections')
  const projections = listing.inputs.flatMap(input => [
    { projectedPath: input.projectedPath, projection: input.projection }, ...(input.additionalProjections ?? []),
  ])
  assert.equal(projections.length, snapshot.files)
  assert.equal(new Set(projections.map(input => input.projectedPath)).size, projections.length)
  assert.equal(createHash('sha256').update(JSON.stringify(withHashes.projectedEntries.map(entry => [entry.path, entry.bytes, entry.sha256]))).digest('hex'), snapshot.sha256)
  assert(withHashes.projectedEntries.every(entry => Object.keys(entry).join(',') === 'path,bytes,sha256'))
  assert.deepEqual(listing.inputs.find(input => input.path === 'apps/desktop-shell/package.json'), {
    path: 'apps/desktop-shell/package.json', projectedPath: 'desktop/package.json', projection: 'desktop-package',
  })
  assert.deepEqual(listing.inputs.find(input => input.path === 'scripts/start.mjs'), {
    path: 'scripts/start.mjs', projectedPath: 'product/scripts/start.mjs', projection: 'identity',
  })
  assert.deepEqual(listing.inputs.find(input => input.path === 'apps/desktop-shell/src/acceptance-isolation.mjs'), {
    path: 'apps/desktop-shell/src/acceptance-isolation.mjs', projectedPath: 'desktop/src/acceptance-isolation.mjs', projection: 'identity',
    additionalProjections: [{ projectedPath: 'product/apps/desktop-shell/src/acceptance-isolation.mjs', projection: 'identity' }],
  })
  const copies = withHashes.projectedEntries.filter(entry => entry.path.endsWith('/src/acceptance-isolation.mjs'))
  assert.equal(copies.length, 2)
  assert.equal(copies[0].bytes, copies[1].bytes); assert.equal(copies[0].sha256, copies[1].sha256)
})

test('shared helper is mandatory and unsafe projected source paths are rejected', async t => {
  await t.test('missing source', async child => {
    const paths = await fixture(child)
    await rm(join(paths.repositoryRoot, 'apps/desktop-shell/src/acceptance-isolation.mjs'))
    await assert.rejects(collectReleaseSourceInputs(paths.repositoryRoot), /required release input is missing.*acceptance-isolation/u)
  })
  if (process.platform !== 'win32') for (const [name, file] of [['backslash', 'unsafe\\module.mjs'], ['control character', 'unsafe\nmodule.mjs']]) {
    await t.test(`${name} cannot become a second portable projection`, async child => {
      const paths = await fixture(child)
      await writeFile(join(paths.repositoryRoot, 'apps/desktop-shell/src', file), 'unsafe path')
      await assert.rejects(collectReleaseSourceInputs(paths.repositoryRoot), /unsafe release projection path/u)
    })
  }
})

test('only incidental Finder/Python caches are excluded by both actual source and builder lists', async t => {
  const paths = await fixture(t), before = await collectRequiredSourceSnapshot(paths.repositoryRoot)
  const caches = ['runtime/DSH/.DS_Store', 'runtime/DSH/__pycache__/cache.pyc', 'scripts/__pycache__/cache.pyc',
    'apps/desktop-shell/src/.DS_Store', 'apps/desktop-shell/src/__pycache__/cache.pyc']
  for (const path of caches) {
    await mkdir(dirname(join(paths.repositoryRoot, path)), { recursive: true }); await writeFile(join(paths.repositoryRoot, path), 'incidental cache')
    assert.equal(sourceIsRequired(path), false)
  }
  const after = await collectRequiredSourceSnapshot(paths.repositoryRoot)
  assert.equal(before.sha256, after.sha256); assert.equal(before.files, after.files); assert.deepEqual(after.dirty, [])
  const inputs = await collectReleaseSourceInputs(paths.repositoryRoot)
  assert(inputs.inputs.every(input => !caches.includes(input.path)))
  for (const path of ['runtime/DSH/packages/example/example/lib/index.js', 'runtime/DSH/tsconfig.host.tsbuildinfo',
    'runtime/DSH/.dsh-build/client-build-environment.json', 'apps/desktop-shell/src/中文 名称.txt']) assert.equal(sourceIsRequired(path), true)
  const config = requireBuilder('yaml').parse(await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  const minimatch = requireBuilder('minimatch').minimatch
  for (const patterns of [config.files, config.extraResources.find(resource => resource.to === 'product/runtime').filter]) {
    assert(patterns.includes('!**/.DS_Store')); assert(patterns.includes('!**/__pycache__/**'))
    const exclusions = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
    for (const path of ['src/.DS_Store', 'src/__pycache__/cache.pyc']) assert(exclusions.some(pattern => minimatch(path, pattern, { dot: true })))
    for (const path of ['src/中文 名称.txt', 'lib/index.js']) assert(!exclusions.some(pattern => minimatch(path, pattern, { dot: true })))
  }
})

test('unexpected caches in an actual packaged product or app.asar remain observable and fail identity', async t => {
  await t.test('product', async child => {
    const paths = await fixture(child)
    await writeFile(join(paths.packageDir, 'resources/product/runtime/DSH/.DS_Store'), 'unwanted package bytes')
    await assert.rejects(createReleaseManifest(paths), /identity mismatch/)
  })
  await t.test('desktop', async child => {
    const paths = await fixture(child)
    await mkdir(join(paths.desktopApp, 'src/__pycache__'))
    await writeFile(join(paths.desktopApp, 'src/__pycache__/cache.pyc'), 'unwanted package bytes')
    const archive = join(paths.packageDir, 'resources/app.asar')
    await rm(archive); await asar.createPackage(paths.desktopApp, archive)
    await assert.rejects(createReleaseManifest(paths), /identity mismatch/)
  })
})

test('release manifest binds clean git inputs, runtime identities, artifacts, real signing and disabled updates', async t => {
  const paths = await fixture(t)
  const source = await collectRequiredSourceSnapshot(paths.repositoryRoot)
  const signatureInspector = async path => ({ kind: 'authenticode', state: 'valid', nativeStatus: 'Valid', subject: `CN=${path.endsWith('.exe') ? 'Xiaoshe' : 'Unknown'}` })
  const manifest = await createReleaseManifest({ ...paths, expectedSourceSha256: source.sha256, signatureInspector })

  assert.equal(manifest.schema, 'xiaoshe-desktop-release/v1')
  assert.match(manifest.git.commit, /^[a-f0-9]{40}$/u)
  assert.deepEqual(manifest.git.requiredSources.dirty, [])
  assert.equal(manifest.git.requiredSources.sha256, source.sha256)
  assert.equal(manifest.identities.runtime.matchesPackaged, true)
  assert.equal(manifest.identities.desktop.matchesPackaged, true)
  for (const key of ['lock', 'profile', 'bundle', 'dsh', 'runtime']) assert.match(manifest.identities[key].sha256, /^[a-f0-9]{64}$/u, key)
  for (const key of ['appAsar', 'executable', 'installer']) {
    assert.match(manifest.artifacts[key].sha256, /^[a-f0-9]{64}$/u, key)
    assert.ok(manifest.artifacts[key].bytes >= 1_024, key)
  }
  assert.equal(manifest.artifacts.appAsar.path, 'win-unpacked/resources/app.asar')
  assert.equal(manifest.artifacts.executable.path, 'win-unpacked/小蛇.exe')
  assert.equal(manifest.artifacts.installer.path, 'Xiaoshe-0.2.0-x64-setup.exe')
  assert.equal(manifest.artifacts.executable.signing.nativeStatus, 'Valid')
  assert.equal(manifest.artifacts.installer.signing.state, 'valid')
  assert.deepEqual(manifest.update, { enabled: false, publish: null })
})

test('release manifest fails closed for dirty and untracked required sources', async t => {
  const paths = await fixture(t)
  await writeFile(join(paths.repositoryRoot, 'scripts', 'start.mjs'), 'dirty\n')
  await assert.rejects(createReleaseManifest({ ...paths }), /required release sources are dirty.*scripts\/start\.mjs/iu)

  await run('git', ['checkout', '--', 'scripts/start.mjs'], { cwd: paths.repositoryRoot })
  await writeFile(join(paths.repositoryRoot, 'runtime', 'DSH', 'untracked.js'), 'untracked\n')
  await assert.rejects(createReleaseManifest({ ...paths }), /required release sources are dirty.*runtime\/DSH\/untracked\.js/iu)
})

test('release manifest treats its pre-pack security hook as a required source', async t => {
  const paths = await fixture(t)
  await writeFile(join(paths.repositoryRoot, 'apps', 'desktop-shell', 'scripts', 'before-pack.mjs'), 'disabled\n')
  await assert.rejects(createReleaseManifest({ ...paths }), /required release sources are dirty.*apps\/desktop-shell\/scripts\/before-pack\.mjs/iu)
})

test('pre-pack release scan rejects a shipped top-level directory junction', {
  skip: process.platform !== 'win32',
}, async t => {
  const paths = await fixture(t)
  const runtime = join(paths.repositoryRoot, 'runtime')
  const outside = join(dirname(paths.repositoryRoot), 'outside-runtime')
  await rename(runtime, outside)
  await symlink(outside, runtime, 'junction')

  await assert.rejects(assertReleaseInputsSafe(paths.repositoryRoot), /unsafe release input|outside.*repository|link/iu)
})

test('release manifest rejects an expected source identity mismatch', async t => {
  const paths = await fixture(t)
  await assert.rejects(createReleaseManifest({ ...paths, expectedSourceSha256: '0'.repeat(64) }), /expected source SHA-256 mismatch/iu)
})

test('release manifest rejects packaged runtime bytes that do not match the clean source', async t => {
  const paths = await fixture(t)
  await writeFile(join(paths.packageDir, 'resources', 'product', 'scripts', 'start.mjs'), 'stale package\n')
  await assert.rejects(createReleaseManifest({ ...paths }), /runtime identity mismatch/iu)
})

test('packaged application identity binds clean source to product, app.asar, and executable bytes', async t => {
  const paths = await fixture(t)
  const source = await collectRequiredSourceSnapshot(paths.repositoryRoot)
  const identity = await verifyPackagedApplicationSourceIdentity({
    repositoryRoot: paths.repositoryRoot,
    resourcesDir: join(paths.packageDir, 'resources'),
    executablePath: paths.executablePath,
    expectedSource: source,
  })

  assert.equal(identity.schema, 'xiaoshe-packaged-application-source/v1')
  assert.equal(identity.source.sha256, source.sha256)
  assert.equal(identity.source.state, 'clean')
  assert.equal(identity.identities.runtime.matchesPackaged, true)
  assert.equal(identity.identities.desktop.matchesPackaged, true)
  assert.match(identity.artifacts.appAsar.sha256, /^[a-f0-9]{64}$/u)
  assert.match(identity.artifacts.executable.sha256, /^[a-f0-9]{64}$/u)
  assert.match(identity.artifacts.applicationBundle.sha256, /^[a-f0-9]{64}$/u)

  const framework = join(paths.packageDir, 'Frameworks', 'fixture-framework')
  await mkdir(dirname(framework), { recursive: true })
  await writeFile(framework, 'changed framework bytes')
  const changed = await verifyPackagedApplicationSourceIdentity({
    repositoryRoot: paths.repositoryRoot,
    resourcesDir: join(paths.packageDir, 'resources'),
    executablePath: paths.executablePath,
    expectedSource: source,
  })
  assert.notEqual(changed.artifacts.applicationBundle.sha256, identity.artifacts.applicationBundle.sha256)
})

test('shared helper must match in both actual ASAR inventory and embedded product inventory', async t => {
  for (const target of ['product', 'desktop']) for (const change of ['missing', 'changed']) {
    await t.test(`${target} ${change}`, async child => {
      const paths = await fixture(child), source = await collectRequiredSourceSnapshot(paths.repositoryRoot)
      const helper = target === 'product'
        ? join(paths.packageDir, 'resources/product/apps/desktop-shell/src/acceptance-isolation.mjs')
        : join(paths.desktopApp, 'src/acceptance-isolation.mjs')
      if (change === 'missing') await rm(helper)
      else await writeFile(helper, 'export const isolated = false\n')
      if (target === 'desktop') {
        const archive = join(paths.packageDir, 'resources/app.asar')
        await rm(archive); await asar.createPackage(paths.desktopApp, archive)
      }
      await assert.rejects(verifyPackagedApplicationSourceIdentity({
        repositoryRoot: paths.repositoryRoot, resourcesDir: join(paths.packageDir, 'resources'),
        executablePath: paths.executablePath, expectedSource: source,
      }), target === 'product' ? /runtime identity mismatch/u : /desktop identity mismatch/u)
    })
  }
  // Synthetic archive/filesystem evidence only, never signed installation or
  // a successful real application launch on either operating system.
})

test('packaged application identity rejects stale product bytes and a mismatched captured source', async t => {
  const paths = await fixture(t)
  const source = await collectRequiredSourceSnapshot(paths.repositoryRoot)
  await writeFile(join(paths.packageDir, 'resources', 'product', 'scripts', 'start.mjs'), 'stale package\n')
  await assert.rejects(verifyPackagedApplicationSourceIdentity({
    repositoryRoot: paths.repositoryRoot,
    resourcesDir: join(paths.packageDir, 'resources'),
    executablePath: paths.executablePath,
    expectedSource: source,
  }), /runtime identity mismatch/iu)

  await writeFile(join(paths.packageDir, 'resources', 'product', 'scripts', 'start.mjs'), 'export const start = true\n')
  await assert.rejects(verifyPackagedApplicationSourceIdentity({
    repositoryRoot: paths.repositoryRoot,
    resourcesDir: join(paths.packageDir, 'resources'),
    executablePath: paths.executablePath,
    expectedSource: { ...source, sha256: '0'.repeat(64) },
  }), /captured source identity mismatch/iu)
})

test('release manifest hashes are content backed', async t => {
  const paths = await fixture(t)
  const manifest = await createReleaseManifest({ ...paths, signatureInspector: async () => ({ kind: 'authenticode', state: 'unsigned', nativeStatus: 'NotSigned' }) })
  const installer = await readFile(paths.installerPath)
  installer[0] ^= 0xff
  await writeFile(paths.installerPath, installer)
  const changed = await createReleaseManifest({ ...paths, signatureInspector: async () => ({ kind: 'authenticode', state: 'unsigned', nativeStatus: 'NotSigned' }) })
  assert.notEqual(changed.artifacts.installer.sha256, manifest.artifacts.installer.sha256)
  assert.equal(changed.artifacts.installer.signing.state, 'unsigned')
})

test('release manifest rejects artifacts changed during signing inspection', async t => {
  const paths = await fixture(t)
  let changed = false
  const inspect = async () => {
    if (!changed) {
      changed = true
      await writeFile(paths.installerPath, Buffer.alloc(4_096, 0x71))
    }
    return { kind: 'authenticode', state: 'unsigned', nativeStatus: 'NotSigned' }
  }

  await assert.rejects(createReleaseManifest({ ...paths, signatureInspector: inspect }), /artifact.*changed|installer.*changed/iu)
})

test('release inventory rejects an app.asar replaced while its entries are inspected', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'xiaoshe-release-inventory-race-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const archivePath = join(temporary, 'app.asar')
  await writeFile(archivePath, Buffer.alloc(2_048, 1))

  await assert.rejects(
    collectStableArtifactInventory(archivePath, async () => {
      await writeFile(archivePath, Buffer.alloc(2_048, 2))
      return []
    }),
    /app\.asar artifact changed during inventory/iu,
  )
})

test('release manifest rejects an expected artifact SHA-256 mismatch', async t => {
  const paths = await fixture(t)
  const inspect = async () => ({ kind: 'authenticode', state: 'unsigned', nativeStatus: 'NotSigned' })
  const first = await createReleaseManifest({ ...paths, signatureInspector: inspect })
  await writeFile(paths.installerPath, Buffer.alloc(4_096, 0x51))
  await assert.rejects(createReleaseManifest({
    ...paths,
    signatureInspector: inspect,
    expectedArtifactSha256: {
      appAsar: first.artifacts.appAsar.sha256,
      executable: first.artifacts.executable.sha256,
      installer: first.artifacts.installer.sha256,
    },
  }), /expected installer SHA-256 mismatch/iu)
})

test('release manifest rejects ignored credentials without echoing their contents', async t => {
  const cases = [
    ['scripts/.env', '.env'],
    ['python/release.pem', '*.pem'],
    ['setup/release.key', '*.key'],
    ['runtime/DSH/.credentials/account.json', '**/.credentials/', 'runtime/DSH/.credentials'],
    ['src/provider-token.json', '**/*token*.json'],
    ['scripts/client-secret.yaml', '**/*secret*.yaml'],
    ['setup/credentials.local.json', '**/credentials.local.json'],
    ['src/apiToken.json', '**/*Token*.json'],
    ['scripts/clientSecret.yml', '**/*Secret*.yml'],
    ['setup/serviceCredentials.json', '**/*Credentials*.json'],
    ['runtime/DSH/.npmrc', '**/.npmrc'],
    ['packages/product-bundle/.pnpmrc', '**/.pnpmrc'],
    ['scripts/.yarnrc.yml', '**/.yarnrc*'],
    ['setup/.netrc', '**/.netrc'],
    ['python/.pypirc', '**/.pypirc'],
    ['runtime/DSH/id_rsa', '**/id_rsa'],
    ['runtime/DSH/id_ed25519', '**/id_ed25519'],
    ['src/service-account-prod.json', '**/service-account*.json'],
    ['scripts/credentials', '**/credentials'],
    ['scripts/token', '**/token'],
    ['src/secret', '**/secret'],
  ]
  for (const [relativePath, ignoredPattern, reportedPath = relativePath] of cases) {
    await t.test(relativePath, async child => {
      const paths = await fixture(child)
      const secret = `never-publish-${relativePath}`
      await writeFile(join(paths.repositoryRoot, '.gitignore'), `${ignoredPattern}\n`)
      for (const root of [paths.repositoryRoot, join(paths.packageDir, 'resources', 'product')]) {
        const target = join(root, relativePath)
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, secret)
      }
      await assert.rejects(
        createReleaseManifest({ ...paths }),
        error => {
          assert.match(error.message, /sensitive release input/iu)
          assert.match(error.message.replaceAll('\\', '/'), new RegExp(reportedPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'))
          assert.doesNotMatch(error.message, new RegExp(secret, 'u'))
          return true
        },
      )
    })
  }
})

test('release manifest rejects sensitive bytes injected into packaged product or app.asar inventories', async t => {
  await t.test('packaged product', async child => {
    const paths = await fixture(child)
    const secret = 'never-publish-packaged-product-secret'
    await writeFile(join(paths.packageDir, 'resources', 'product', 'scripts', '.npmrc'), secret)
    await assert.rejects(createReleaseManifest({ ...paths }), error => {
      assert.match(error.message, /sensitive release input/iu)
      assert.doesNotMatch(error.message, new RegExp(secret, 'u'))
      return true
    })
  })

  await t.test('app.asar', async child => {
    const paths = await fixture(child)
    const secret = 'never-publish-app-asar-secret'
    await writeFile(join(paths.desktopApp, 'src', 'clientSecret.json'), secret)
    const archive = join(paths.packageDir, 'resources', 'app.asar')
    await rm(archive, { force: true })
    await asar.createPackage(paths.desktopApp, archive)
    await assert.rejects(createReleaseManifest({ ...paths }), error => {
      assert.match(error.message, /sensitive release input/iu)
      assert.doesNotMatch(error.message, new RegExp(secret, 'u'))
      return true
    })
  })
})

test('release manifest rechecks source identity after artifact and signing inspection', async t => {
  const paths = await fixture(t)
  let changed = false
  const inspect = async () => {
    if (!changed) {
      changed = true
      await writeFile(join(paths.repositoryRoot, 'scripts', 'start.mjs'), 'changed during release verification\n')
    }
    return { kind: 'authenticode', state: 'unsigned', nativeStatus: 'NotSigned' }
  }
  await assert.rejects(createReleaseManifest({ ...paths, signatureInspector: inspect }), /source.*changed|dirty.*scripts\/start\.mjs/iu)
})

test('release manifest rejects package and installer paths escaping through a parent junction', {
  skip: process.platform !== 'win32',
}, async t => {
  await t.test('packaged product parent junction', async child => {
    const paths = await fixture(child)
    const product = join(paths.packageDir, 'resources', 'product')
    const outside = join(dirname(paths.packageDir), '..', 'outside-product')
    await rename(product, outside)
    await symlink(outside, product, 'junction')
    await assert.rejects(createReleaseManifest({ ...paths }), /outside.*release|link traversal|unsafe release/iu)
  })

  await t.test('installer parent junction', async child => {
    const paths = await fixture(child)
    const outside = join(dirname(paths.packageDir), '..', 'outside-installer')
    await mkdir(outside, { recursive: true })
    const installer = join(outside, 'outside-setup.exe')
    await writeFile(installer, Buffer.alloc(4_096, 0x66))
    const linked = join(dirname(paths.packageDir), 'linked-installer')
    await symlink(outside, linked, 'junction')
    await assert.rejects(createReleaseManifest({ ...paths, installerPath: join(linked, 'outside-setup.exe') }), /outside.*release|link traversal|unsafe release/iu)
  })
})

test('release manifest CLI refuses an output path outside the artifact release directory', async t => {
  const paths = await fixture(t)
  const output = join(paths.repositoryRoot, 'escaped-release-manifest.json')
  const verifier = new URL('../scripts/verify-artifact.mjs', import.meta.url)
  await assert.rejects(run(process.execPath, [
    fileURLToPath(verifier), '--repository-root', paths.repositoryRoot,
    '--package-dir', paths.packageDir, '--installer', paths.installerPath,
    '--output', output,
  ]), /outside.*release|release manifest output/iu)
  await assert.rejects(readFile(output), { code: 'ENOENT' })
})

test('release manifest CLI accepts an isolated recheck directory within the artifact release boundary', async t => {
  const paths = await fixture(t)
  const releaseRoot = await realpath(dirname(paths.packageDir))
  const recheckRoot = await mkdtemp(join(releaseRoot, '.xiaoshe-release-recheck-'))
  const output = join(recheckRoot, 'release-manifest.json')
  const verifier = new URL('../scripts/verify-artifact.mjs', import.meta.url)
  const source = await collectRequiredSourceSnapshot(paths.repositoryRoot)
  await run(process.execPath, [
    fileURLToPath(verifier), '--repository-root', paths.repositoryRoot,
    '--package-dir', paths.packageDir, '--installer', paths.installerPath,
    '--expected-source-sha256', source.sha256, '--output', output,
  ])
  const report = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(report.git.requiredSources.sha256, source.sha256)
  assert.equal(report.identities.runtime.matchesPackaged, true)
  assert.equal(report.artifacts.installer.path, 'Xiaoshe-0.2.0-x64-setup.exe')
  assert.notEqual(report.artifacts.installer.signing.state, 'valid', 'synthetic EXE bytes do not prove Windows signing or installation')
})

test('post-artifact release hook writes the manifest for the exact Windows x64 build outputs', async t => {
  const paths = await fixture(t)
  const release = await import('../scripts/verify-artifact.mjs')
  assert.equal(typeof release.createWindowsReleaseManifestAfterBuild, 'function', 'release hook implementation is required')
  const signatureInspector = async path => ({
    kind: 'authenticode', state: 'valid', nativeStatus: 'Valid',
    subject: `CN=${path.endsWith('.exe') ? 'Xiaoshe' : 'Unknown'}`,
  })

  const outputs = await release.createWindowsReleaseManifestAfterBuild({
    repositoryRoot: paths.repositoryRoot,
    outDir: dirname(paths.packageDir),
    artifactPaths: [paths.installerPath],
    signatureInspector,
  })

  assert.deepEqual(outputs, [join(await realpath(dirname(paths.packageDir)), 'release-manifest.json')])
  const manifest = JSON.parse(await readFile(outputs[0], 'utf8'))
  assert.equal(manifest.schema, 'xiaoshe-desktop-release/v1')
  assert.equal(manifest.artifacts.installer.path, 'Xiaoshe-0.2.0-x64-setup.exe')
  assert.equal(manifest.artifacts.executable.path, 'win-unpacked/小蛇.exe')
})

test('default signing inspection reads the artifact instead of certificate environment variables', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'xiaoshe-signing-inspection-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const target = join(temporary, 'unsigned.exe')
  await writeFile(target, Buffer.alloc(2_048, 0x41))
  const previous = process.env.CSC_LINK
  process.env.CSC_LINK = 'configured-is-not-proof'
  try {
    const signing = await inspectAuthenticode(target)
    assert.equal(signing.kind, 'authenticode')
    assert.notEqual(signing.state, 'valid')
    assert.notEqual(signing.state, 'configured-not-verified-by-this-script')
  } finally {
    if (previous === undefined) delete process.env.CSC_LINK
    else process.env.CSC_LINK = previous
  }
})
