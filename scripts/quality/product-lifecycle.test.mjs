import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicProfilePatch, inspectGracefulExit, createPublicProfile } from './product-lifecycle.mjs'

const exec = promisify(execFile)

// Execute the actual launcher's build block, never its service/Profile setup.
// The recording CLI is an explicitly synthetic local child, not a pnpm install
// or a real product build; it exposes argv, scope and errexit propagation.
async function runLauncherBuildFixture({ isolated, failAt = 0 }) {
  const source = await readFile(new URL('../start-xiaoshe-web.sh', import.meta.url), 'utf8')
  const strict = source.match(/^set -euo pipefail$/mu)?.[0]
  const block = source.match(/^\(\n  cd "\$PLUGIN_ROOT"\n[^]*?^\)$/mu)?.[0]
  assert.ok(strict)
  assert.ok(block)
  assert.equal((block.match(/"\$NODE" "\$PNPM_CLI"/gu) ?? []).length, 2)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xs-launch-build-test-')))
  try {
    const work = join(root, 'relocated product'), cli = join(root, 'recording-cli.mjs'), trace = join(root, 'trace.jsonl')
    await mkdir(work)
    await writeFile(cli, `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const prior = existsSync(process.env.TRACE) ? readFileSync(process.env.TRACE, 'utf8').trim().split('\\n').map(JSON.parse) : [];
const kind = args.includes('build') ? 'build' : 'probe';
const ordinal = prior.filter(row => row.kind === 'build').length + 1;
appendFileSync(process.env.TRACE, JSON.stringify({kind,args,cwd:process.cwd(),ambient:process.env.pnpm_config_verify_deps_before_run})+'\\n');
if (kind === 'build' && !args.includes('--config.verify-deps-before-run=false')) process.exit(90);
if (kind === 'build' && ordinal === Number(process.env.FAIL_AT)) { process.stderr.write('synthetic local compiler dependency missing\\n'); process.exit(40 + ordinal); }
`, { mode: 0o600 })
    const environment = { PATH: '/usr/bin:/bin', HOME: root, PLUGIN_ROOT: work, NODE: process.execPath, PNPM_CLI: cli,
      TRACE: trace, FAIL_AT: String(failAt), pnpm_config_verify_deps_before_run: 'install',
      ...(isolated ? { XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1' } : {}) }
    let outcome
    try {
      outcome = { code: 0, ...await exec('/bin/bash', ['-c', `${strict}\n"$NODE" "$PNPM_CLI" --version\n${block}\n"$NODE" "$PNPM_CLI" --version\n`],
        { cwd: root, env: environment, timeout: 5000, maxBuffer: 65536 }) }
    } catch (error) { outcome = { code: error.code, killed: error.killed, stderr: error.stderr } }
    const rows = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
    return { outcome, rows, work, root }
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('public no-model Profile contains no credential route and a mounted deny-all gate', () => {
  const patch = publicProfilePatch({ productRoot: '/test/xs', ledgerDirectory: '/test/owned/budget', runId: '0310fd7e-1234-4234-8234-a01234567890' })
  for (const id of ['credentials', 'llm-deepseek', 'llm-pi-ai', 'web-search-deepseek', 'session-title-llm', 'session-telemetry-otel']) {
    assert.equal(patch.find(row => row.id === id)?.disabled, true)
  }
  const gate = patch.find(row => row.insert)?.insert[0]
  assert.equal(gate.name, 'file:///test/xs/scripts/acceptance/live-request-budget.mjs')
  assert.equal(gate.config.maxRequests, 0)
  assert.deepEqual(gate.config.sessionIds, [])
  assert.throws(() => publicProfilePatch({ runId: '../daily' }), /invalid acceptance run id/u)
})

test('main exit needs real UI readiness and stopped ownership, not just a zero process code', () => {
  const ready = { event: 'ui-ready' }
  const complete = { event: 'shutdown-complete', service: { stopped: true } }
  assert.equal(inspectGracefulExit([ready, complete]), true)
  assert.equal(inspectGracefulExit([complete]), false)
  assert.equal(inspectGracefulExit([ready]), false)
  assert.equal(inspectGracefulExit([ready, { event: 'shutdown-complete', service: { stopped: false } }]), false)
  assert.equal(inspectGracefulExit([ready, { event: 'shutdown-failed' }, complete]), false)
  assert.equal(inspectGracefulExit([{ event: 'boot-failed' }, ready, complete]), false)
})

test('isolated launch cannot run an installer or silently synchronize Profile dependencies', async () => {
  const script = await readFile(new URL('../start-xiaoshe-web.sh', import.meta.url), 'utf8')
  assert.match(script, /XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED[^]*隔离验收缺少预构建依赖或 Profile；拒绝自动安装。[^]*bash "\$INSTALLER"/u)
  assert.match(script, /if ! profile_has_current_product_packages; then[^]*XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED[^]*拒绝自动修改依赖。[^]*sync_current_product_packages/u)
  assert.match(script, /for KEY in [^\n]*DSH_TELEMETRY_DISABLED/u)
})

for (const isolated of [false, true]) {
  test(`launcher build argv disables implicit dependency installation in ${isolated ? 'isolated' : 'ordinary'} mode`,
    { skip: process.platform === 'win32' }, async () => {
      const { outcome, rows, work, root } = await runLauncherBuildFixture({ isolated })
      assert.equal(outcome.code, 0)
      assert.deepEqual(rows.map(row => row.args), [
        ['--version'],
        ['--config.verify-deps-before-run=false', '-r', '--filter', './packages/**', 'run', 'build'],
        ['--config.verify-deps-before-run=false', 'run', 'build'],
        ['--version'],
      ])
      assert.deepEqual(rows.map(row => row.cwd), [root, work, work, root])
      // pnpm reads this environment key after CLI config. Pin only the build
      // children; the surrounding caller/probes must keep their own setting.
      assert.deepEqual(rows.map(row => row.ambient), ['install', 'false', 'false', 'install'])
    })
}

for (const failAt of [1, 2]) {
  test(`launcher propagates build ${failAt} failure without retries, install or continuing startup`,
    { skip: process.platform === 'win32' }, async () => {
      const { outcome, rows } = await runLauncherBuildFixture({ isolated: true, failAt })
      assert.equal(outcome.code, 40 + failAt)
      assert.notEqual(outcome.killed, true)
      assert.match(outcome.stderr, /synthetic local compiler dependency missing/u)
      assert.deepEqual(rows.map(row => row.kind), ['probe', ...Array(failAt).fill('build')])
      assert.ok(rows.filter(row => row.kind === 'build').every(row => row.args[0] === '--config.verify-deps-before-run=false'))
      assert.deepEqual(rows.map(row => row.ambient), ['install', ...Array(failAt).fill('false')])
      assert.ok(rows.every(row => !row.args.includes('install')))
    })
}

test('public Profile prepares through the real CLI without copying user settings or starting a service', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xs-profile-prepare-test-')))
  const dshHome = join(root, 'dsh-home')
  await mkdir(dshHome)
  await mkdir(join(root, 'workspace'))
  try {
    const profile = await createPublicProfile({ productRoot: fileURLToPath(new URL('../../', import.meta.url)),
      acceptanceRoot: root, runId: '0310fd7e-1234-4234-8234-a01234567890',
      environment: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: dshHome } })
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    assert.equal(Object.keys(manifest.dependencies).length, 17)
    assert.equal(manifest.dsh.profile.bundles.length, 4)
    assert.match(await readFile(join(profile, 'cordis.yml'), 'utf8'), /^# dsh profile root/u)
    assert.deepEqual((await readdir(dshHome)).sort(), ['profiles'])
    const patch = JSON.parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'))
    assert.equal(patch.find(row => row.id === 'credentials').disabled, true)
  } finally { await rm(root, { recursive: true }) }
})
