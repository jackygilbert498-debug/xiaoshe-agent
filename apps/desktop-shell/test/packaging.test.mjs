import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const productRoot = resolve(appRoot, '..', '..')

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
  assert.match(main, /interaction acceptance exceeded 30000ms/u)
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
  assert.match(main, /join\(productRoot, 'runtime', 'xiaoshe-legacy', 'ui', 'assets'/u)
  assert.match(main, /app\.dock\.setIcon\(loadAppIcon\(512\)\)/u)
  assert.match(main, /'icon-16\.png'/u)
  assert.match(main, /'icon-32\.png'/u)
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
  assert.match(configuration, /icon:\s+\.\.\/\.\.\/runtime\/xiaoshe-legacy\/ui\/assets\/app-icon-256\.png/u)
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

test('adapted empty-stage outline remains legible in both product themes', async () => {
  const styles = await readFile(resolve(productRoot, 'packages', 'native-shell-legacy-adapted', 'src', 'client', 'adapted.css'), 'utf8')
  const client = await readFile(resolve(productRoot, 'packages', 'native-shell-legacy-adapted', 'src', 'client', 'index.ts'), 'utf8')
  assert.match(styles, /\[data-theme="light"\] \.stage-ghost\{opacity:\.35\}/u)
  assert.match(styles, /\[data-theme="dark"\] \.stage-ghost\{opacity:\.75\}/u)
  for (const [stop, color] of [['1', '#f0f4f1'], ['2', '#a7d6bf'], ['3', '#5fa17f'], ['4', '#dbc788']]) {
    assert.match(styles, new RegExp(`\\[data-theme="dark"\\] \\.stage-ghost \\.brand-outline-stop-${stop}\\{stop-color:${color}\\}`, 'u'), `dark stage stop ${stop} must retain the formal legacy color`)
  }
  assert.match(client, /renderBrandOutline\(e, 'stage-ghost', 'xsla-stage-icon'\)/u)
  assert.match(client, /renderBrandOutline\(e, 'conversation-ghost', 'xsla-conversation-icon'\)/u)
  assert.equal((client.match(/className: 'brand-outline-stop-[1-4]'/gu) ?? []).length, 4, 'outline gradient stops must remain theme-addressable')
  assert.equal((client.match(/radius: '\.46'/gu) ?? []).length, 2, 'both outline edges must use the requested radius .46')
})

test('Windows acceptance launches the packaged product rather than the development Electron runtime', async () => {
  const script = await readFile(resolve(appRoot, '..', '..', 'scripts', 'acceptance', 'windows-desktop.ps1'), 'utf8')
  assert.match(script, /dist-desktop\\win-unpacked/u)
  assert.doesNotMatch(script, /node_modules\\electron\\dist\\electron\.exe/u)
  assert.match(script, /Start-Process\s+-FilePath\s+\$Exe/u)
  assert.equal(Buffer.from(script, 'utf8').every(byte => byte < 0x80), true, 'Windows PowerShell 5.1 script must remain ASCII without depending on a BOM')
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
  assert.match(script, /XIAOSHE_ACCEPTANCE_STATIC.*generate-macos-report/su)
  assert.ok(script.indexOf('electron-builder --mac dmg') < script.lastIndexOf('macos-app-lifecycle.mjs'), 'cold acceptance must build before launching the packaged app')
  assert.match(lifecycle, /Contents', 'MacOS', '小蛇/u)
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
  assert.match(lifecycle, /desktop-log=/u)
  assert.match(launcher, /"HOME=\$HOME"/u)
  assert.match(launcher, /for KEY in DSH_HOME/u)
  assert.match(launcher, /\.xiaoshe-product-runtime\.json/u)
  assert.match(launcher, /XIAOSHE_INSTALL_MODE="\$INSTALL_MODE"/u)
  assert.match(launcher, /launch_url="\$\{URL\}\?xiaoshe_launch=\$\(date \+%s\)-\$\$"/u)
  assert.match(launcher, /open -a 'Microsoft Edge' "\$launch_url" \|\| open "\$launch_url"/u)
  assert.match(desktopEntry, /"\$XS_ROOT\/apps\/desktop-shell" "\$@"/u)
  assert.match(desktopEntry, /dist-desktop\/mac-arm64\/小蛇\.app\/Contents\/MacOS\/小蛇/u)
  assert.match(desktopEntry, /\/Applications\/小蛇\.app\/Contents\/MacOS\/小蛇/u)
  assert.ok(desktopEntry.indexOf('DEV_ELECTRON') < desktopEntry.indexOf('LOCAL_APP'))
  assert.ok(desktopEntry.indexOf('LOCAL_APP') < desktopEntry.indexOf('INSTALLED_APP'))
  assert.match(desktopEntry, /exec bash "\$XS_ROOT\/scripts\/start-xiaoshe-web\.sh" "\$@"/u)
  assert.match(lifecycle, /graceful termination/u)
  assert.match(lifecycle, /forced termination/u)
  assert.match(lifecycle, /portReleased/u)
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
  assert.match(script, /bundleManifest/u)
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
})
