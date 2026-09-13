#!/usr/bin/env node
/** Mount, install, run, and remove a Xiaoshe DMG without touching prior apps. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applicationBundleManifest } from '../../apps/desktop-shell/scripts/verify-artifact.mjs'
import { contentFreeFailureEvidence, contentFreeLifecycleEvidence, runLifecycleCleanup, runMacosAppLifecycle } from './macos-app-lifecycle.mjs'
import { acceptanceRunMetadataFromEnvironment } from './macos-acceptance-run.mjs'

function parseArgs(argv) {
  return new Map(argv.map(value => {
    const separator = value.indexOf('=')
    if (!value.startsWith('--') || separator < 3) throw new Error(`invalid argument: ${value}`)
    return [value.slice(2, separator), value.slice(separator + 1)]
  }))
}

async function exists(path) {
  try { await access(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

function command(commandPath, argv, options = {}) {
  const result = spawnSync(commandPath, argv, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${basename(commandPath)} ${argv[0] ?? ''} exited ${result.status}: ${String(result.stderr ?? '').slice(-3000)}`)
  }
  return result
}

async function sha256File(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })
}

function manifestEvidence(value) {
  return Object.freeze({
    digest: value?.digest,
    entries: value?.entries,
    files: value?.files,
    bytes: value?.bytes,
  })
}

/** Allowlist install facts before persisting the acceptance artifact. */
export function contentFreeInstallEvidence(evidence) {
  if (evidence?.installPath !== '/Applications/小蛇.app') {
    throw new Error('install evidence requires the exact Xiaoshe application target')
  }
  return Object.freeze({
    dmgRole: 'final-release-dmg',
    dmgSha256: evidence?.dmgSha256,
    mountedApplicationRole: 'dmg-application',
    installedApplicationRole: 'installed-application',
    installPath: evidence?.installPath,
    sourceManifest: manifestEvidence(evidence?.sourceManifest),
    installedManifest: manifestEvidence(evidence?.installedManifest),
    lifecycle: contentFreeLifecycleEvidence(evidence?.lifecycle),
    applicationRemoved: evidence?.applicationRemoved,
    mountReleased: evidence?.mountReleased,
    userDataRetainedAtUninstall: evidence?.userDataRetainedAtUninstall,
    userDataPolicy: evidence?.userDataPolicy,
  })
}

/** Build one durable failure check without stderr, paths, or environment data. */
export function installFailureCheck(error) {
  return Object.freeze({
    id: 'macos-install-uninstall',
    state: 'fail',
    detail: 'macOS install/uninstall verification failed; sensitive diagnostics omitted.',
    evidence: { dmgRole: 'final-release-dmg', ...contentFreeFailureEvidence('install-uninstall', error) },
  })
}

