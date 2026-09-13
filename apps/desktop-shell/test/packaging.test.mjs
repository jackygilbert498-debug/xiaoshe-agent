import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const productRoot = resolve(appRoot, '..', '..')

test('desktop long-running suite includes the portable macOS runtime marker contract', async () => {
  const manifest = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf8'))
  assert.match(manifest.scripts.test, /macos-app-lifecycle\.test\.mjs/u)
})

test('release targets only architectures covered by real-device acceptance', async () => {
  const configuration = await readFile(resolve(appRoot, 'electron-builder.yml'), 'utf8')
  const windows = configuration.slice(configuration.indexOf('\nwin:'), configuration.indexOf('\nnsis:'))
  const macos = configuration.slice(configuration.indexOf('\nmac:'), configuration.indexOf('\npublish:'))
  assert.match(windows, /arch:\s*\[x64\]/u)
  assert.doesNotMatch(windows, /arm64/u)
  assert.match(macos, /arch:\s*\[arm64\]/u)
  assert.doesNotMatch(macos, /x64/u)
})

test('Windows package completion creates a release manifest without a manual verifier command', async () => {
  const configuration = await readFile(resolve(appRoot, 'electron-builder.yml'), 'utf8')
  assert.match(configuration, /afterAllArtifactBuild:\s*\.\/scripts\/verify-artifact\.mjs/u)
})

test('native shell reports failed owned shutdown instead of claiming a normal quit', async () => {
  const main = await readFile(resolve(appRoot, 'src', 'main.mjs'), 'utf8')
  assert.match(main, /shutdownOwnedProduct/u)
  assert.ok((main.match(/shutdownOwnedProduct\(/gu) ?? []).length >= 2, 'boot failure and normal quit must share aggregate cleanup')
  assert.match(main, /shutdown-failed/u)
  assert.match(main, /app\.exit\(1\)/u)
  assert.doesNotMatch(main, /controller\.stopOwned\(\)\)\.finally\(\(\) => app\.quit\(\)\)/u)
})

test('macOS packaged acceptance cleans the owned runtime by root and token and verifies release', async () => {
  const lifecycle = await readFile(resolve(productRoot, 'scripts', 'acceptance', 'macos-app-lifecycle.mjs'), 'utf8')
  const main = await readFile(resolve(appRoot, 'src', 'main.mjs'), 'utf8')
  assert.match(main, /XIAOSHE_DESKTOP_ACCEPTANCE[\s\S]+XIAOSHE_LAUNCH_TOKEN[\s\S]+ownershipToken/su)
  assert.match(lifecycle, /const ownershipToken = randomUUID\(\)/u)
  assert.match(lifecycle, /environment\.XIAOSHE_LAUNCH_TOKEN = ownershipToken/u)
  assert.match(lifecycle, /ownedRuntimeRoot/u)
  assert.match(lifecycle, /ownedRuntimeRoot = usePackagedRuntime \? await findOwnedRuntimeRoot\(userData\) : root/u)
  assert.doesNotMatch(lifecycle, /ownedRuntimeRoot = usePackagedRuntime \? join\(userData,[^\r\n]+health\.version/u)
  assert.match(lifecycle, /stopOwnedService\(ownedRuntimeRoot, port, environment, ownershipToken\)/u)
  assert.match(lifecycle, /owned service port release/u)
  assert.match(lifecycle, /owned launchd service release/u)
  assert.match(lifecycle, /runLifecycleCleanup/u)
})

test('macOS install acceptance cannot skip detach and temporary cleanup after an earlier failure', async () => {
  const install = await readFile(resolve(productRoot, 'scripts', 'acceptance', 'macos-install-uninstall.mjs'), 'utf8')
  assert.match(install, /runLifecycleCleanup/u)
  assert.match(install, /installed application cleanup/u)
  assert.match(install, /DMG detach cleanup/u)
  assert.match(install, /mount directory cleanup/u)
  assert.match(install, /retained lifecycle data cleanup/u)
})

function pngDimensions(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'asset must be a PNG')
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR', 'PNG must contain IHDR first')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('packaged product contains every root source input required by first-device build', async () => {
  const configuration = await readFile(resolve(appRoot, 'electron-builder.yml'), 'utf8')
  for (const destination of [
    'product/src',
    'product/tsconfig.build.json',
    'product/README.md',
  ]) {
    assert.match(configuration, new RegExp(`to:\\s+${destination.replaceAll('.', '\\.')}\\s*(?:\\r?\\n|$)`, 'u'), `missing ${destination}`)
  }
})

test('macOS Profile validation and repair include the required DSH HTTP fetch provider', async () => {
  const launcher = await readFile(resolve(productRoot, 'scripts', 'start-xiaoshe-web.sh'), 'utf8')
  assert.match(launcher, /@deepseek-ai\/dsh-web-fetch-http\|\$DSH_ROOT\/packages\/web\/web-fetch-http/u)
  assert.match(launcher, /"\$DSH_ROOT\/packages\/web\/web-fetch-http"/u)
  assert.match(launcher, /@xiaoshe\/agent-experience\|\$PLUGIN_ROOT\/packages\/agent-experience/u)
  assert.match(launcher, /"\$PLUGIN_ROOT\/packages\/agent-experience"/u)
  assert.ok(launcher.lastIndexOf('XIAOSHE_RUNTIME_IDENTITY="$($NODE "$IDENTITY_HELPER"') > launcher.lastIndexOf("run build"), 'macOS identity must be recalculated after the final build')
})

test('both platform installers explicitly install agent-experience into the Profile graph', async () => {
  const mac = await readFile(resolve(productRoot, 'setup', 'install-macos.sh'), 'utf8')
  const windows = await readFile(resolve(productRoot, 'setup', 'install-windows.ps1'), 'utf8')
  assert.match(mac, /require_file "\$XS_ROOT\/packages\/agent-experience\/package\.json"/u)
  assert.match(mac, /"\$XS_ROOT\/packages\/agent-experience"/u)
  assert.match(windows, /Require-File \(Join-Path \$XsRoot 'packages\\agent-experience\\package\.json'\)/u)
  assert.match(windows, /Join-Path \$XsRoot 'packages\\agent-experience'/u)
  const lifecycle = await readFile(resolve(appRoot, 'src', 'lifecycle.mjs'), 'utf8')
  assert.match(lifecycle, /'packages\/agent-experience\/package\.json'/u)
})

