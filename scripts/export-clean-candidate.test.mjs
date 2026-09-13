import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import nodeTest from 'node:test'
import { createHash } from 'node:crypto'
import { exportCleanCandidate, exportCleanCandidateForTest, candidateCli, ignoredBuildInputCategory, assertCandidatePlatform } from './release/export-clean-candidate.mjs'
import { collectReleaseSourceInputs, collectRequiredSourceSnapshot } from '../apps/desktop-shell/scripts/verify-artifact.mjs'

const run = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const posixSupported = ['darwin', 'linux'].includes(process.platform)
const test = (name, handler) => nodeTest(name, { skip: posixSupported ? false : 'POSIX candidate export unsupported; Windows ACL admission is intentionally closed' }, handler)
async function put(root, path, bytes, mode) {
  await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes)
  if (mode !== undefined) await chmod(join(root, path), mode)
}
async function git(root, ...args) {
  return (await run('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' }, encoding: 'buffer',
  })).stdout
}
async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'xiaoshe-export-test-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'source'), output = join(temporary, 'candidate')
  await mkdir(root, { mode: 0o700 })
  const files = {
    'package.json': '{"name":"fixture","private":true}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n', 'pnpm-workspace.yaml': 'packages: [packages/*]\n',
    'tsconfig.json': '{}\n', 'tsconfig.build.json': '{}\n', 'README.md': '合成候选\r\n',
    'cordis.patch.yml': 'plugins: []\n', '启动小蛇.ps1': 'Write-Output ready\n', '停止小蛇.ps1': 'Write-Output stop\n', '诊断小蛇-Windows.ps1': 'Write-Output inspect\n',
    '.gitignore': '**/lib/\n**/dist/\n**/.DS_Store\n**/__pycache__/\n**/.dsh-build/\n*.tsbuildinfo\noutput/\nprofile/\n',
    'src/index.ts': 'export const label = "中文"\n', 'src/removed.ts': 'export const removed = true\n',
    'scripts/start.mjs': '#!/usr/bin/env node\nconsole.log("fixture")\n',
    'setup/install.sh': '#!/bin/sh\nexit 0\n', 'python/bridge.py': 'VALUE = 1\n',
    'runtime/DSH/package.json': '{"name":"dsh"}\n',
    'runtime/DSH/packages/example/example/package.json': '{"name":"example"}\n',
    'runtime/DSH/packages/example/example/lib/index.js': 'export const built = true\n',
    'runtime/DSH/.dsh-build/client-build-environment.json': '{"schema":"test-only"}\n',
    'runtime/DSH/tsconfig.host.tsbuildinfo': 'test-only incremental metadata\n',
    'packages/example/package.json': '{"name":"example"}\n',
    'packages/example/lib/index.d.ts': 'export declare const value: string\n',
    'apps/desktop-shell/package.json': '{\n "name": "desktop", "version": "0.2.0", "scripts": {"pack":"real-local-script"}, "devDependencies":{"example":"1.2.3"}\n}\n',
    'apps/desktop-shell/src/main.mjs': 'export const native = true\n',
    'apps/desktop-shell/src/acceptance-isolation.mjs': 'export const isolated = true\r\n',
    'apps/desktop-shell/src/中文 名称.txt': Buffer.from([0, 1, 13, 10, 255]),
    'apps/desktop-shell/electron-builder.yml': 'publish: null\n',
    'apps/desktop-shell/scripts/verify-artifact.mjs': 'export const verifier = true\n',
    'apps/desktop-shell/scripts/before-pack.mjs': 'export default function beforePack() {}\n',
  }
  for (const [path, bytes] of Object.entries(files)) await put(root, path, bytes)
  await chmod(join(root, 'scripts/start.mjs'), 0o755)
  await chmod(join(root, 'src'), 0o750)
  await mkdir(join(root, 'src/空目录'), { mode: 0o750 })
  await git(root, 'init', '--quiet'); await git(root, 'config', 'user.name', 'Export Test'); await git(root, 'config', 'user.email', 'export@example.invalid')
  await git(root, 'add', '.'); await git(root, 'commit', '--quiet', '-m', 'fixture')
  return { root, output, temporary, files, options: { repositoryRoot: root, outputDirectory: output } }
}
async function sourceGit(root) {
  return { head: (await git(root, 'rev-parse', 'HEAD')).toString(), index: await readFile(join(root, '.git/index')),
    status: await git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all') }
}
async function incomplete(output) {
  const manifest = JSON.parse(await readFile(join(output, '.xiaoshe-candidate/manifest.json'), 'utf8'))
  assert.equal(manifest.status, 'incomplete'); assert.equal(manifest.cleanReleaseReady, false)
  assert.equal((await lstat(output)).mode & 0o777, 0o700)
}

test('real dirty Git export preserves exact raw bytes/modes and deletion provenance without a clean-release claim', async t => {
  const f = await fixture(t)
  await put(f.root, 'src/index.ts', 'export const label = "当前未提交"\r\n')
  await put(f.root, 'src/new.ts', 'export const newlyAdded = true\n')
  await rm(join(f.root, 'src/removed.ts'))
  await put(f.root, 'output/private-profile.json', 'not copied')
  await put(f.root, 'docs/not-build-input.md', 'not copied')
  await put(f.root, 'apps/desktop-shell/dist-desktop/old.app/payload', 'old package')
  await put(f.root, 'runtime/DSH/.DS_Store', 'cache'); await put(f.root, 'runtime/DSH/__pycache__/hidden.pyc', 'cache')
  const before = await sourceGit(f.root), release = await collectRequiredSourceSnapshot(f.root)
  const result = await exportCleanCandidate(f.options)
  assert.equal(result.status, 'candidate-bytes-saved-not-clean'); assert.equal(result.cleanReleaseReady, false)
  assert.equal(result.provenance.originalWorktreeClean, false); assert.equal(result.provenance.head, before.head.trim())
  assert.deepEqual(Buffer.from(result.provenance.statusBase64, 'base64'), before.status)
  assert.match(before.status.toString(), / D src\/removed\.ts/); assert.match(before.status.toString(), /\?\? src\/new\.ts/)
  assert.deepEqual(await sourceGit(f.root), before)
  const inventory = await collectReleaseSourceInputs(f.output, { includeDigests: true })
  assert.deepEqual(inventory.projectedEntries, result.releaseProjection.entries)
  assert.equal(result.releaseProjection.sha256, release.sha256)
  for (const entry of result.rawInventory.entries) {
    assert.deepEqual(await readFile(join(f.output, entry.path)), await readFile(join(f.root, entry.path)))
    assert.equal((await lstat(join(f.output, entry.path))).mode & 0o7777, entry.mode)
  }
  assert.equal((await lstat(join(f.output, 'src'))).mode & 0o777, 0o750)
  assert.equal((await lstat(join(f.output, 'src/空目录'))).mode & 0o777, 0o750)
  assert.equal((await lstat(f.output)).mode & 0o777, 0o700)
  assert.deepEqual(await readFile(join(f.output, 'apps/desktop-shell/package.json')), Buffer.from(f.files['apps/desktop-shell/package.json']))
  assert(result.rawInventory.entries.some(entry => entry.ignoredCategory === 'compiled-product-code'))
  assert(result.rawInventory.entries.some(entry => entry.ignoredCategory === 'dsh-build-metadata'))
  for (const excluded of ['.git', 'node_modules', 'docs', 'output', 'src/removed.ts', 'runtime/DSH/.DS_Store', 'runtime/DSH/__pycache__', 'apps/desktop-shell/dist-desktop']) await assert.rejects(lstat(join(f.output, excluded)), { code: 'ENOENT' })
  assert.equal(result.gitInitialized, false); assert.equal(result.dependenciesInstalled, false)
  assert.equal(result.build, 'not-run'); assert.equal(result.signing, 'not-run'); assert.equal(result.versionPair, 'not-established')
  assert.deepEqual(JSON.parse(await readFile(join(f.output, '.xiaoshe-candidate/manifest.json'))), result)
})

test('one raw helper exports once while preserving both shipped projections and original Git state', async t => {
  const f = await fixture(t), path = 'apps/desktop-shell/src/acceptance-isolation.mjs'
  const before = await sourceGit(f.root), result = await exportCleanCandidate(f.options)
  const raw = result.rawInventory.entries.filter(entry => entry.path === path)
  assert.equal(raw.length, 1)
  assert.equal(new Set(result.rawInventory.entries.map(entry => entry.path)).size, result.rawInventory.files)
  assert.equal(raw[0].projectedPath, 'desktop/src/acceptance-isolation.mjs')
  assert.deepEqual(raw[0].additionalProjections, [{ projectedPath: `product/${path}`, projection: 'identity' }])
  const projected = result.releaseProjection.entries.filter(entry => entry.path.endsWith('/src/acceptance-isolation.mjs'))
  assert.equal(projected.length, 2)
  assert(projected.every(entry => entry.sha256 === raw[0].sha256 && entry.bytes === raw[0].bytes))
  assert.deepEqual(await readFile(join(f.output, path)), Buffer.from(f.files[path]))
  await assert.rejects(readFile(join(f.output, `product/${path}`)), { code: 'ENOENT' }, 'a raw export is not a packaged resource tree')
  assert.deepEqual(await sourceGit(f.root), before)
  const replay = await collectReleaseSourceInputs(f.output, { includeDigests: true })
  assert.deepEqual(replay.projectedEntries, result.releaseProjection.entries)
  await put(f.output, path, 'export const changed = true\n')
  const changed = await collectReleaseSourceInputs(f.output, { includeDigests: true })
  for (const entry of changed.projectedEntries.filter(entry => entry.path.endsWith('/src/acceptance-isolation.mjs'))) {
    assert.notEqual(entry.sha256, raw[0].sha256, 'both projected identities follow changed raw helper bytes')
  }
})

test('ignored generated admission is bounded to selected real packages and known output types', async t => {
  const f = await fixture(t)
  assert.equal(ignoredBuildInputCategory('packages/example/lib/index.js'), 'compiled-product-code')
  assert.equal(ignoredBuildInputCategory('runtime/DSH/apps/web/dist/assets/fonts/font.ttf'), 'compiled-web-assets')
  for (const path of ['packages/example/lib/profile.json', 'packages/example/lib/.env', 'runtime/DSH/output/app.js', 'runtime/DSH/profile/config.yml', 'runtime/DSH/.dsh-build/token.json']) assert.equal(ignoredBuildInputCategory(path), null)
  await put(f.root, 'packages/unowned/lib/index.js', 'not a declared package')
  await assert.rejects(exportCleanCandidate(f.options), /no selected package manifest/)
  await assert.rejects(lstat(f.output), { code: 'ENOENT' })
})

test('unknown ignored input and sensitive paths fail before target creation, without exposing file contents', async t => {
  for (const path of ['runtime/DSH/profile/config.json', 'packages/example/lib/settings.json', 'runtime/DSH/.env']) {
    const f = await fixture(t)
    await put(f.root, '.gitignore', f.files['.gitignore'] + 'runtime/DSH/profile/\n')
    await put(f.root, path, 'DO_NOT_PRINT_PRIVATE_FIXTURE')
    await assert.rejects(exportCleanCandidate(f.options), error => {
      assert.match(error.message, /ignored release input|sensitive release input/)
      assert(!error.message.includes('DO_NOT_PRINT_PRIVATE_FIXTURE')); return true
    })
    await assert.rejects(lstat(f.output), { code: 'ENOENT' })
  }
})

test('existing and overlapping targets, linked parent/source, and callback options fail closed', async t => {
  const f = await fixture(t)
  await mkdir(f.output); await put(f.output, 'keep', 'user data')
  await assert.rejects(exportCleanCandidate(f.options), { code: 'EEXIST' }); assert.equal(await readFile(join(f.output, 'keep'), 'utf8'), 'user data')
  for (const outputDirectory of [f.root, join(f.root, 'new'), f.temporary]) await assert.rejects(exportCleanCandidate({ repositoryRoot: f.root, outputDirectory }), /overlap/)
  await symlink(f.temporary, join(f.temporary, 'alias'))
  await assert.rejects(exportCleanCandidate({ repositoryRoot: f.root, outputDirectory: join(f.temporary, 'alias/new') }), /canonical/)
  await symlink(f.root, join(f.temporary, 'source-link'))
  await assert.rejects(exportCleanCandidate({ repositoryRoot: join(f.temporary, 'source-link'), outputDirectory: join(f.temporary, 'another') }), /canonical/)
  let called = false
  await assert.rejects(exportCleanCandidate({ ...f.options, checkpoint() { called = true } }), /only repositoryRoot/)
  await assert.rejects(exportCleanCandidate({ get repositoryRoot() { called = true; return f.root }, outputDirectory: f.output }), /plain string/)
  assert.equal(called, false)
})

test('source links, hardlinks and linked desktop raw package are never copied', async t => {
  for (const kind of ['symlink', 'hardlink', 'desktop-package']) {
    const f = await fixture(t)
    const path = kind === 'desktop-package' ? 'apps/desktop-shell/package.json' : 'src/index.ts'
    await put(f.temporary, 'outside', '{}\n'); await rm(join(f.root, path))
    if (kind === 'hardlink') await link(join(f.temporary, 'outside'), join(f.root, path))
    else await symlink(join(f.temporary, 'outside'), join(f.root, path))
    await assert.rejects(exportCleanCandidate(f.options), /unsafe.*input/)
    await assert.rejects(lstat(f.output), { code: 'ENOENT' })
  }
})

for (const change of ['bytes', 'mode', 'inode', 'new-input', 'git-index']) test(`mid-export source ${change} drift preserves an incomplete private target`, async t => {
  const f = await fixture(t); let changed = false
  await assert.rejects(exportCleanCandidateForTest(f.options, async (phase) => {
    if (phase !== 'before-final-check' || changed) return; changed = true
    const path = join(f.root, 'src/index.ts')
    if (change === 'bytes') await writeFile(path, 'changed')
    if (change === 'mode') await chmod(path, 0o600)
    if (change === 'inode') { const bytes = await readFile(path); await rename(path, join(f.temporary, 'original')); await writeFile(path, bytes) }
    if (change === 'new-input') await put(f.root, 'src/late.ts', 'new input')
    if (change === 'git-index') { await put(f.root, 'src/index.ts', 'staged'); await git(f.root, 'add', 'src/index.ts') }
  }), /changed/)
  assert(changed); await incomplete(f.output)
})

test('source ancestor replacement is rejected even with the same file inodes', async t => {
  const f = await fixture(t); let changed = false
  await assert.rejects(exportCleanCandidateForTest(f.options, async (phase, info) => {
    if (phase !== 'before-copy-file' || info.path !== 'src/index.ts' || changed) return; changed = true
    await rename(join(f.root, 'src'), join(f.root, 'old-src'))
    await mkdir(join(f.root, 'src'), { mode: 0o750 })
    for (const file of ['index.ts', 'removed.ts', '空目录']) await rename(join(f.root, 'old-src', file), join(f.root, 'src', file))
  }), /ancestor identity changed/)
  await incomplete(f.output)
})

for (const change of ['bytes', 'extra', 'mode', 'late-publish']) test(`destination ${change} tamper cannot publish candidate success`, async t => {
  const f = await fixture(t); let changed = false
  await assert.rejects(exportCleanCandidateForTest(f.options, async phase => {
    if (phase !== (change === 'late-publish' ? 'before-publish' : 'before-final-check') || changed) return; changed = true
    if (change === 'extra') await put(f.output, 'extra.txt', 'not source')
    else if (change === 'mode') await chmod(join(f.output, 'src/index.ts'), 0o600)
    else await writeFile(join(f.output, 'src/index.ts'), 'tampered')
  }), /candidate.*(?:differs|changed)/)
  await incomplete(f.output)
})

test('destination parent swap is refused without writing through a symlink or adopting foreign files', async t => {
  const f = await fixture(t); let changed = false
  const outside = join(f.temporary, 'outside'); await mkdir(outside)
  await assert.rejects(exportCleanCandidateForTest(f.options, async (phase, info) => {
    if (phase !== 'before-copy-file' || info.path !== 'src/index.ts' || changed) return; changed = true
    await rename(join(f.output, 'src'), join(f.output, 'old-src'))
    await symlink(outside, join(f.output, 'src'))
  }), /real directory/)
  assert.deepEqual(await readdir(outside), []); await incomplete(f.output)
})

test('CLI is strict, side-effect-free on invalid arguments, and emits JSON plus an honest Chinese summary', async t => {
  const f = await fixture(t)
  await assert.rejects(candidateCli(['--source', f.root, '--output', f.output, '--commit']), /Usage/)
  await assert.rejects(lstat(f.output), { code: 'ENOENT' })
  const result = await candidateCli(['--source', f.root, '--output', f.output])
  assert.equal(result.cleanReleaseReady, false); assert.match(result.summary, /尚不是 clean release/)
  assert.match(result.status, /not-clean$/)
  const metadata = JSON.parse(await readFile(result.manifest))
  assert.equal(result.sha256, metadata.rawInventory.sha256)
  assert.equal(result.sha256, sha(JSON.stringify(metadata.rawInventory.entries.map(({ path, bytes, sha256, mode }) => [path, bytes, sha256, mode]))))
})

nodeTest('platform admission explicitly refuses unimplemented Windows ACL/privacy guarantees', () => {
  assert.throws(() => assertCandidatePlatform('win32'), { code: 'UNSUPPORTED_PLATFORM' })
  assert.throws(() => assertCandidatePlatform('unknown'), { code: 'UNSUPPORTED_PLATFORM' })
  if (posixSupported) assert.doesNotThrow(() => assertCandidatePlatform(process.platform))
  else assert.throws(() => assertCandidatePlatform(process.platform), { code: 'UNSUPPORTED_PLATFORM' })
})

test('post-publication durability failure retains an owned failure receipt and demotes manifest to incomplete', async t => {
  const f = await fixture(t)
  await assert.rejects(exportCleanCandidateForTest(f.options, async phase => {
    // A deterministic storage-failure boundary, not a claim to have produced
    // physical disk failure. The real write/fsync/rename already happened.
    if (phase === 'after-manifest-publication') throw Object.assign(new Error('test-only directory sync fault'), { code: 'EIO' })
  }), { code: 'EIO' })
  await incomplete(f.output)
  const failure = JSON.parse(await readFile(join(f.output, '.xiaoshe-candidate/failure.json')))
  assert.equal(failure.manifestPublished, true); assert.equal(failure.directoryDurability, 'unknown')
  assert.equal(failure.code, 'EIO'); assert.equal(failure.cleanReleaseReady, false)
  assert.equal(await readFile(join(f.output, 'src/index.ts'), 'utf8'), f.files['src/index.ts'])
})

test('publication failure never overwrites a replaced foreign manifest', async t => {
  const f = await fixture(t)
  await assert.rejects(exportCleanCandidateForTest(f.options, async phase => {
    if (phase !== 'after-manifest-publication') return
    const manifest = join(f.output, '.xiaoshe-candidate/manifest.json')
    await rename(manifest, join(f.output, '.xiaoshe-candidate/original-manifest.json'))
    await writeFile(manifest, 'foreign bytes')
    throw Object.assign(new Error('test-only publication fault'), { code: 'EIO' })
  }), { code: 'EIO' })
  assert.equal(await readFile(join(f.output, '.xiaoshe-candidate/manifest.json'), 'utf8'), 'foreign bytes')
  await assert.rejects(lstat(join(f.output, '.xiaoshe-candidate/failure.json')), { code: 'ENOENT' })
})

for (const kind of ['timeout', 'stderr-limit']) test(`actual bounded Git subprocess ${kind} stops and reaps its own process group`, async t => {
  const f = await fixture(t), bin = join(f.temporary, 'bin'), pidFile = join(f.temporary, 'pids.json')
  await mkdir(bin)
  // This negative test executes local Node children, never a model or native
  // app. Their inherited pipes prove close/reap rather than a fake timeout.
  const body = `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nimport {writeFileSync} from 'node:fs';\nprocess.on('SIGTERM',()=>{});\nconst child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'inherit'});\nwriteFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));\n${kind === 'stderr-limit' ? 'process.stderr.write(Buffer.alloc(200*1024,120));' : ''}\nsetInterval(()=>{},1000);\n`
  await writeFile(join(bin, 'git'), body); await chmod(join(bin, 'git'), 0o755)
  const oldPath = process.env.PATH, started = Date.now()
  process.env.PATH = `${bin}:${oldPath}`
  try { await assert.rejects(exportCleanCandidate(f.options), { code: kind === 'timeout' ? 'GIT_TIMEOUT' : 'GIT_OUTPUT_LIMIT' }) }
  finally { process.env.PATH = oldPath }
  assert(Date.now() - started < 15_000)
  const pids = JSON.parse(await readFile(pidFile))
  for (const pid of [...pids, -pids[0]]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await assert.rejects(lstat(f.output), { code: 'ENOENT' })
})

async function filterFixture(f) {
  const marker = join(f.temporary, 'filter-ran'), script = join(f.temporary, 'clean-filter.mjs')
  await writeFile(script, `import {readFileSync,writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write(readFileSync(0));\n`)
  await put(f.root, '.gitattributes', 'src/index.ts filter=fixture\n')
  const changed = f.files['src/index.ts'].replace('label', 'value')
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(f.files['src/index.ts']))
  await put(f.root, 'src/index.ts', changed)
  return { marker, command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` }
}
async function assertFilterRefused(f, marker) {
  const index = await readFile(join(f.root, '.git/index')), config = await readFile(join(f.root, '.git/config'))
  await assert.rejects(exportCleanCandidate(f.options), error => {
    assert.equal(error.code, 'GIT_EXTERNAL_FILTER'); assert(!error.message.includes(marker)); assert(!error.message.includes('clean-filter.mjs')); return true
  })
  await assert.rejects(lstat(marker), { code: 'ENOENT' })
  await assert.rejects(lstat(f.output), { code: 'ENOENT' })
  assert.deepEqual(await readFile(join(f.root, '.git/index')), index)
  assert.deepEqual(await readFile(join(f.root, '.git/config')), config)
}

test('real status clean-filter side effect is refused using only key names before any execution', async t => {
  const f = await fixture(t), filter = await filterFixture(f)
  await git(f.root, 'config', 'filter.fixture.clean', filter.command)
  await assertFilterRefused(f, filter.marker)
  // Positive control in this disposable repository: the very same real Git
  // status would execute the local command without the new admission.
  await git(f.root, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all')
  assert.equal(await readFile(filter.marker, 'utf8'), 'executed')
})

for (const kind of ['process', 'include', 'includeIf', 'duplicate', 'empty']) test(`effective ${kind} clean/process configuration is rejected before status`, async t => {
  const f = await fixture(t), filter = await filterFixture(f)
  if (kind === 'include' || kind === 'includeIf') {
    const included = join(f.temporary, 'included.gitconfig')
    await git(f.root, 'config', '--file', included, 'filter.fixture.clean', filter.command)
    await git(f.root, 'config', kind === 'include' ? 'include.path' : `includeIf.gitdir:${f.root}/.path`, included)
  } else {
    await git(f.root, 'config', kind === 'process' ? 'filter.fixture.process' : 'filter.fixture.clean', kind === 'empty' ? '' : filter.command)
    if (kind === 'duplicate') await git(f.root, 'config', '--add', 'filter.fixture.clean', filter.command)
  }
  await assertFilterRefused(f, filter.marker)
})

test('inactive includes and inherited Git configuration do not silently become effective filter commands', async t => {
  const f = await fixture(t), filter = await filterFixture(f)
  const included = join(f.temporary, 'inactive.gitconfig'), global = join(f.temporary, 'global.gitconfig')
  await git(f.root, 'config', '--file', included, 'filter.fixture.clean', filter.command)
  await git(f.root, 'config', '--file', global, 'filter.fixture.process', filter.command)
  await git(f.root, 'config', 'includeIf.gitdir:/not-this-fixture/.path', included)
  const updates = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.fixture.clean', GIT_CONFIG_VALUE_0: filter.command,
    GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: global }
  const prior = Object.fromEntries(Object.keys(updates).map(key => [key, process.env[key]]))
  Object.assign(process.env, updates)
  try { assert.equal((await exportCleanCandidate(f.options)).status, 'candidate-bytes-saved-not-clean') }
  finally { for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value }
  await assert.rejects(lstat(filter.marker), { code: 'ENOENT' })
})

test('new filter configuration during export is checked again before final status, without executing it', async t => {
  const f = await fixture(t), filter = await filterFixture(f)
  let configured = false
  await assert.rejects(exportCleanCandidateForTest(f.options, async phase => {
    if (phase !== 'before-final-check' || configured) return; configured = true
    await git(f.root, 'config', 'filter.fixture.clean', filter.command)
  }), { code: 'GIT_EXTERNAL_FILTER' })
  assert(configured); await assert.rejects(lstat(filter.marker), { code: 'ENOENT' }); await incomplete(f.output)
})

test('real tracked gitlink with a child-only clean filter is refused before parent status can execute it', async t => {
  const f = await fixture(t), child = join(f.root, 'runtime/fixture'), marker = join(f.temporary, 'child-filter-ran')
  await mkdir(child)
  await git(child, 'init', '--quiet'); await git(child, 'config', 'user.name', 'Child Test'); await git(child, 'config', 'user.email', 'child@example.invalid')
  await put(child, 'sample.txt', 'before\n'); await put(child, '.gitattributes', 'sample.txt filter=fixture\n')
  await git(child, 'add', '.'); await git(child, 'commit', '--quiet', '-m', 'child fixture')
  await git(f.root, 'add', 'runtime/fixture'); await git(f.root, 'commit', '--quiet', '-m', 'tracked child gitlink')
  const script = join(f.temporary, 'child-filter.mjs')
  await writeFile(script, `import{readFileSync,writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write(readFileSync(0));\n`)
  await git(child, 'config', 'filter.fixture.clean', `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`)
  // Equal length matters: Git's stat fast path can bypass clean filtering for
  // a size-only mismatch, so this reproduces the actual recursive execution.
  await put(child, 'sample.txt', 'change\n')
  assert.equal(Buffer.byteLength('before\n'), Buffer.byteLength('change\n'))
  const parentIndex = await readFile(join(f.root, '.git/index')), childIndex = await readFile(join(child, '.git/index'))
  await assert.rejects(exportCleanCandidate(f.options), { code: 'GIT_SUBMODULE_UNSUPPORTED' })
  await assert.rejects(lstat(marker), { code: 'ENOENT' }); await assert.rejects(lstat(f.output), { code: 'ENOENT' })
  assert.deepEqual(await readFile(join(f.root, '.git/index')), parentIndex)
  assert.deepEqual(await readFile(join(child, '.git/index')), childIndex)
  await git(f.root, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all')
  assert.equal(await readFile(marker, 'utf8'), 'executed', 'unprotected parent status really invokes the child-only filter')
})