/** Claim a previously absent target before ditto can merge into it. */
export async function reserveInstallDirectory(path) {
  const target = resolve(path)
  if (await realpath(dirname(target)) !== dirname(target)) throw new Error('install target parent must be canonical')
  // mkdir is exclusive for directories, files and even dangling symlinks. A
  // check-then-copy alone could overwrite an app created after the preflight.
  await mkdir(target, { mode: 0o700 })
  const stat = await lstat(target, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('new install target was replaced before ownership could be recorded')
  return Object.freeze({ path: target, device: stat.dev, inode: stat.ino })
}

/** Refuse to launch or remove a directory substituted for this run's target. */
export async function assertOwnedInstallDirectory(owned) {
  if (!owned || typeof owned.path !== 'string' || resolve(owned.path) !== owned.path
    || typeof owned.device !== 'bigint' || typeof owned.inode !== 'bigint') throw new Error('install ownership is unavailable')
  const stat = await lstat(owned.path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owned.device || stat.ino !== owned.inode
    || await realpath(owned.path) !== owned.path) throw new Error('install target ownership changed; replacement retained')
}

export async function removeOwnedInstallDirectory(owned) {
  try { await assertOwnedInstallDirectory(owned) } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  await rm(owned.path, { recursive: true, force: false })
}

export async function runInstallUninstall({ root, dmgPath, installPath = '/Applications/小蛇.app' }) {
  if (process.platform !== 'darwin') throw new Error('macOS install acceptance requires Darwin')
  root = resolve(root)
  dmgPath = resolve(dmgPath)
  installPath = resolve(installPath)
  if (installPath !== '/Applications/小蛇.app') throw new Error('install acceptance only permits the exact Xiaoshe application target')
  if (await exists(installPath)) throw new Error(`${installPath} already existed; refusing to overwrite a user installation`)
  const mountPoint = await mkdtemp(join(tmpdir(), 'xiaoshe-dmg-mount-'))
  let attached = false
  let ownedInstall
  let retainedUserData
  let operationError
  try {
    command('/usr/bin/hdiutil', ['verify', dmgPath], { timeout: 180_000 })
    command('/usr/bin/hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountPoint], { timeout: 180_000 })
    attached = true
    const candidates = (await readdir(mountPoint)).filter(name => name.endsWith('.app'))
    if (candidates.length !== 1) throw new Error(`DMG must contain exactly one .app; found ${candidates.length}`)
    const mountedApp = join(mountPoint, candidates[0])
    const sourceManifest = await applicationBundleManifest(mountedApp)

    // Record ownership before copying so a partial ditto failure is also
    // cleaned, but never delete a subsequently substituted user installation.
    ownedInstall = await reserveInstallDirectory(installPath)
    command('/usr/bin/ditto', [mountedApp, installPath], { timeout: 180_000 })
    await assertOwnedInstallDirectory(ownedInstall)
    const installedManifest = await applicationBundleManifest(installPath)
    if (sourceManifest.digest !== installedManifest.digest) throw new Error('installed application bundle differs from the mounted DMG source')

    const lifecycle = await runMacosAppLifecycle({
      root,
      appPath: installPath,
      applicationRole: 'installed-application',
      keepUserData: true,
      usePackagedRuntime: true,
    })
    retainedUserData = lifecycle.userData
    await removeOwnedInstallDirectory(ownedInstall)
    ownedInstall = undefined
    if (await exists(installPath)) throw new Error('application target still exists after uninstall')
    const retainedLog = join(retainedUserData, 'logs', 'desktop-shell.jsonl')
    const retainedAtUninstall = await exists(retainedLog) && (await readFile(retainedLog, 'utf8')).includes('service-ready')
    if (!retainedAtUninstall) throw new Error('isolated per-user lifecycle evidence was not retained when the app was removed')

    command('/usr/bin/hdiutil', ['detach', mountPoint], { timeout: 60_000 })
    attached = false

    return contentFreeInstallEvidence({
      dmgPath,
      dmgSha256: await sha256File(dmgPath),
      mountedApp: basename(mountedApp),
      installPath,
      sourceManifest,
      installedManifest,
      lifecycle,
      applicationRemoved: true,
      mountReleased: true,
      userDataRetainedAtUninstall: true,
      userDataPolicy: 'retain',
    })
  } catch (error) {
    operationError = error
    throw error
  } finally {
    try {
      await runLifecycleCleanup([
        ['installed application cleanup', async () => {
          if (!ownedInstall) return
          await removeOwnedInstallDirectory(ownedInstall)
          if (await exists(installPath)) throw new Error('installed application still exists')
        }],
        ['DMG detach cleanup (hdiutil forced detach)', async () => {
          if (!attached) return
          command('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], { timeout: 60_000 })
          attached = false
        }],
        ['mount directory cleanup', () => rm(mountPoint, { recursive: true, force: true })],
        ['retained lifecycle data cleanup', async () => {
          if (!retainedUserData) return
          const retained = resolve(retainedUserData)
          if (dirname(retained) !== resolve(tmpdir()) || !basename(retained).startsWith('xiaoshe-desktop-lifecycle-')) {
            throw new Error(`refusing to remove unexpected lifecycle data path: ${retained}`)
          }
          await rm(retained, { recursive: true, force: true })
        }],
      ])
    } catch (cleanupError) {
      if (operationError) {
        const failures = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError]
        throw new AggregateError([operationError, ...failures], 'install acceptance and cleanup failed')
      }
      throw cleanupError
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = resolve(args.get('root') || process.cwd())
  const desktopPackage = JSON.parse(await readFile(join(root, 'apps', 'desktop-shell', 'package.json'), 'utf8'))
  const dmgPath = resolve(args.get('dmg') || join(root, 'apps', 'desktop-shell', 'dist-desktop', `Xiaoshe-${desktopPackage.version}-arm64.dmg`))
  const output = resolve(args.get('output') || join(root, 'artifacts', 'acceptance', 'macos-install-uninstall.json'))
  let check
  try {
    const evidence = await runInstallUninstall({ root, dmgPath })
    check = {
      id: 'macos-install-uninstall',
      state: 'pass',
      detail: 'DMG 校验、只读挂载、应用复制、安装后启动、卸载与用户数据保留策略均已在本机真实验证。',
      evidence,
    }
  } catch (error) {
    check = installFailureCheck(error)
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify({ schemaVersion: 1, platform: 'macos', generatedAt: new Date().toISOString(), ...acceptanceRunMetadataFromEnvironment(), checks: [check] }, null, 2)}\n`)
  process.stdout.write(`macOS install/uninstall: ${output}\n`)
  if (check.state === 'fail') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
