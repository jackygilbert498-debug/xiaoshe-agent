#!/usr/bin/env node
/** Conditional Developer ID + notarization gate with explicit external blockers. */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

function parseArgs(argv) {
  return new Map(argv.map(value => {
    const separator = value.indexOf('=')
    if (!value.startsWith('--') || separator < 3) throw new Error(`invalid argument: ${value}`)
    return [value.slice(2, separator), value.slice(separator + 1)]
  }))
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', timeout: options.timeout ?? 60_000, maxBuffer: 8 * 1024 * 1024, ...options })
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    error: result.error,
  }
}

function signingIdentities() {
  const result = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])
  if (result.error) throw result.error
  return [...result.stdout.matchAll(/"(Developer ID Application:[^"]+)"/gu)].map(match => match[1])
}

function existingSignature(appPath) {
  const display = run('/usr/bin/codesign', ['-dv', '--verbose=4', appPath])
  const verify = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath])
  const gatekeeper = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
  const output = `${display.stdout}\n${display.stderr}`
  return {
    developerId: /Authority=Developer ID Application:/u.test(output),
    adHoc: /Signature=adhoc/u.test(output),
    teamIdentifierPresent: /TeamIdentifier=(?!not set)[^\s]+/u.test(output),
    strictCodesignValid: verify.status === 0,
    gatekeeperAccepted: gatekeeper.status === 0,
  }
}

const args = parseArgs(process.argv.slice(2))
const root = resolve(args.get('root') || process.cwd())
const appPath = resolve(args.get('app') || join(root, 'apps', 'desktop-shell', 'dist-desktop', 'mac-arm64', '小蛇.app'))
const desktopPackage = JSON.parse(await readFile(join(root, 'apps', 'desktop-shell', 'package.json'), 'utf8'))
const dmgPath = resolve(args.get('dmg') || join(root, 'apps', 'desktop-shell', 'dist-desktop', `Xiaoshe-${desktopPackage.version}-arm64.dmg`))
const output = resolve(args.get('output') || join(root, 'artifacts', 'acceptance', 'macos-signing-notarization.json'))
const profile = process.env.XIAOSHE_NOTARY_PROFILE?.trim() || 'xiaoshe-notary'
let check

try {
  if (process.platform !== 'darwin') throw new Error('macOS signing acceptance requires Darwin')
  const identities = signingIdentities()
  const profileCheck = run('/usr/bin/xcrun', ['notarytool', 'history', '--keychain-profile', profile, '--output-format', 'json'], { timeout: 30_000 })
  if (identities.length === 0 || profileCheck.status !== 0) {
    check = {
      id: 'macos-signing-and-notarization',
      state: 'pending_external',
      detail: identities.length === 0
        ? '本机钥匙串没有有效 Developer ID Application 证书；不能真实签名或向 Apple 提交公证。'
        : `Developer ID 已存在，但公证钥匙串 Profile「${profile}」不可用。`,
      evidence: {
        validDeveloperIdIdentities: identities.length,
        notaryProfileAvailable: profileCheck.status === 0,
        currentArtifact: existingSignature(appPath),
        releaseGate: join(root, 'scripts', 'release', 'sign-notarize-macos.sh'),
      },
    }
  } else {
    const release = run('/bin/bash', [join(root, 'scripts', 'release', 'sign-notarize-macos.sh'), `--identity=${identities[0]}`, `--notary-profile=${profile}`, `--app=${appPath}`, `--dmg=${dmgPath}`], { cwd: root, timeout: 45 * 60_000 })
    if (release.error) throw release.error
    if (release.status !== 0) throw new Error(`release signing gate exited ${release.status}: ${release.stderr.slice(-3000)}`)
    const appVerify = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath])
    const appStaple = run('/usr/bin/xcrun', ['stapler', 'validate', appPath])
    const dmgStaple = run('/usr/bin/xcrun', ['stapler', 'validate', dmgPath])
    const appGatekeeper = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
    const dmgGatekeeper = run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmgPath])
    if ([appVerify, appStaple, dmgStaple, appGatekeeper, dmgGatekeeper].some(result => result.status !== 0)) throw new Error('post-signing codesign, stapler, or Gatekeeper verification failed')
    check = {
      id: 'macos-signing-and-notarization',
      state: 'pass',
      detail: '应用与 DMG 已使用 Developer ID 签名、经 Apple 公证并装订，且通过 codesign、stapler 与 Gatekeeper。',
      evidence: { developerId: true, notarizedApp: true, notarizedDmg: true, gatekeeperApp: true, gatekeeperDmg: true },
    }
  }
} catch (error) {
  check = { id: 'macos-signing-and-notarization', state: 'fail', detail: error instanceof Error ? error.message : String(error), evidence: {} }
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify({ schemaVersion: 1, platform: 'macos', generatedAt: new Date().toISOString(), checks: [check] }, null, 2)}\n`)
process.stdout.write(`macOS signing/notarization: ${output}\n`)
if (check.state === 'fail') process.exitCode = 1
