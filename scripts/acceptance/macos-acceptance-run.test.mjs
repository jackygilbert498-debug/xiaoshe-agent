import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../..')
const generator = resolve(repositoryRoot, 'scripts/acceptance/generate-macos-report.mjs')
const verifier = resolve(repositoryRoot, 'scripts/acceptance/verify-report.mjs')
const electronBuilderPath = resolve(repositoryRoot, 'apps/desktop-shell/electron-builder.yml')

test('macOS acceptance implementation digest covers the executed app, bridge, and fixture dependencies', async t => {
  const module = await import('./macos-acceptance-run.mjs')
  const requiredClosure = [
    'apps/desktop-shell/src/acceptance-isolation.mjs',
    'apps/desktop-shell/src/lifecycle.mjs',
    'apps/desktop-shell/src/security-policy.mjs',
    'scripts/acceptance/fixtures/XiaosheDesktopActionFixture.swift',
    'runtime/xiaoshe-legacy/harness/observe.py',
    'runtime/xiaoshe-legacy/harness/viewport.py',
    'runtime/xiaoshe-legacy/harness/imaging.py',
    'runtime/xiaoshe-legacy/harness/platform_caps.py',
  ]
  for (const path of requiredClosure) assert.ok(module.MACOS_ACCEPTANCE_IMPLEMENTATION_FILES.includes(path), path)

  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-acceptance-implementation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const path of module.MACOS_ACCEPTANCE_IMPLEMENTATION_FILES) {
    const destination = join(directory, path)
    await mkdir(resolve(destination, '..'), { recursive: true })
    await writeFile(destination, 'stable')
  }
  const before = await module.macosAcceptanceImplementationSha256(directory)
  await writeFile(join(directory, 'runtime/xiaoshe-legacy/harness/observe.py'), 'changed')
  const after = await module.macosAcceptanceImplementationSha256(directory)
  assert.notEqual(after, before)
})

test('beginning a macOS acceptance run removes only exact stale report files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-macos-run-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const staleAggregate = join(directory, 'macos-desktop.json')
  const staleComponent = join(directory, 'component.json')
  const protectedDirectory = join(directory, 'keep')
  await writeFile(staleAggregate, '{"status":"PASS"}\n')
  await writeFile(staleComponent, '{"status":"PASS"}\n')
  await mkdir(protectedDirectory)
  await writeFile(join(protectedDirectory, 'evidence.txt'), 'keep')

  const module = await import('./macos-acceptance-run.mjs').catch(() => null)
  assert.ok(module, 'macOS acceptance run helper is required')
  const context = await module.beginMacosAcceptanceRun([staleAggregate, staleComponent], {
    uuid: () => '11111111-1111-4111-8111-111111111111',
    now: () => new Date('2026-09-06T00:00:00.987Z'),
  })

  assert.deepEqual(context, {
    runId: '11111111-1111-4111-8111-111111111111',
    runStartedAt: '2026-09-06T00:00:00.000Z',
  })
  await assert.rejects(readFile(staleAggregate), { code: 'ENOENT' })
  await assert.rejects(readFile(staleComponent), { code: 'ENOENT' })
  assert.equal(await readFile(join(protectedDirectory, 'evidence.txt'), 'utf8'), 'keep')
  await assert.rejects(module.beginMacosAcceptanceRun([protectedDirectory]), /regular file|directory|refus/iu)
})

test('failed formal components receive a current-run fail report for final aggregation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-macos-failed-component-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const outputs = Object.fromEntries(['actions', 'signing', 'source', 'lifecycle', 'install']
    .map(component => [component, join(directory, `${component}.json`)]))
  const output = join(directory, 'aggregate.json')
  const module = await import('./macos-acceptance-run.mjs')
  assert.equal(typeof module.ensureMacosComponentFailureReport, 'function')
  const context = {
    runId: '11111111-1111-4111-8111-111111111111',
    runStartedAt: '2026-09-06T00:00:00.000Z',
  }
  for (const [component, path] of Object.entries(outputs)) {
    await module.ensureMacosComponentFailureReport(path, component, context, {
      now: () => new Date('2026-09-06T00:00:01.000Z'),
    })
  }
  const source = JSON.parse(await readFile(outputs.source, 'utf8'))
  assert.equal(source.runId, context.runId)
  assert.deepEqual(source.checks.map(check => [check.id, check.state]), [['release-source-identity', 'fail']])
  assert.doesNotMatch(JSON.stringify(source), /stderr|profile|Users|Documents/u)

  const generated = await run(process.execPath, [
    generator,
    `--root=${repositoryRoot}`,
    `--output=${output}`,
    '--test-state=pass',
    `--run-id=${context.runId}`,
    `--run-started-at=${context.runStartedAt}`,
    ...Object.entries(outputs).map(([component, path]) => `--${component}=${path}`),
  ]).then(value => ({ code: 0, ...value })).catch(error => ({
    code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '',
  }))
  assert.equal(generated.code, 1, generated.stderr)
  const aggregate = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(aggregate.checks.filter(check => check.state === 'fail').length, 7)
  assert.ok(aggregate.checks.some(check => check.id === 'desktop-update-policy' && check.state === 'pass'))
})

