import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { captureCandidate, runGate } from './internal-beta.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const electron = createRequire(join(root, 'apps/desktop-shell/package.json'))('electron')

test('原生浏览器实际操作及第二进程存储恢复，独立于其他Electron旅程', { timeout: 150_000 }, async t => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'xs-native-browser-gate-')))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const profile = join(fixture, 'owned-profile'); const output = join(fixture, 'reports')
  await mkdir(profile); await mkdir(output)
  // runGate owns and reaps the exact Electron child tree. A fixture must not
  // inherit Codex/CLI's optional Electron-as-Node transport mode.
  const environment = { ELECTRON_RUN_AS_NODE: undefined, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    XIAOSHE_BROWSER_ACCEPTANCE_PROFILE: profile, XIAOSHE_BROWSER_ACCEPTANCE_OUTPUT: output }
  const common = { command: electron, args: ['apps/desktop-shell/test/run-browser-acceptance.mjs'], timeoutMs: 55_000, env: environment }
  const stages = [{ ...common, id: 'native-browser-real-actions' },
    { ...common, id: 'native-browser-storage-restart', env: { ...environment, XIAOSHE_BROWSER_STORAGE_PROBE: '1' } }]
  let gate, actions, restart, failure
  try {
    gate = await runGate({ root, stages, required: stages.map(stage => stage.id), reportPath: join(output, 'gate-report.json') })
    actions = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
    assert.equal(gate.deterministic, 'passed', actions.error ?? JSON.stringify(gate.stages))
    assert.equal(gate.sourceStable, true)
    assert.equal(actions.accepted, true)
    assert.ok(actions.checks.length >= 15 && actions.checks.every(check => check.passed === true))
    assert.equal(actions.authenticatedExternalSiteTested, false)
    restart = JSON.parse(await readFile(join(output, 'storage-restart-report.json'), 'utf8'))
    assert.equal(restart.accepted, true)
    assert.ok(restart.checks.length > 0 && restart.checks.every(check => check.passed === true))
  } catch (error) { failure = error }
  // Preserve the actual component screenshots before the owned fixture is
  // removed. A JSON check counter alone cannot be visually inspected later.
  const evidence = process.env.XIAOSHE_NATIVE_BROWSER_EVIDENCE_DIR
  const retainedImages = []
  if (evidence && actions?.accepted) try {
    assert.ok(isAbsolute(evidence), 'native browser evidence directory must be explicit and absolute')
    await mkdir(evidence, { recursive: true, mode: 0o700 })
    const imageDirectory = join(evidence, `captures-${randomUUID()}`)
    await mkdir(imageDirectory, { mode: 0o700 })
    for (const name of ['private-browser-page.png', ...[0, 1].flatMap(round => ['first', 'second'].map(tab => `inactive-tab-${round}-${tab}.png`))]) {
      const bytes = await readFile(join(output, name)), path = join(imageDirectory, name)
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
      assert.deepEqual(await readFile(path), bytes)
      retainedImages.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  } catch (error) { failure ??= error }
  // Cleanup is unconditional, not a gate stage that gets skipped after failure.
  let cleaned = false
  try {
    await rm(fixture, { recursive: true, force: true })
    await assert.rejects(lstat(fixture), error => error.code === 'ENOENT')
    cleaned = true
    if (gate) assert.equal((await captureCandidate(root)).sha256, gate.sourceBefore.sha256)
  } catch (error) { failure ??= error }
  if (evidence) {
    assert.ok(isAbsolute(evidence), 'native browser evidence directory must be explicit and absolute')
    await mkdir(evidence, { recursive: true, mode: 0o700 })
    await writeFile(join(evidence, `native-browser-${randomUUID()}.json`), JSON.stringify({
      schema: 'xiaoshe-native-browser-component/v1', executionKind: 'component_fixture',
      accepted: !failure && cleaned, gate, actions, restart, retainedImages,
      cleanup: [{ id: 'parent-owned-profile-cleanup', state: cleaned ? 'pass' : 'fail' }],
      paidModelRequests: 0, authenticatedExternalSiteTested: false,
      finishedAt: new Date().toISOString(),
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  if (failure) throw failure
})
