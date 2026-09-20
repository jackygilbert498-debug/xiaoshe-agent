import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { watch, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { copySource, planSource, verifyHandoff } from './handoff-source.mjs'

const script = fileURLToPath(new URL('./handoff-source.mjs', import.meta.url))

async function fixture(t, files = { 'package.json': '{"name":"fixture"}\n', 'src/index.ts': 'export const value = 1\n' }) {
  // macOS exposes its temporary directory through /var -> /private/var.
  // Use a physical fixture root without weakening production link rejection.
  const temporaryRoot = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryRoot, 'xs-handoff-test-'))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await mkdir(source)
  await mkdir(destination)
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true })
    await writeFile(join(source, path), bytes)
  }
  t.after(async () => {
    // This fixture alone owns the temporary directory; never remove a caller path.
    assert.equal(dirname(root), temporaryRoot)
    assert.match(root, /xs-handoff-test-[^\\/]+$/u)
    await rm(root, { recursive: true, force: true })
  })
  return { root, source, destination }
}

async function exportFixture(t, files) {
  const data = await fixture(t, files)
  const plan = await planSource(data.source)
  const manifest = await copySource({ ...data, expectedSha256: plan.sourceSha256 })
  return { ...data, manifest }
}

test('plan includes current untracked source, tests, runtime inputs and real UI lib', async t => {
  const paths = [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'src/new-untracked.ts',
    'scripts/test-fixture.mjs', 'packages/new-plugin/test/current.test.mjs',
    'packages/new-plugin/src/lib/parser.ts', 'runtime/xiaoshe-legacy/ui/js/lib/dom.js',
    'runtime/xiaoshe-legacy/ui/assets/snake.svg', 'runtime/xiaoshe-legacy/harness/observe.py',
    'runtime/DSH/vendor/cordis/src/index.ts', 'runtime/DSH/native/system/packages/entry/src/flock.c',
    'runtime/DSH/patches/node-pty.patch', 'runtime/DSH/LICENSE',
    'runtime/DSH/snapshots/expected-session.jsonl', 'runtime/DSH/python/sdk/uv.lock',
    'runtime/DSH/snapshots/session/skill-load/workspace/.dsh/skills/example/SKILL.md',
    'runtime/DSH/docs/subsystems/credentials.md',
    'runtime/DSH/packages/credentials/credentials/src/index.ts',
    'runtime/DSH/apps/cli/tests/profiles/headless/credentials-snapshot.patch.yml',
    'docs/loop-graph-delivery-2026-09-20.md',
    'docs/superpowers/specs/2026-09-20-loop-graph-design.md',
    'docs/superpowers/plans/2026-09-20-loop-graph.md', '_交接说明.md',
    '.gitignore', 'runtime/xiaoshe-legacy/.env.example',
  ]
  const { source } = await fixture(t, Object.fromEntries(paths.map(path => [path, 'source\n'])))
  const plan = await planSource(source)
  assert.deepEqual(plan.files.map(file => file.path), [...paths].sort())
  assert.equal(plan.fileCount, paths.length)
  assert.equal(plan.bytes, paths.length * 7)
  assert.match(plan.sourceSha256, /^[a-f0-9]{64}$/u)
  assert.equal(plan.sourceHead, null)
})