test('platform lifecycle binds compensation to a persisted launch ownership token', async () => {
  const root = resolve(appRoot, '..', '..')
  const windowsStart = await readFile(resolve(root, '启动小蛇.ps1'), 'utf8')
  const windowsStop = await readFile(resolve(root, '停止小蛇.ps1'), 'utf8')
  const owner = await readFile(resolve(root, 'scripts', 'windows-process-owner.mjs'), 'utf8')
  const lease = await readFile(resolve(root, 'scripts', 'lifecycle-lease.mjs'), 'utf8')
  const macStart = await readFile(resolve(root, 'scripts', 'start-xiaoshe-web.sh'), 'utf8')
  const macStop = await readFile(resolve(root, 'scripts', 'stop-xiaoshe-web.sh'), 'utf8')
  assert.match(windowsStart, /ownershipToken.*LaunchToken/isu)
  assert.match(windowsStart, /XIAOSHE_LAUNCH_TOKEN/u)
  assert.match(windowsStart, /\$ProcessHolder[\s\S]+try \{[\s\S]+Invoke-XiaosheWithProxyEnvironment[\s\S]+Start-Process/su)
  assert.match(windowsStart, /taskkill\.exe[\s\S]+for \(\$CleanupAttempt[\s\S]+Get-CimInstance Win32_Process[\s\S]+CleanupFailure/su)
  assert.match(windowsStart, /OwnerHelper remove --path \$StatePath --expected-pid \$Process\.Id --expected-token \$LaunchToken/u)
  assert.match(windowsStop, /Get-CimInstance Win32_Process[\s\S]+所有权状态已保留/su)
  assert.match(windowsStop, /--expected-token/u)
  assert.match(windowsStop, /OwnershipToken/u)
  assert.match(windowsStop, /State\.ownershipToken\s+-ne\s+\$OwnershipToken/u)
  assert.match(owner, /ownershipToken/u)
  assert.match(windowsStart, /lifecycle-lease\.mjs/u)
  assert.match(windowsStart, /acquire --path \$LeasePath --pid \$PID/u)
  assert.match(windowsStart, /release --path \$LeasePath --token \$LifecycleLeaseToken/u)
  assert.match(windowsStart, /\$EarlyState\.xsRoot -eq \$XsRoot[\s\S]+\$EarlyState\.dshRoot -eq \$DshRoot/su)
  assert.match(windowsStop, /check --path \$LeasePath --pid \$LifecycleLeasePid --token \$LifecycleLeaseToken/u)
  assert.match(lease, /process\.kill\(pid, 0\)/u)
  assert.match(macStart, /XIAOSHE_LAUNCH_TOKEN/u)
  assert.match(macStart, /"XIAOSHE_LAUNCH_TOKEN=\$LAUNCH_TOKEN"/u)
  assert.match(macStart, /OWNED_LAUNCH_ACTIVE=1\s+launchctl submit/u)
  assert.match(macStart, /if \[ "\$code" -ne 0 \] && \[ "\$OWNED_LAUNCH_ACTIVE" = 1 \]; then[\s\S]+if \[ "\$OWNERSHIP_REPORT" = 0 \]; then[\s\S]+remove_service "\$\{LAUNCH_TOKEN:-\}"/su)
  const readyBlock = macStart.slice(macStart.lastIndexOf('if is_xiaoshe_ready; then'), macStart.lastIndexOf('exit 0') + 'exit 0'.length)
  assert.ok(readyBlock.indexOf('report_ownership started') < readyBlock.indexOf('release_lifecycle_lease'))
  assert.ok(readyBlock.indexOf('release_lifecycle_lease') < readyBlock.indexOf('OWNED_LAUNCH_ACTIVE=0'))
  assert.match(macStop, /--ownership-token/u)
  assert.match(macStop, /service_has_environment "\$SERVICE" XIAOSHE_LAUNCH_TOKEN "\$OWNERSHIP_TOKEN"/u)
  assert.match(macStop, /"\$key => \$value"/u, 'launchctl print uses arrow-form environment entries')
})

test('both platform launchers hold one pid-and-token lifecycle lease across nested stop', async () => {
  const windowsStart = await readFile(resolve(productRoot, '启动小蛇.ps1'), 'utf8')
  const windowsStop = await readFile(resolve(productRoot, '停止小蛇.ps1'), 'utf8')
  const windowsEntry = await readFile(resolve(productRoot, 'scripts', 'windows-stop-entry.ps1'), 'utf8')
  const macStart = await readFile(resolve(productRoot, 'scripts', 'start-xiaoshe-web.sh'), 'utf8')
  const macStop = await readFile(resolve(productRoot, 'scripts', 'stop-xiaoshe-web.sh'), 'utf8')
  assert.match(windowsStart, /-LifecycleLeaseToken \$LifecycleLeaseToken -LifecycleLeasePid \$PID/u)
  assert.match(windowsStop, /check --path \$LeasePath --pid \$LifecycleLeasePid --token \$LifecycleLeaseToken/u)
  assert.match(windowsEntry, /LifecycleLeasePid/u)
  assert.match(macStart, /lifecycle-lease\.mjs/u)
  assert.match(macStart, /acquire.*--pid "\$\$".*--wait-ms 15000/u)
  assert.match(macStart, /--lifecycle-lease-token "\$LIFECYCLE_LEASE_TOKEN" --lifecycle-lease-pid "\$\$"/u)
  assert.match(macStop, /check.*--pid "\$LIFECYCLE_LEASE_PID".*--token "\$LIFECYCLE_LEASE_TOKEN"/u)
})

test('macOS stop refuses ambiguous ownership and launch fast-path precedes mutation', async () => {
  const start = await readFile(resolve(productRoot, 'scripts', 'start-xiaoshe-web.sh'), 'utf8')
  const stop = await readFile(resolve(productRoot, 'scripts', 'stop-xiaoshe-web.sh'), 'utf8')
  assert.match(stop, /XIAOSHE_PRODUCT_ROOT/u)
  assert.match(stop, /XIAOSHE_DSH_ROOT/u)
  assert.match(stop, /ownership token mismatch|所有权令牌不匹配/u)
  assert.match(stop, /launchctl print failed|无法读取 launchd/u)
  assert.doesNotMatch(stop, /SERVICE="\$\(launchctl print[^\r\n]*\|\| true/u)
  assert.ok(start.indexOf('# FAST_REUSE') < start.indexOf('if ! profile_has_current_product_packages'))
  assert.ok(start.indexOf('# FAST_REUSE') < start.indexOf("run build"))
})

test('installers validate real Python and preserve environment and bounded backups', async () => {
  const windows = await readFile(resolve(productRoot, 'setup', 'install-windows.ps1'), 'utf8')
  const mac = await readFile(resolve(productRoot, 'setup', 'install-macos.sh'), 'utf8')
  assert.match(windows, /sys\.version_info\s*>=\s*\(3,\s*10\)/u)
  assert.match(windows, /WindowsApps/iu)
  assert.match(windows, /SavedPath/u)
  assert.match(windows, /HadCI/u)
  assert.match(windows, /finally[\s\S]+env:Path[\s\S]+Env:\\CI/su)
  assert.match(mac, /sys\.version_info\s*>=\s*\(3,\s*10\)/u)
  assert.match(mac, /XIAOSHE_PYTHON/u)
  assert.match(mac, /mktemp -d/u)
  assert.match(mac, /\/usr\/bin\/rsync[\s\S]*--exclude ['"]node_modules\/['"]/u)
  assert.doesNotMatch(mac, /ditto\s+--exclude/u)
})

test('first-device installers keep the full desktop suite behind an explicit developer gate', async () => {
  const windows = await readFile(resolve(productRoot, 'setup', 'install-windows.ps1'), 'utf8')
  const mac = await readFile(resolve(productRoot, 'setup', 'install-macos.sh'), 'utf8')
  assert.match(windows, /param\([^)]*\[switch\]\$RunDeveloperValidation[^)]*\)/su)
  assert.match(
    windows,
    /if \(\$RunDeveloperValidation[^)]*\)[\s\S]*?--filter '@xiaoshe\/desktop-shell' test/su,
    'the expensive desktop suite must remain available only as an explicit developer validation',
  )

  const guard = windows.indexOf('if ($RunDeveloperValidation')
  const desktopTest = windows.indexOf("--filter '@xiaoshe/desktop-shell' test")
  const profileInstall = windows.indexOf("dsh plugin --profile web add")
  assert.ok(guard >= 0 && guard < desktopTest, 'desktop validation must be inside the explicit guard')
  assert.ok(desktopTest < profileInstall, 'developer source validation must remain distinct from installed Profile validation')

  assert.match(mac, /--run-developer-validation/u)
  assert.match(mac, /if \[ "\$RUN_DEVELOPER_VALIDATION" = 1 \]; then[\s\S]*?--filter '@xiaoshe\/desktop-shell' test/su)
})

test('macOS check-only developer validation fails closed when the desktop package is absent', async t => {
  const bash = process.env.XIAOSHE_TEST_BASH
    ?? (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash')
  if (!existsSync(bash)) {
    t.skip(`bash is unavailable at ${bash}`)
    return
  }

  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-macos-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const installer = resolve(root, 'setup', 'install-macos.sh')
  await mkdir(dirname(installer), { recursive: true })
  await copyFile(resolve(productRoot, 'setup', 'install-macos.sh'), installer)

  for (const relative of [
    'package.json',
    'runtime/DSH/package.json',
    'runtime/xiaoshe-legacy/run.py',
    'packages/product-bundle/package.json',
    'packages/provider-readiness/package.json',
    'packages/migration-recovery/package.json',
    'packages/agent-experience/package.json',
    'packages/coding-workbench/package.json',
    'setup/profile/cordis.patch.yml',
  ]) {
    const path = resolve(root, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, relative.endsWith('.json') ? '{}\n' : '# fixture\n', 'utf8')
  }

  const fakeBin = resolve(root, 'fake-bin')
  await mkdir(fakeBin, { recursive: true })
  const fakeNode = resolve(fakeBin, 'node')
  const fakePython = resolve(fakeBin, 'python3')
  const fakePnpm = resolve(fakeBin, 'pnpm')
  const fakeGit = resolve(fakeBin, 'git')
  await writeFile(fakeNode, '#!/bin/sh\n[ "${1:-}" = "--version" ] && printf "v24.17.0\\n"\nexit 0\n', 'utf8')
  await writeFile(fakePython, '#!/bin/sh\nexit 0\n', 'utf8')
  await writeFile(fakePnpm, '#!/bin/sh\n[ "${1:-}" = "--version" ] && printf "11.7.0\\n"\nexit 0\n', 'utf8')
  await writeFile(fakeGit, '#!/bin/sh\nexit 0\n', 'utf8')
  await Promise.all([fakeNode, fakePython, fakePnpm, fakeGit].map(path => chmod(path, 0o755)))

  const shellPath = value => process.platform === 'win32'
    ? `/${value[0].toLowerCase()}${value.slice(2).replaceAll('\\', '/')}`
    : value
  const result = spawnSync(bash, [shellPath(installer), '--check-only', '--run-developer-validation'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${shellPath(fakeBin)}:/usr/bin:/bin`,
      XIAOSHE_INSTALL_MODE: 'embedded-runtime',
      XIAOSHE_NODE: shellPath(fakeNode),
      XIAOSHE_PYTHON: shellPath(fakePython),
      XIAOSHE_PNPM: shellPath(fakePnpm),
    },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.notEqual(result.status, 0, output)
  assert.match(output, /apps\/desktop-shell\/package\.json/u)
})

test('both installers run the lightweight installed Profile smoke after config validation', async () => {
  const manifest = JSON.parse(await readFile(resolve(productRoot, 'package.json'), 'utf8'))
  const windows = await readFile(resolve(productRoot, 'setup', 'install-windows.ps1'), 'utf8')
  const mac = await readFile(resolve(productRoot, 'setup', 'install-macos.sh'), 'utf8')
  assert.equal(manifest.files.includes('scripts/smoke-installed-profile.mjs'), true)
  for (const [platform, source, configProbe, smokeProbe] of [
    ['Windows', windows, 'dsh web --dump-config', 'smoke-installed-profile.mjs'],
    ['macOS', mac, 'dsh web --dump-config', 'smoke-installed-profile.mjs'],
  ]) {
    assert.ok(source.includes(smokeProbe), `${platform} installer must invoke the installed Profile smoke`)
    assert.ok(source.indexOf(configProbe) < source.indexOf(smokeProbe), `${platform} smoke must run after config validation`)
    assert.match(source.slice(source.indexOf(smokeProbe), source.indexOf(smokeProbe) + 240),
      /--profile-root\s+(?:\$ProfileRoot|"\$PROFILE_ROOT")/u,
      `${platform} smoke must receive the exact assembled Profile for isolated cloning`)
  }
})

test('packaged desktop materializes a writable per-user runtime instead of mutating signed resources', async () => {
  const main = await readFile(resolve(appRoot, 'src', 'main.mjs'), 'utf8')
  const lifecycle = await readFile(resolve(appRoot, 'src', 'lifecycle.mjs'), 'utf8')
  assert.match(main, /prepareProductRoot/u)
  assert.match(main, /app\.getPath\('userData'\)/u)
  assert.match(main, /app\.getVersion\(\)/u)
  assert.match(main, /safeMessage\(error, 4_000\)/u)
  assert.match(lifecycle, /stdout=.*slice\(-4000\).*stderr=.*slice\(-4000\)/su)
})

test('desktop navigation retries transient refusal and all native icons use the formal legacy source', async () => {
  const main = await readFile(resolve(appRoot, 'src', 'main.mjs'), 'utf8')
  const preload = await readFile(resolve(appRoot, 'src', 'preload.cjs'), 'utf8')
  const interactionAcceptance = await readFile(resolve(appRoot, 'src', 'interaction-acceptance.mjs'), 'utf8')
  const configuration = await readFile(resolve(appRoot, 'electron-builder.yml'), 'utf8')
  assert.match(main, /await loadProductPage\(target, PRODUCT_URL/u)
  assert.match(main, /did-fail-load/u)
  assert.match(main, /render-process-gone/u)
  assert.match(main, /xiaoshe:renderer-heartbeat/u)
  assert.match(main, /rendererProbePassed/u)
  assert.match(main, /probeCurrentRenderer/u)
  assert.match(main, /readyState: document\.readyState, origin: location\.origin/u)
  assert.match(main, /rendererExitAction/u)
  assert.match(main, /interactionAcceptanceRequested/u)
  assert.match(main, /ui-interaction-accepted/u)
  assert.match(main, /setOpacity\(0\.01\)/u)
  assert.match(main, /ui-interaction-step/u)
  assert.match(main, /ui-framework-error/u)
  assert.match(main, /const INTERACTION_ACCEPTANCE_TIMEOUT_MS = 330_000/u)
  assert.match(main, /interaction acceptance exceeded \$\{INTERACTION_ACCEPTANCE_TIMEOUT_MS\}ms/u)
  assert.doesNotMatch(main, /(?:innerText|textContent|querySelector)/u)
  assert.match(main, /ui-recovery-deferred/u)
  assert.match(main, /window-shown-after-renderer-exit/u)
  assert.match(main, /if \(recovered\) reveal\(\)/u)
  assert.match(main, /ui-acceptance-renderer-termination/u)
  assert.match(main, /forcefullyCrashRenderer/u)
  assert.match(main, /ui-visual-proof/u)
  assert.match(main, /'preload\.cjs'/u)
  assert.doesNotMatch(main, /'preload\.mjs'/u)
  assert.doesNotMatch(main, /void window\.loadURL/u)
  // Application platform selection and actual packaged artwork are exercised
  // by app-icon-brand.test.mjs rather than a hard-coded path in main.mjs.
  assert.match(main, /app\.dock\.setIcon\(loadAppIcon\(512\)\)/u)
  assert.match(main, /trayHeightForDisplay\(display\)/u)
  assert.match(main, /process\.platform === 'darwin' \? trayHeightForDisplay\(display\) : 15/u)
  assert.match(main, /fitTrayGlyph\(sourceImage, targetHeight\)/u)
  assert.match(main, /fitTrayGlyph\(retinaSource, targetHeight \* 2\)/u)
  assert.match(main, /display-metrics-changed/u)
  assert.match(main, /process\.platform === 'darwin'\) installTrayDisplaySync\(\)/u)
  assert.match(main, /tray\.setImage\(loadTrayImage\(profile\.targetHeight\)\)/u)
  assert.match(main, /addRepresentation\(\{ scaleFactor: 2, buffer: retinaImage\.toPNG\(\) \}\)/u)
  assert.doesNotMatch(main, /trayTemplate/u)
  assert.match(main, /setTemplateImage\(process\.platform === 'darwin'\)/u)
  assert.match(preload, /require\('electron'\)/u)
  assert.match(preload, /ipcRenderer\.send\('xiaoshe:renderer-heartbeat'/u)
  assert.match(preload, /pointerdown/u)
  assert.match(preload, /keydown/u)
  assert.match(preload, /HEARTBEAT_INTERVAL_MS = 3_000/u)
  assert.doesNotMatch(preload, /import\s/u)
  assert.match(interactionAcceptance, /XIAOSHE_DESKTOP_ACCEPTANCE/u)
  assert.match(interactionAcceptance, /paidModelRequestSent:\s*false/u)
  assert.match(configuration, /icon:\s+\.\.\/\.\.\/runtime\/xiaoshe-legacy\/ui\/assets\/app-icon-512\.png/u)
  assert.doesNotMatch(configuration, /packages\/native-shell-legacy-adapted\/ui\/assets/u)
})

test('native icons keep the formal mark, official menu sizes, and white app tile', async () => {
  const assets = resolve(productRoot, 'runtime', 'xiaoshe-legacy', 'ui', 'assets')
  const source = await readFile(resolve(assets, 'app-icon.svg'), 'utf8')
  const formalMark = await readFile(resolve(assets, 'snake.svg'))
  const legacyUi = await readFile(resolve(productRoot, 'runtime', 'xiaoshe-legacy', 'ui', 'index.html'), 'utf8')
  const tokens = await readFile(resolve(productRoot, 'runtime', 'xiaoshe-legacy', 'ui', 'styles', 'tokens.css'), 'utf8')
  const generator = await readFile(resolve(appRoot, 'scripts', 'build-brand-icons.mjs'), 'utf8')
  const embeddedMark = source.match(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/u)?.[1]
  assert.match(source, /<rect x="48" y="48" width="416" height="416" rx="94" fill="#ffffff"\/>/u)
  assert.match(source, /<image [^>]*x="40" y="40" width="432" height="432" [^>]*preserveAspectRatio="xMidYMid meet"\/>/u)
  assert.match(generator, /const appMarkInset = 40/u)
  assert.match(generator, /const appMarkSize = 432/u)
  assert.match(source, /mask-type="alpha"/u)
  assert.match(source, /data:image\/svg\+xml;base64,/u)
  assert.doesNotMatch(source, /<path\b/u, 'application wrapper must not copy or redraw the formal mark geometry')
  assert.ok(embeddedMark, 'application wrapper must embed the formal SVG source')
  assert.deepEqual(Buffer.from(embeddedMark, 'base64'), formalMark, 'embedded application mark must be byte-identical to ui/assets/snake.svg')
  for (const match of formalMark.toString('utf8').matchAll(/\bd="([^"]+)"/gu)) {
    assert.ok(legacyUi.includes(match[1]), 'formal snake.svg geometry must be the same geometry used by the interface top-left mark')
  }
  assert.match(generator, /readFile\(formalMarkPath\)/u)
  assert.match(generator, /'rsvg-convert'/u)
  assert.doesNotMatch(generator, /M16\.8 6\.8/u, 'icon generator must never carry a second copy of the mark geometry')
  for (const [index, offset, color] of [[1, '0', '#23362d'], [2, '.42', '#4f8069'], [3, '.72', '#9cc2b1'], [4, '1', '#d7c27f']]) {
    assert.match(tokens, new RegExp(`--sheen-${index}: ${color}`, 'u'), `${color} must remain the formal light-theme sheen token`)
    assert.match(source, new RegExp(`<stop offset="${offset.replace('.', '\\.')}" stop-color="${color}"\\/>`, 'u'), `${color} must appear at the interface offset`)
  }

  for (const [name, width, height] of [
    ['app-icon-256.png', 256, 256],
    ['app-icon-512.png', 512, 512],
    ['icon-16.png', 16, 16],
    ['icon-32.png', 32, 32],
  ]) {
    assert.deepEqual(pngDimensions(await readFile(resolve(assets, name))), { width, height }, name)
  }
})

test('adapted stage and conversation outlines share the requested theme treatment', async () => {
  const styles = await readFile(resolve(productRoot, 'packages', 'native-shell-legacy-adapted', 'src', 'client', 'adapted.css'), 'utf8')
  const client = await readFile(resolve(productRoot, 'packages', 'native-shell-legacy-adapted', 'src', 'client', 'index.ts'), 'utf8')
  assert.match(styles, /\[data-theme="light"\] :is\(\.stage-ghost,\.conversation-ghost\)\{opacity:\.35\}/u)
  assert.match(styles, /\[data-theme="ink-jade"\] :is\(\.stage-ghost,\.conversation-ghost\)\{opacity:\.35\}/u)
  assert.match(client, /const theme = themeSnapshot\.active\.colorScheme === 'dark' \? 'ink-jade' : 'light'/u)
  for (const [theme, palette] of [
    ['light', [['1', '#23362d'], ['2', '#4f8069'], ['3', '#9cc2b1'], ['4', '#d7c27f']]],
    ['ink-jade', [['1', '#f0f4f1'], ['2', '#a7d6bf'], ['3', '#5fa17f'], ['4', '#dbc788']]],
  ]) {
    for (const [stop, color] of palette) {
      assert.match(styles, new RegExp(`\\[data-theme="${theme}"\\] :is\\(\\.stage-ghost,\\.conversation-ghost\\) \\.brand-outline-stop-${stop}\\{stop-color:${color}\\}`, 'u'), `${theme} outline stop ${stop} must retain the formal legacy color`)
    }
  }
  assert.match(client, /renderBrandOutline\(e, 'stage-ghost', 'xsla-stage-icon'\)/u)
  assert.match(client, /renderBrandOutline\(e, 'conversation-ghost', 'xsla-conversation-icon'\)/u)
  assert.equal((client.match(/className: 'brand-outline-stop-[1-4]'/gu) ?? []).length, 4, 'outline gradient stops must remain theme-addressable')
  assert.equal((client.match(/radius: '\.92'/gu) ?? []).length, 2, 'both outline edges must use the requested doubled radius .92')
})

test('Windows acceptance launches the packaged product rather than the development Electron runtime', async () => {
  const script = await readFile(resolve(appRoot, '..', '..', 'scripts', 'acceptance', 'windows-desktop.ps1'), 'utf8')
  const environment = await readFile(resolve(appRoot, '..', '..', 'scripts', 'acceptance', 'windows-acceptance-environment.ps1'), 'utf8')
  const main = await readFile(resolve(appRoot, 'src', 'main.mjs'), 'utf8')
  assert.match(script, /dist-desktop\\win-unpacked/u)
  assert.doesNotMatch(script, /node_modules\\electron\\dist\\electron\.exe/u)
  assert.match(script, /Start-Process\s+-FilePath\s+\$Exe/u)
  assert.doesNotMatch(script, /\$env:XIAOSHE_PRODUCT_ROOT\s*=\s*\$XsRoot/u, 'packaged acceptance must exercise embedded resources')
  assert.match(script, /Enter-XiaosheAcceptanceEnvironment/u)
  assert.match(script, /Exit-XiaosheAcceptanceEnvironment/u)
  assert.match(environment, /Remove-Item\s+Env:\\XIAOSHE_PRODUCT_ROOT/u)
  assert.match(environment, /XIAOSHE_DSH_PORT/u)
  for (const name of ['XIAOSHE_HOME', 'DSH_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) {
    assert.match(environment, new RegExp(`\\b${name}\\b`, 'u'), `${name} must be redirected by the acceptance helper`)
  }
  assert.match(script, /--user-data-dir=/u)
  assert.match(environment, /XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA/u)
  assert.match(environment, /XIAOSHE_LAUNCH_TOKEN/u)
  assert.match(script, /Stop-IsolatedServiceVerified/u)
  assert.match(script, /windows-stop-entry\.ps1/u)
  assert.match(script, /-OwnershipToken\s+\$OwnershipToken/u)
  assert.match(script, /dsh-web-state-\$Port\.json/u)
  assert.match(script, /Get-NetTCPConnection/u)
  assert.ok(script.indexOf('Stop-IsolatedServiceVerified') < script.lastIndexOf('Exit-XiaosheAcceptanceEnvironment'), 'service and port must be verified before restoring the isolated environment')
  assert.match(main, /acceptanceUserDataPath/u)
  assert.match(main, /app\.setPath\('userData'/u)
  assert.match(script, /embedded-runtime-startup/u)
  assert.match(script, /xiaoshe-desktop-release\/v1/u)
  assert.match(script, /--expected-source-sha256/u)
  assert.match(script, /--expected-app-asar-sha256/u)
  assert.match(script, /--expected-executable-sha256/u)
  assert.match(script, /--expected-installer-sha256/u)
  assert.match(script, /pending_external/u, 'missing current artifacts must remain pending rather than pass')
  assert.match(script, /AllowPendingExternal/u)
  assert.match(script, /\$Pending -gt 0 -and -not \$AllowPendingExternal/u)
  assert.doesNotMatch(script, /Add-Check 'macos-real-device'/u, 'Windows acceptance must not remain incomplete on an unrelated macOS gate')
  assert.equal(Buffer.from(script, 'utf8').every(byte => byte < 0x80), true, 'Windows PowerShell 5.1 script must remain ASCII without depending on a BOM')
  assert.equal(Buffer.from(environment, 'utf8').every(byte => byte < 0x80), true, 'Windows PowerShell 5.1 helper must remain ASCII without depending on a BOM')
})

test('Windows release acceptance executes the manifest-bound NSIS installer and uninstaller', async () => {
  const acceptance = await readFile(resolve(productRoot, 'scripts', 'acceptance', 'windows-desktop.ps1'), 'utf8')
  const installer = await readFile(resolve(productRoot, 'scripts', 'acceptance', 'windows-install-uninstall.ps1'), 'utf8')
  const configuration = await readFile(resolve(appRoot, 'electron-builder.yml'), 'utf8')
  assert.match(acceptance, /windows-install-uninstall\.ps1/u)
  assert.match(acceptance, /windows-install-uninstall/u)
  assert.match(installer, /ExpectedInstallerSha256/u)
  assert.match(installer, /ExpectedExecutableSha256/u)
  assert.match(installer, /ExpectedProductVersion/u)
  assert.match(installer, /Start-Process[\s\S]+\/S[\s\S]+\/D=/su)
  assert.match(installer, /acceptance-quit-after[\s\S]+Start-Process -FilePath \$InstalledExecutable/su)
  assert.match(installer, /Uninstall[^\r\n]*\.exe/iu)
  assert.match(installer, /refusing to disturb an existing Xiaoshe installation/u)
  assert.match(installer, /WScript\.Shell/u)
  assert.match(installer, /TargetPath[\s\S]+InstalledExecutable/su)
  assert.match(installer, /DisplayVersion/u)
  assert.match(installer, /QuietUninstallString/u)
  assert.match(configuration, /guid:\s*ba0f3e97-dae3-539b-9849-e666817b715c/u)
  assert.match(installer, /UninstallRegistryKey = 'ba0f3e97-dae3-539b-9849-e666817b715c'/u)
  assert.match(installer, /function Invoke-CleanupStep/u)
  assert.ok((installer.match(/Invoke-CleanupStep/g) ?? []).length >= 4, 'uninstaller, shortcut, and directory cleanup must be independent')
  assert.match(installer, /CleanupFailures/u)
  assert.match(installer, /windows-install-uninstall[\s\S]+state = 'pass'/su)
  assert.equal(Buffer.from(installer, 'utf8').every(byte => byte < 0x80), true, 'Windows NSIS acceptance must remain PowerShell 5.1-safe ASCII')
})

test('Windows release rechecks use an exclusively created directory inside the manifest boundary', async () => {
  const script = await readFile(resolve(productRoot, 'scripts', 'acceptance', 'windows-desktop.ps1'), 'utf8')
  const recheck = script.slice(script.indexOf('function Confirm-ReleaseManifest'), script.indexOf('function Invoke-InstallUninstallAcceptance'))
  assert.doesNotMatch(recheck, /GetTempFileName/u)
  assert.match(recheck, /\$RecheckRoot = Join-Path \$ManifestRoot.*\[Guid\]::NewGuid\(\)/u)
  assert.match(recheck, /New-Item -ItemType Directory -Path \$RecheckRoot -ErrorAction Stop/u)
  assert.doesNotMatch(recheck, /New-Item[^\r\n]*-Force/u)
  assert.match(recheck, /\$Recheck = Join-Path \$RecheckRoot 'release-manifest\.json'/u)
  assert.match(recheck, /'--output', \$Recheck/u)
  assert.match(recheck, /\$OriginalSnapshot = Join-Path \$RecheckRoot 'original-manifest\.json'/u)
  assert.match(recheck, /\$script:ReleaseManifest \| ConvertTo-Json -Depth 30/u)
  assert.match(recheck, /createWindowsSigningEvidence/u)
  assert.match(recheck, /\$SigningProbe \$Verifier \$OriginalSnapshot \$Recheck/u)
  assert.match(recheck, /\$script:SigningEvidence = \$SigningJson \| ConvertFrom-Json/u)
  assert.doesNotMatch(script, /\$Signature\.Status -eq 'Valid'.*Add-Check 'windows-code-signing' 'pass'/u)
  assert.match(recheck, /finally[\s\S]*Remove-Item -LiteralPath \$RecheckRoot -ErrorAction Stop/u)
  assert.doesNotMatch(recheck, /Remove-Item[^\r\n]*-Recurse/u)
})

test('desktop packaging fails closed through the shared release-input preflight', async () => {
  const configuration = await readFile(resolve(appRoot, 'electron-builder.yml'), 'utf8')
  const hook = await readFile(resolve(appRoot, 'scripts', 'before-pack.mjs'), 'utf8')
  assert.match(configuration, /beforePack:\s*\.\/scripts\/before-pack\.mjs/u)
  assert.match(hook, /assertReleaseInputsSafe/u)
})

test('runtime acceptance owns a temporary userData root and an isolated dynamic port', async () => {
  const script = await readFile(resolve(appRoot, 'test', 'run-runtime-acceptance.mjs'), 'utf8')
  assert.match(script, /userDataPath:\s*join\(root, 'user-data'\)/u)
  assert.doesNotMatch(script, /127\.0\.0\.1:59999/u)
  assert.match(script, /listen\(0, '127\.0\.0\.1'/u)
  assert.match(script, /productRootOverride:\s*'not-used'/u)
})

test('Windows entry wrappers support the system PowerShell and custom ports isolate process ownership', async () => {
  for (const name of ['windows-start-entry.ps1', 'windows-stop-entry.ps1']) {
    const wrapper = await readFile(resolve(appRoot, '..', '..', 'scripts', name), 'utf8')
    assert.doesNotMatch(wrapper, /PowerShell 7 is required/u)
    assert.match(wrapper, /&\s*\(Join-Path\s+\$EntryRoot\s+\$EntryName\)/u)
  }
  for (const name of ['启动小蛇.ps1', '停止小蛇.ps1', '诊断小蛇-Windows.ps1']) {
    const launcher = await readFile(resolve(appRoot, '..', '..', name), 'utf8')
    assert.match(launcher, /dsh-web-state-\$[A-Za-z]+\.json/u)
  }
})

test('Windows first-device validation follows pnpm junction targets', async () => {
  const launcher = await readFile(resolve(appRoot, '..', '..', '启动小蛇.ps1'), 'utf8')
  assert.match(launcher, /Get-Item\s+-LiteralPath\s+\$Installed\s+-Force/u)
  assert.match(launcher, /\.Target/u)
  assert.doesNotMatch(launcher, /\$InstalledPath\s*=\s*\(Resolve-Path\s+-LiteralPath\s+\$Installed\)/u)
})

test('macOS acceptance uses the packaged app and a real isolated lifecycle', async () => {
  const root = resolve(appRoot, '..', '..')
  const script = await readFile(resolve(root, 'scripts', 'acceptance', 'macos-desktop.sh'), 'utf8')
  const lifecycle = await readFile(resolve(root, 'scripts', 'acceptance', 'macos-app-lifecycle.mjs'), 'utf8')
  const launcher = await readFile(resolve(root, 'scripts', 'start-xiaoshe-web.sh'), 'utf8')
  const desktopEntry = await readFile(resolve(root, '启动小蛇.command'), 'utf8')
  assert.match(script, /macos-app-lifecycle\.mjs/u)
  assert.match(script, /macos-app-lifecycle\.mjs[^\n]*--runtime=packaged/u)
  assert.match(script, /XIAOSHE_ACCEPTANCE_STATIC.*generate-macos-report/su)
  assert.ok(script.indexOf('electron-builder --mac dmg') < script.lastIndexOf('macos-app-lifecycle.mjs'), 'cold acceptance must build before launching the packaged app')
  assert.match(lifecycle, /inspectMacosBundleIdentity\(appPath\)/u)
  assert.match(lifecycle, /bundleExecutable/u)
  assert.match(lifecycle, /--acceptance-hide-show/u)
  assert.match(lifecycle, /--acceptance-quit-after=15000/u)
  assert.match(lifecycle, /second packaged instance/u)
  assert.match(lifecycle, /brandedWindowFact/u)
  assert.match(lifecycle, /DSH Local Build\|DeepSeek Harness/u)
  assert.match(lifecycle, /'service-ready', 'ui-renderer-ready', 'ui-ready', 'ui-recovery-deferred', 'ui-recovered', 'ui-visual-proof'/u)
  assert.match(lifecycle, /visualProof\?\.nonBlank !== true/u)
  assert.match(lifecycle, /inspectMaterializedRuntime/u)
  assert.match(lifecycle, /materializedUnderUserData/u)
  assert.match(lifecycle, /failureDiagnostics/u)
  assert.match(lifecycle, /safeCaptureDiagnostics/u)
  assert.match(lifecycle, /\$\{label\}-sha256/u)
  assert.doesNotMatch(lifecycle, /desktop-log=\$\{desktopLog\}/u)
  assert.match(launcher, /"HOME=\$HOME"/u)
  assert.match(launcher, /for KEY in DSH_HOME/u)
  assert.match(launcher, /\.xiaoshe-product-runtime\.json/u)
  assert.match(launcher, /XIAOSHE_INSTALL_MODE="\$INSTALL_MODE"/u)
  assert.match(launcher, /launch_url="\$\{URL\}\?xiaoshe_launch=\$\(date \+%s\)-\$\$"/u)
  assert.match(launcher, /open -a 'Microsoft Edge' "\$launch_url" \|\| open "\$launch_url"/u)
  assert.match(desktopEntry, /"\$XS_ROOT\/apps\/desktop-shell" "\$@"/u)
  assert.doesNotMatch(desktopEntry, /LOCAL_APP|INSTALLED_APP|dist-desktop|\/Applications\/小蛇\.app/u)
  assert.match(desktopEntry, /不会转入旧打包应用/u)
  assert.match(desktopEntry, /exec bash "\$XS_ROOT\/scripts\/start-xiaoshe-web\.sh" "\$@"/u)
  assert.match(lifecycle, /graceful termination/u)
  assert.match(lifecycle, /forced termination/u)
  assert.match(lifecycle, /portReleased/u)
  assert.match(lifecycle, /ownedPortReleased[\s\S]+ownedServiceReleased[\s\S]+isolated userData retained/su)
  assert.doesNotMatch(lifecycle, /node_modules\/electron\/dist\/Electron/u)
})

test('packaged macOS bootstrap does not mutate shell shortcuts or require developer launchers', async () => {
  const installer = await readFile(resolve(appRoot, '..', '..', 'setup', 'install-macos.sh'), 'utf8')
  assert.match(installer, /developer-source\|embedded-runtime/u)
  assert.match(installer, /if \[ "\$INSTALL_MODE" = 'developer-source' \]; then\s+require_file "\$XS_ROOT\/启动小蛇\.command"/su)
  assert.match(installer, /if \[ "\$INSTALL_MODE" = 'developer-source' \]; then\s+chmod \+x "\$XS_ROOT\/启动小蛇\.command"/su)
  assert.match(installer, /ELECTRON_INSTALL="\$ELECTRON_ROOT\/install\.js"/u)
  assert.match(installer, /if \[ "\$INSTALL_MODE" = 'developer-source' \]; then\s+ELECTRON_ROOT=[\s\S]*?if \[ ! -x "\$ELECTRON_BIN" \]; then[\s\S]*?"\$NODE" "\$ELECTRON_INSTALL"[\s\S]*?\[ -x "\$ELECTRON_BIN" \] \|\| fail[\s\S]*?fi/su)
  assert.match(installer, /XS 小蛇\(交接\)\?/u)
  assert.match(installer, /桌面应用运行时不修改终端配置/u)
})

test('macOS install acceptance cannot overwrite arbitrary applications', async () => {
  const script = await readFile(resolve(appRoot, '..', '..', 'scripts', 'acceptance', 'macos-install-uninstall.mjs'), 'utf8')
  assert.match(script, /installPath !== '\/Applications\/小蛇\.app'/u)
  assert.match(script, /refusing to overwrite a user installation/u)
  assert.match(script, /'attach'.*'-readonly'/su)
  assert.match(script, /applicationBundleManifest/u)
  assert.match(script, /mountReleased/u)
  assert.match(script, /hdiutil forced detach/u)
  assert.match(script, /usePackagedRuntime:\s*true/u)
  assert.match(script, /userDataRetainedAtUninstall/u)
})

test('macOS release gate signs, notarizes, staples, and asks Gatekeeper', async () => {
  const root = resolve(appRoot, '..', '..')
  const script = await readFile(resolve(appRoot, '..', '..', 'scripts', 'release', 'sign-notarize-macos.sh'), 'utf8')
  const gate = await readFile(resolve(root, 'scripts', 'acceptance', 'macos-signing-gate.mjs'), 'utf8')
  for (const contract of ['Developer ID Application', 'notarytool submit', 'stapler staple', 'stapler validate', 'spctl --assess', 'codesign --verify']) {
    assert.match(script, new RegExp(contract.replaceAll(' ', '\\s+'), 'u'), `missing ${contract}`)
  }
  assert.match(gate, /strictCodesignValid/u)
  assert.match(gate, /gatekeeperAccepted/u)
  assert.match(gate, /signedMaterialIdentity/u)
  assert.match(gate, /applicationBundleSha256/u)
})

test('macOS formal release captures clean source and binds final package materials to it', async () => {
  const root = resolve(appRoot, '..', '..')
  const acceptance = await readFile(resolve(root, 'scripts', 'acceptance', 'macos-desktop.sh'), 'utf8')
  const release = await readFile(resolve(root, 'scripts', 'release', 'sign-notarize-macos.sh'), 'utf8')
  const report = await readFile(resolve(root, 'scripts', 'acceptance', 'generate-macos-report.mjs'), 'utf8')
  const identityGate = await readFile(resolve(root, 'scripts', 'release', 'macos-source-identity.mjs'), 'utf8')
  const manifest = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf8'))
  for (const script of [acceptance, release]) {
    assert.match(script, /macos-source-identity\.mjs/u)
    assert.ok(script.indexOf(' capture ') < script.indexOf('electron-builder'), 'clean source must be captured before packaging')
    assert.ok(script.lastIndexOf(' verify ') > script.lastIndexOf('electron-builder'), 'final package materials must be verified after packaging')
    assert.match(script, /--app=/u)
    assert.match(script, /--dmg=/u)
    assert.match(script, /\(major === 22 && minor >= 23\) \|\| \(major === 24 && minor >= 17\)/u)
    assert.doesNotMatch(script, /major\) >= 24|major >= 24/u)
  }
  assert.match(acceptance, /--source=/u)
  assert.match(report, /checksFrom\('source'\)/u)
  assert.match(report, /releaseSource/u)
  assert.match(report, /release-source-identity/u)
  assert.match(identityGate, /hdiutil.*\['attach'.*'-readonly'/su)
  assert.match(identityGate, /mountedPackaged/u)
  assert.match(identityGate, /applicationBundle/u)
  assert.match(identityGate, /runLifecycleCleanup/u)
  assert.match(manifest.scripts.test, /macos-source-identity\.test\.mjs/u)
})
