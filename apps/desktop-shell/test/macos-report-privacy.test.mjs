import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import * as install from '../../../scripts/acceptance/macos-install-uninstall.mjs'

const execFileAsync = promisify(execFile)
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const productRoot = resolve(appRoot, '..', '..')
const DIGEST = 'a'.repeat(64)

test('install report projection removes build paths and arbitrary nested fields', () => {
  assert.equal(typeof install.contentFreeInstallEvidence, 'function')
  const projected = install.contentFreeInstallEvidence({
    dmgPath: '/Users/private-builder/secret-workspace/Xiaoshe.dmg',
    dmgSha256: DIGEST,
    mountedApp: '小蛇.app',
    installPath: '/Applications/小蛇.app',
    sourceManifest: { digest: DIGEST, entries: 20, files: 14, bytes: 32768 },
    installedManifest: { digest: DIGEST, entries: 20, files: 14, bytes: 32768 },
    lifecycle: {
      applicationRole: 'installed-application',
      appPath: '/Applications/小蛇.app',
      userData: '/var/folders/private-user-data',
      bundleId: 'com.xiaoshe.desktop',
      bundleExecutable: '小蛇',
      primaryPid: 41,
      secondPid: 42,
      primaryExitCode: 0,
      secondExitCode: 0,
      port: 43180,
      status: { product: '小蛇', version: '0.2.0', bridge: 'ready', platform: 'darwin' },
      window: { processName: '小蛇', count: 1, title: 'private conversation title' },
      startupEvents: ['boot-started', 'ui-ready'],
      runtime: { markerSchemaVersion: 3, fingerprintVerified: true, matchesPackagedRuntime: true, fingerprint: DIGEST },
      portReleased: true,
      serviceReleased: true,
    },
    applicationRemoved: true,
    mountReleased: true,
    userDataRetainedAtUninstall: true,
    userDataPolicy: 'retain',
    secret: 'omit-me',
  })

  assert.equal(projected.dmgRole, 'final-release-dmg')
  assert.equal(projected.dmgPath, undefined)
  assert.equal(projected.lifecycle.appPath, undefined)
  assert.doesNotMatch(JSON.stringify(projected), /private-builder|secret-workspace|private-user|private conversation|omit-me/u)
})

test('install failure report hashes diagnostics instead of persisting stderr or paths', () => {
  assert.equal(typeof install.installFailureCheck, 'function')
  const check = install.installFailureCheck(new Error('stderr API_TOKEN=secret at /Users/private-builder/workspace'))

  assert.equal(check.state, 'fail')
  assert.equal(check.evidence.stage, 'install-uninstall')
  assert.match(check.evidence.diagnosticSha256, /^[a-f0-9]{64}$/u)
  assert.doesNotMatch(JSON.stringify(check), /API_TOKEN|private-builder|workspace/u)
})

test('install report projection rejects a caller-selected local path', () => {
  assert.throws(
    () => install.contentFreeInstallEvidence({
      installPath: '/Users/private-builder/secret-target.app',
      lifecycle: { applicationRole: 'installed-application' },
    }),
    /exact.*application target|application target.*exact/iu,
  )
})

test('signing producer is import-safe and projects pending and failure evidence without profile or paths', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'xiaoshe-signing-privacy-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const privateRoot = join(scratch, 'private-builder-secret-workspace')
  await mkdir(join(privateRoot, 'apps', 'desktop-shell'), { recursive: true })
  await writeFile(join(privateRoot, 'apps', 'desktop-shell', 'package.json'), '{"version":"0.2.0"}\n')
  const output = join(scratch, 'side-effect-report.json')
  const modulePath = resolve(productRoot, 'scripts', 'acceptance', 'macos-signing-gate.mjs')
  const program = `
    process.argv = [process.execPath, 'privacy-test', ${JSON.stringify(`--root=${privateRoot}`)}, ${JSON.stringify(`--output=${output}`)}]
    process.env.XIAOSHE_NOTARY_PROFILE = 'private-keychain-profile'
    const gate = await import(${JSON.stringify(`${pathToFileURL(modulePath).href}?privacy=${Date.now()}`)})
    if (typeof gate.pendingSigningCheck !== 'function' || typeof gate.signingFailureCheck !== 'function') process.exit(9)
    const pending = gate.pendingSigningCheck({
      validDeveloperIdIdentities: 1,
      notaryProfileAvailable: false,
      currentArtifact: { developerId: false, adHoc: true, teamIdentifierPresent: false, strictCodesignValid: true, gatekeeperAccepted: false },
    })
    const failure = gate.signingFailureCheck(new Error('API_TOKEN=secret at /Users/private-builder/workspace'))
    process.stdout.write('PRIVACY=' + JSON.stringify({ pending, failure }))
  `
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: productRoot,
    windowsHide: true,
  })
  const marker = stdout.lastIndexOf('PRIVACY=')
  assert.ok(marker >= 0)
  const result = JSON.parse(stdout.slice(marker + 'PRIVACY='.length))

  assert.equal(result.pending.state, 'pending_external')
  assert.equal(result.pending.evidence.releaseGateRole, 'developer-id-notarization')
  assert.equal(result.failure.evidence.stage, 'signing-notarization')
  assert.match(result.failure.evidence.diagnosticSha256, /^[a-f0-9]{64}$/u)
  assert.doesNotMatch(JSON.stringify(result), /private-keychain-profile|private-builder|API_TOKEN|workspace/u)
})