test('plan omits private state and generated outputs without confusing credential source names', async t => {
  const excluded = [
    '.git/config', '.superpowers/sdd/private.json', '_验收/screenshot.png',
    'artifacts/acceptance/report.json', 'output/private-session.json', '_接收记录.md',
    '.env', '.env.production', '.credentials.yaml', 'credentials.local.json',
    '.credentials/token.json', 'secrets.local.toml', 'cert.key', 'signing.pfx',
    'id_ed25519', '.npmrc', 'node_modules/pkg/source.js',
    'runtime/DSH/node_modules/pkg/source.js', 'python/__pycache__/bridge.pyc',
    '.venv/pyvenv.cfg', 'logs/session.log', '.dsh/profiles/web/credentials.json',
    '.state/ui_token', 'runtime/DSH/.sessions/session.jsonl',
    'dist/index.js', 'packages/memory/lib/index.js', 'packages/memory/dist/client.js',
    'runtime/DSH/packages/core/session/lib/index.js', 'runtime/DSH/vendor/cordis/lib/index.js',
    'runtime/DSH/apps/web/dist/index.html', 'runtime/DSH/.dsh-build/client-build-environment.json',
    'runtime/DSH/native/landlock-run/packages/entry/lib/index.js',
    'runtime/DSH/tsconfig.host.tsbuildinfo', 'apps/desktop-shell/dist-desktop/installer.exe',
    'apps/desktop-shell/output/acceptance/private.json',
    'docs/superpowers/plans/2026-09-12-old-version.md', '.DS_Store',
  ]
  const { source } = await fixture(t, { 'src/credentials.ts': 'source', ...Object.fromEntries(excluded.map(path => [path, 'PRIVATE'])), '.env.example': 'KEY=' })
  const plan = await planSource(source)
  assert.deepEqual(plan.files.map(file => file.path), ['.env.example', 'src/credentials.ts'])
  for (const path of excluded) {
    assert.ok(plan.excluded.some(entry => path === entry.path || path.startsWith(`${entry.path}/`)), path)
  }
})

test('copy preserves exact current bytes and self-contained verifier needs no original source or Git', async t => {
  const files = { 'package.json': '{}', 'src/中文.ts': 'const value = "当前"\r\n', 'asset.png': Buffer.from([0, 255, 10, 13]) }
  const { source, destination, manifest } = await exportFixture(t, files)
  for (const [path, bytes] of Object.entries(files)) assert.deepEqual(await readFile(join(destination, path)), Buffer.from(bytes))
  assert.equal(manifest.kind, 'xiaoshe-source-handoff')
  assert.equal(manifest.sourceHead, null)
  assert.equal(manifest.fileCount, 3)
  assert.equal(manifest.files.find(file => file.path === 'package.json').sha256, createHash('sha256').update('{}').digest('hex'))
  await writeFile(join(source, 'src/中文.ts'), 'source changed later')
  const checked = await verifyHandoff(destination)
  assert.equal(checked.verified, true)
  assert.equal(checked.fileCount, 3)
  const cli = spawnSync(process.execPath, [script, 'verify', '--destination', destination], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).verified, true)
  const relativeCli = spawnSync(process.execPath, [script, 'verify', '--destination', '.'], { cwd: destination, encoding: 'utf8' })
  assert.equal(relativeCli.status, 0, relativeCli.stderr)
})

test('copy refuses absent or outdated reviewed snapshot before touching destination', async t => {
  const data = await fixture(t)
  await assert.rejects(copySource(data), /reviewed|expected.*sha256/iu)
  const plan = await planSource(data.source)
  await writeFile(join(data.source, 'src/index.ts'), 'changed after review')
  await assert.rejects(copySource({ ...data, expectedSha256: plan.sourceSha256 }), /review|changed|mismatch/iu)
  assert.deepEqual(await readdir(data.destination), [])
})

test('source mutation during copying fails without publishing a completed manifest', async t => {
  const data = await fixture(t, { 'a.txt': 'original', 'z.txt': 'last' })
  const plan = await planSource(data.source)
  let changed = false
  const watcher = watch(data.destination, (_event, filename) => {
    if (filename !== 'a.txt' || changed) return
    changed = true
    // A real concurrent source edit after the first destination file appears.
    writeFileSync(join(data.source, 'a.txt'), 'new source bytes')
  })
  try {
    await assert.rejects(copySource({ ...data, expectedSha256: plan.sourceSha256 }), /changed|review|mismatch/iu)
    assert.equal(changed, true)
    assert.equal((await readdir(data.destination)).includes('handoff-manifest.json'), false)
    assert.equal(await readFile(join(data.source, 'a.txt'), 'utf8'), 'new source bytes')
  } finally { watcher.close() }
})

