#!/usr/bin/env node
/** Mount, install, run, and remove a Xiaoshe DMG without touching prior apps. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runMacosAppLifecycle } from './macos-app-lifecycle.mjs'

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

async function bundleManifest(root) {
  const entries = []
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const stat = await lstat(path)
      const key = relative(root, path).normalize('NFC')
      if (stat.isDirectory()) {
        entries.push({ key, type: 'directory', mode: stat.mode & 0o777 })
        await walk(path)
      } else if (stat.isSymbolicLink()) {
        entries.push({ key, type: 'symlink', target: await readlink(path) })
      } else if (stat.isFile()) {
        entries.push({ key, type: 'file', mode: stat.mode & 0o777, bytes: stat.size, sha256: await sha256File(path) })
      } else {
        throw new Error(`unsupported application bundle entry: ${key}`)
      }
    }
  }
  await walk(root)
  const payload = JSON.stringify(entries)
  return {
    digest: createHash('sha256').update(payload).digest('hex'),
    entries: entries.length,
    files: entries.filter(entry => entry.type === 'file').length,
    bytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
  }
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
  let installedByThisRun = false
  let retainedUserData
  let operationError
  try {
    command('/usr/bin/hdiutil', ['verify', dmgPath], { timeout: 180_000 })
    command('/usr/bin/hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountPoint], { timeout: 180_000 })
    attached = true
    const candidates = (await readdir(mountPoint)).filter(name => name.endsWith('.app'))
    if (candidates.length !== 1) throw new Error(`DMG must contain exactly one .app; found ${candidates.length}`)
    const mountedApp = join(mountPoint, candidates[0])
    const sourceManifest = await bundleManifest(mountedApp)

    command('/usr/bin/ditto', [mountedApp, installPath], { timeout: 180_000 })
    installedByThisRun = true
    const installedManifest = await bundleManifest(installPath)
    if (sourceManifest.digest !== installedManifest.digest) throw new Error('installed application bundle differs from the mounted DMG source')

    const lifecycle = await runMacosAppLifecycle({ root, appPath: installPath, keepUserData: true, usePackagedRuntime: true })
    retainedUserData = lifecycle.userData
    await rm(installPath, { recursive: true, force: false })
    installedByThisRun = false
    if (await exists(installPath)) throw new Error('application target still exists after uninstall')
    const retainedLog = join(retainedUserData, 'logs', 'desktop-shell.jsonl')
    const retainedAtUninstall = await exists(retainedLog) && (await readFile(retainedLog, 'utf8')).includes('service-ready')
    if (!retainedAtUninstall) throw new Error('isolated per-user lifecycle evidence was not retained when the app was removed')

    command('/usr/bin/hdiutil', ['detach', mountPoint], { timeout: 60_000 })
    attached = false

    return {
      dmgPath,
      dmgSha256: await sha256File(dmgPath),
      mountedApp: basename(mountedApp),
      installPath,
      sourceManifest,
      installedManifest,
      lifecycle: { ...lifecycle, userData: undefined },
      applicationRemoved: true,
      mountReleased: true,
      userDataRetainedAtUninstall: true,
      userDataPolicy: 'retain',
    }
  } catch (error) {
    operationError = error
    throw error
  } finally {
    if (installedByThisRun && await exists(installPath)) await rm(installPath, { recursive: true, force: false })
    let detachError
    if (attached) {
      const detach = spawnSync('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], { encoding: 'utf8', timeout: 60_000 })
      if (detach.error || detach.status !== 0) {
        detachError = detach.error ?? new Error(`hdiutil forced detach exited ${detach.status}: ${String(detach.stderr ?? '').slice(-3000)}`)
      }
    }
    await rm(mountPoint, { recursive: true, force: true })
    if (retainedUserData && retainedUserData.startsWith(join(tmpdir(), 'xiaoshe-desktop-lifecycle-'))) {
      await rm(retainedUserData, { recursive: true, force: true })
    }
    if (detachError) {
      if (operationError) throw new AggregateError([operationError, detachError], 'install acceptance and DMG cleanup both failed')
      throw detachError
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
    check = { id: 'macos-install-uninstall', state: 'fail', detail: error instanceof Error ? error.message : String(error), evidence: { dmgPath } }
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify({ schemaVersion: 1, platform: 'macos', generatedAt: new Date().toISOString(), checks: [check] }, null, 2)}\n`)
  process.stdout.write(`macOS install/uninstall: ${output}\n`)
  if (check.state === 'fail') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