test('a nonzero component cannot preserve a current-run report with no failed check', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-macos-false-green-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, 'actions.json')
  const context = {
    runId: '11111111-1111-4111-8111-111111111111',
    runStartedAt: '2026-09-06T00:00:00.000Z',
  }
  await writeFile(output, `${JSON.stringify({
    schemaVersion: 1,
    platform: 'macos',
    generatedAt: '2026-09-06T00:00:01.000Z',
    ...context,
    checks: [
      { id: 'screen-recording-permission', state: 'pass' },
      { id: 'accessibility-permission', state: 'pass' },
    ],
  })}\n`)

  const { ensureMacosComponentFailureReport } = await import('./macos-acceptance-run.mjs')
  const replaced = await ensureMacosComponentFailureReport(output, 'actions', context, {
    now: () => new Date('2026-09-06T00:00:02.000Z'),
  })
  assert.equal(replaced, true)
  const report = JSON.parse(await readFile(output, 'utf8'))
  assert.deepEqual(report.checks.map(check => [check.id, check.state]), [
    ['screen-recording-permission', 'fail'],
    ['accessibility-permission', 'fail'],
  ])
})

async function runGenerator(component, runId, runStartedAt) {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-macos-generator-'))
  const componentPath = join(directory, 'component.json')
  const output = join(directory, 'aggregate.json')
  await writeFile(componentPath, `${JSON.stringify(component)}\n`)
  try {
    const result = await run(process.execPath, [
      generator,
      `--root=${repositoryRoot}`,
      `--output=${output}`,
      '--test-state=pass',
      `--run-id=${runId}`,
      `--run-started-at=${runStartedAt}`,
      `--actions=${componentPath}`,
    ]).then(value => ({ code: 0, ...value })).catch(error => ({
      code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '',
    }))
    const report = await readFile(output, 'utf8').then(JSON.parse).catch(() => undefined)
    return { ...result, output, report }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('aggregate generator rejects component evidence from another or older run', async () => {
  const runId = '11111111-1111-4111-8111-111111111111'
  const runStartedAt = '2026-09-06T00:00:00.000Z'
  const base = {
    schemaVersion: 1,
    platform: 'macos',
    generatedAt: '2026-09-06T00:00:01.000Z',
    runStartedAt,
    checks: [{ id: 'real-desktop-action-loop', state: 'pass', detail: 'real evidence', evidence: {} }],
  }

  const wrongRun = await runGenerator({ ...base, runId: '22222222-2222-4222-8222-222222222222' }, runId, runStartedAt)
  assert.notEqual(wrongRun.code, 0)
  assert.match(wrongRun.stderr, /run|identity/iu)

  const stale = await runGenerator({ ...base, runId, generatedAt: '2026-09-05T23:59:59.000Z' }, runId, runStartedAt)
  assert.notEqual(stale.code, 0)
  assert.match(stale.stderr, /fresh|time|run/iu)
})

test('static macOS aggregate explicitly leaves final packaged-app actions pending', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-macos-static-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, 'aggregate.json')
  const generatedAt = new Date()
  const runStartedAt = new Date(generatedAt.getTime() - 1_000).toISOString()
  const result = await run(process.execPath, [
    generator,
    `--root=${repositoryRoot}`,
    `--output=${output}`,
    '--test-state=pass',
    '--run-id=11111111-1111-4111-8111-111111111111',
    `--run-started-at=${runStartedAt}`,
  ]).then(value => ({ code: 0, ...value })).catch(error => ({
    code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '',
  }))
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(await readFile(output, 'utf8'))
  const action = report.checks.find(check => check.id === 'real-desktop-action-loop')
  assert.equal(action?.state, 'pending_external')
  assert.match(action?.detail ?? '', /lifecycle.*外部.*AX.*\.app/iu)
  assert.equal(report.checks.find(check => check.id === 'desktop-update-policy')?.state, 'pass')
  assert.match(report.acceptanceImplementationSha256 ?? '', /^[a-f0-9]{64}$/u)
  assert.equal(report.acceptanceImplementationTrust, 'current-checkout-content-digest-not-cryptographic-attestation')
  const update = report.checks.find(check => check.id === 'desktop-update-policy')
  const configuration = await readFile(electronBuilderPath)
  assert.deepEqual(update?.evidence, {
    enabled: false,
    publish: null,
    configurationPath: 'apps/desktop-shell/electron-builder.yml',
    configurationSha256: createHash('sha256').update(configuration).digest('hex'),
  })

  // Static evidence is intentionally incomplete, but it must still satisfy
  // the verifier schema when the operator explicitly allows external pending.
  report.workingTreeDirty = false
  await writeFile(output, `${JSON.stringify(report)}\n`)
  const verified = await run(process.execPath, [verifier, '--allow-pending-external', output])
    .then(value => ({ code: 0, ...value }))
    .catch(error => ({ code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
  assert.equal(verified.code, 0, verified.stderr)
  assert.match(verified.stdout, /status=INCOMPLETE/u)
})

test('aggregate keeps the independent fixture pending as a diagnostic, not the final action verdict', async () => {
  const runId = '11111111-1111-4111-8111-111111111111'
  const runStartedAt = '2026-09-06T00:00:00.000Z'
  const component = {
    schemaVersion: 1,
    platform: 'macos',
    generatedAt: '2026-09-06T00:00:01.000Z',
    runId,
    runStartedAt,
    checks: [
      { id: 'screen-recording-permission', state: 'pass', detail: 'screen', evidence: {} },
      { id: 'accessibility-permission', state: 'pass', detail: 'ax', evidence: {} },
      {
        id: 'desktop-action-probe',
        state: 'pending_external',
        detail: 'fixture is not the packaged application',
        evidence: { probe: 'swift-fixture', packagedAppReceipt: false },
      },
    ],
  }

  const result = await runGenerator(component, runId, runStartedAt)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.report.checks.some(check => check.id === 'desktop-action-probe'), false)
  assert.equal(result.report.diagnostics.length, 1)
  assert.equal(result.report.diagnostics[0].id, 'desktop-action-probe')
  assert.equal(result.report.diagnostics[0].state, 'pending_external')
})

test('aggregate retains a failed fixture probe as a formal failure', async () => {
  const runId = '11111111-1111-4111-8111-111111111111'
  const runStartedAt = '2026-09-06T00:00:00.000Z'
  const component = {
    schemaVersion: 1,
    platform: 'macos',
    generatedAt: '2026-09-06T00:00:01.000Z',
    runId,
    runStartedAt,
    checks: [
      { id: 'screen-recording-permission', state: 'pass', detail: 'screen', evidence: {} },
      { id: 'accessibility-permission', state: 'pass', detail: 'ax', evidence: {} },
      { id: 'desktop-action-probe', state: 'fail', detail: 'probe failed', evidence: {} },
    ],
  }

  const result = await runGenerator(component, runId, runStartedAt)
  assert.equal(result.code, 1)
  assert.equal(result.report?.checks.find(check => check.id === 'desktop-action-probe')?.state, 'fail')
  assert.equal(result.report?.diagnostics.find(check => check.id === 'desktop-action-probe')?.state, 'fail')
})

test('formal macOS runner gives lifecycle the current verified source report', async () => {
  const source = await readFile(resolve(repositoryRoot, 'scripts/acceptance/macos-desktop.sh'), 'utf8')
  assert.match(
    source,
    /macos-app-lifecycle\.mjs"[^\n]*--app="\$APP"[^\n]*--runtime=packaged[^\n]*--source="\$SOURCE_REPORT"/u,
  )

  const signing = source.indexOf('"$XS_ROOT/scripts/acceptance/macos-signing-gate.mjs"')
  const finalSourceVerification = source.lastIndexOf('"$SOURCE_IDENTITY" verify')
  const lifecycle = source.indexOf('"$XS_ROOT/scripts/acceptance/macos-app-lifecycle.mjs"')
  const install = source.indexOf('"$XS_ROOT/scripts/acceptance/macos-install-uninstall.mjs"')
  for (const component of ['actions', 'signing', 'source', 'lifecycle', 'install']) {
    assert.match(source, new RegExp(`run_acceptance_component ${component} `, 'u'), `${component} must be fail-captured for aggregation`)
  }
  assert.ok(signing >= 0 && signing < finalSourceVerification, 'signing/notarization must finish before final source identity')
  assert.ok(finalSourceVerification < lifecycle, 'packaged lifecycle must run against the immutable final app materials')
  assert.ok(lifecycle < install, 'installation must consume the same final DMG after lifecycle acceptance')
  assert.match(source, /LAST_COMPONENT_SUCCEEDED=0[\s\S]*?if "\$@"; then LAST_COMPONENT_SUCCEEDED=1/u)
  assert.match(
    source,
    /run_acceptance_component source[^\n]*\n\s*if \[\[ "\$LAST_COMPONENT_SUCCEEDED" == "1" \]\]; then[\s\S]*?run_acceptance_component lifecycle[\s\S]*?run_acceptance_component install[\s\S]*?else[\s\S]*?lifecycle[^\n]*false[\s\S]*?install[^\n]*false/u,
    'a failed source identity must prevent launching or installing an unbound DMG',
  )
})