test('copy refuses overlapping or nonempty targets and leaves user files untouched', async t => {
  const data = await fixture(t)
  const plan = await planSource(data.source)
  await writeFile(join(data.destination, 'keep.txt'), 'user data')
  await assert.rejects(copySource({ ...data, expectedSha256: plan.sourceSha256 }), /empty/iu)
  assert.equal(await readFile(join(data.destination, 'keep.txt'), 'utf8'), 'user data')
  for (const destination of [data.source, data.root]) {
    await assert.rejects(copySource({ ...data, destination, expectedSha256: plan.sourceSha256 }), /overlap|disjoint/iu)
  }
  const child = join(data.source, 'child')
  await mkdir(child)
  await assert.rejects(copySource({ ...data, destination: child, expectedSha256: plan.sourceSha256 }), /overlap|disjoint/iu)
})

test('verifier rejects tampered files and extra files including excluded names', async t => {
  const { destination } = await exportFixture(t)
  await writeFile(join(destination, 'src/index.ts'), 'tampered')
  await assert.rejects(verifyHandoff(destination), /hash|mismatch|size/iu)
  await writeFile(join(destination, 'src/index.ts'), 'export const value = 1\n')
  await writeFile(join(destination, '.env'), 'injected')
  await assert.rejects(verifyHandoff(destination), /unexpected|file list/iu)
})

test('verifier rejects missing files and extra empty directories', async t => {
  const { destination } = await exportFixture(t)
  await mkdir(join(destination, 'unexpected-empty'))
  await assert.rejects(verifyHandoff(destination), /unexpected|director/iu)
  await rmdir(join(destination, 'unexpected-empty'))
  await rm(join(destination, 'src/index.ts'))
  await assert.rejects(verifyHandoff(destination), /missing|file list/iu)
})

test('verifier rejects unsafe, duplicate and case-colliding manifest paths', async t => {
  const { destination, manifest } = await exportFixture(t)
  for (const path of ['../outside', 'C:/outside', '/outside', 'src\\index.ts', 'src/../outside', 'src/aux.txt', 'src/trailing.']) {
    await writeFile(join(destination, 'handoff-manifest.json'), JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], path }] }))
    await assert.rejects(verifyHandoff(destination), /unsafe|manifest|path/iu, path)
  }
  for (const path of ['package.json', 'PACKAGE.JSON']) {
    await writeFile(join(destination, 'handoff-manifest.json'), JSON.stringify({ ...manifest, files: [...manifest.files, { ...manifest.files[0], path }] }))
    await assert.rejects(verifyHandoff(destination), /duplicate|collision|manifest/iu)
  }
})

test('selected junctions fail, excluded dependency junctions are not followed', async t => {
  const data = await fixture(t)
  const outside = join(data.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'private.txt'), 'private')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(outside, join(data.source, 'node_modules'), linkType)
  const plan = await planSource(data.source)
  assert.equal(plan.files.length, 2)
  await symlink(outside, join(data.source, 'selected-link'), linkType)
  await assert.rejects(planSource(data.source), /link|junction/iu)
  await symlink(data.destination, join(data.root, 'destination-link'), linkType)
  await assert.rejects(copySource({ ...data, destination: join(data.root, 'destination-link'), expectedSha256: plan.sourceSha256 }), /link|canonical/iu)
})

test('verifier rejects an added junction without traversing it', async t => {
  const { root, destination } = await exportFixture(t)
  const outside = join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, join(destination, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(verifyHandoff(destination), /link|junction/iu)
})

test('plan refuses files exceeding the bounded source size', async t => {
  const { source } = await fixture(t, { 'large.dat': Buffer.alloc(17) })
  await assert.rejects(planSource(source, { maxFileBytes: 16 }), /size|large|limit/iu)
})

test('CLI plan is read-only and unknown arguments fail', async t => {
  const { source, destination } = await fixture(t)
  const result = spawnSync(process.execPath, [script, 'plan', '--source', source], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).fileCount, 2)
  assert.deepEqual(await readdir(destination), [])
  const invalid = spawnSync(process.execPath, [script, 'copy', '--source', source, '--destination', destination, '--force'], { encoding: 'utf8' })
  assert.notEqual(invalid.status, 0)
  assert.deepEqual(await readdir(destination), [])
})
