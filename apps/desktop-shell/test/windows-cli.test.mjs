import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFile, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const productRoot = resolve(appRoot, '..', '..')
const run = promisify(execFile)
const powershell = process.platform === 'win32'
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : ''

async function writeElectronSupportFiles(distributionRoot, { appAsar } = {}) {
  await Promise.all([
    mkdir(join(distributionRoot, 'locales'), { recursive: true }),
    mkdir(join(distributionRoot, 'resources'), { recursive: true }),
  ])
  const writes = [
    writeFile(join(distributionRoot, 'icudtl.dat'), 'icu'),
    writeFile(join(distributionRoot, 'resources.pak'), 'resources'),
    writeFile(join(distributionRoot, 'snapshot_blob.bin'), 'snapshot'),
    writeFile(join(distributionRoot, 'v8_context_snapshot.bin'), 'v8 snapshot'),
    writeFile(join(distributionRoot, 'locales', 'en-US.pak'), 'locale'),
  ]
  if (appAsar !== undefined) writes.push(writeFile(join(distributionRoot, 'resources', 'app.asar'), appAsar))
  await Promise.all(writes)
}

async function installCommands() {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-windows-cli-'))
  const fakeRoot = join(root, 'product')
  const scripts = join(fakeRoot, 'scripts')
  const bin = join(root, 'bin')
  await mkdir(scripts, { recursive: true })
  for (const [name, marker] of [
    ['windows-terminal-entry.ps1', 'terminal'],
    ['windows-start-entry.ps1', 'desktop'],
    ['windows-doctor-entry.ps1', 'doctor'],
  ]) {
    await writeFile(resolve(scripts, name), [
      'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Forwarded)',
      `$Forwarded -join '|' | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) '${marker}.invocation') -Encoding ASCII -NoNewline`,
      'exit 0',
      '',
    ].join('\r\n'), 'ascii')
  }
  const installer = resolve(productRoot, 'scripts', 'install-windows-cli.ps1')
  const installed = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer,
    '-XsRoot', fakeRoot, '-BinPath', bin, '-NoPathUpdate',
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(installed.status, 0, installed.stderr || installed.stdout)
  return { root, fakeRoot, bin }
}

test('declared Node engines match the credential-safe proxy floor', async () => {
  for (const relative of ['package.json', 'apps/desktop-shell/package.json', 'runtime/DSH/package.json']) {
    const manifest = JSON.parse(await readFile(join(productRoot, relative), 'utf8'))
    assert.equal(manifest.engines.node, '^22.23.0 || ^24.17.0')
  }
})

test('Windows proxy runtime gate matches the credential-safe Node engine floor', {
  skip: process.platform !== 'win32',
}, () => {
  const helper = join(productRoot, 'scripts', 'windows-proxy-environment.ps1')
  const command = `. '${helper.replaceAll("'", "''")}'; [pscustomobject]@{ values = @([bool](Test-XiaosheNodeProxyVersion 'v22.22.9'),[bool](Test-XiaosheNodeProxyVersion 'v22.23.0'),[bool](Test-XiaosheNodeProxyVersion 'v23.9.0'),[bool](Test-XiaosheNodeProxyVersion 'v24.16.9'),[bool](Test-XiaosheNodeProxyVersion 'v24.17.0'),[bool](Test-XiaosheNodeProxyVersion 'v25.0.0'),[bool](Test-XiaosheNodeProxyVersion 'v26.3.0'),[bool](Test-XiaosheNodeProxyVersion 'bad')) } | ConvertTo-Json -Compress`
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()).values, [false, true, false, false, true, false, false, false])
})

async function createDesktopLaunchHarness(t, startProcessDefinition) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-desktop-launch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'product')
  const localAppData = join(root, 'local-app-data')
  const installed = join(localAppData, 'Programs', '小蛇', '小蛇.exe')
  const entry = join(checkout, '启动小蛇.ps1')
  const marker = join(root, 'launch.marker')
  const harness = join(root, 'launch.ps1')
  await mkdir(dirname(installed), { recursive: true })
  await mkdir(checkout, { recursive: true })
  await writeFile(installed, '')
  await writeElectronSupportFiles(dirname(installed), { appAsar: 'installed application' })
  await copyFile(resolve(productRoot, '启动小蛇.ps1'), entry)
  await writeFile(harness, [
    startProcessDefinition,
    '& $env:XIAOSHE_TEST_ENTRY',
    '',
  ].join('\r\n'), 'ascii')
  return {
    harness,
    marker,
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      XIAOSHE_TEST_ENTRY: entry,
      XIAOSHE_TEST_MARKER: marker,
    },
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function createPendingDesktopUpdateHarness(t, { invalidHash = false, lockCandidate = false, running = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-pending-desktop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'product')
  const scripts = join(checkout, 'scripts')
  const distRoot = join(checkout, 'apps', 'desktop-shell', 'dist-desktop')
  const daily = join(distRoot, 'win-unpacked')
  const candidateName = 'candidate-pending-test'
  const candidate = join(distRoot, candidateName)
  const localAppData = join(root, 'local-app-data')
  const entry = join(checkout, '启动小蛇.ps1')
  const helper = join(scripts, 'windows-promote-desktop-update.ps1')
  const launchMarker = join(root, 'launch.marker')
  const harness = join(root, 'probe.ps1')
  const oldExe = Buffer.from('old-xiaoshe-executable')
  const oldAsar = Buffer.from('old-xiaoshe-asar')
  const newExe = Buffer.from('new-xiaoshe-executable')
  const newAsar = Buffer.from('new-xiaoshe-asar')

  await mkdir(join(daily, 'resources'), { recursive: true })
  await mkdir(join(candidate, 'resources'), { recursive: true })
  await mkdir(scripts, { recursive: true })
  await mkdir(localAppData, { recursive: true })
  await writeFile(join(daily, '小蛇.exe'), oldExe)
  await writeFile(join(daily, 'resources', 'app.asar'), oldAsar)
  await writeFile(join(candidate, '小蛇.exe'), newExe)
  await writeFile(join(candidate, 'resources', 'app.asar'), newAsar)
  await Promise.all([
    writeElectronSupportFiles(daily),
    writeElectronSupportFiles(candidate),
  ])
  await copyFile(join(productRoot, '启动小蛇.ps1'), entry)
  await copyFile(resolve(productRoot, 'scripts', 'windows-promote-desktop-update.ps1'), helper).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  await writeFile(join(distRoot, 'pending-package-update.json'), `${JSON.stringify({
    schema: 'xiaoshe-pending-desktop-update/v1',
    candidateName,
    backupName: 'win-unpacked.before-pending-test',
    exeSha256: invalidHash ? '0'.repeat(64) : sha256(newExe),
    asarSha256: sha256(newAsar),
  }, null, 2)}\n`)
  const harnessLines = [
    'function Start-Process {',
    '  param([string]$FilePath, [object[]]$ArgumentList, [string]$WorkingDirectory, [string]$WindowStyle)',
    '  $Stream = [IO.File]::OpenRead($FilePath)',
    '  $Hasher = [Security.Cryptography.SHA256]::Create()',
    "  try { $Digest = ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() } finally { $Hasher.Dispose(); $Stream.Dispose() }",
    '  Set-Content -LiteralPath $env:XIAOSHE_TEST_MARKER -Value $Digest -Encoding ASCII -NoNewline',
    '}',
    'function Get-CimInstance {',
    '  param([string]$ClassName, [string]$Filter, [object]$ErrorAction)',
    '  if (-not [string]::IsNullOrWhiteSpace($env:XIAOSHE_TEST_RUNNING_PATH)) {',
    '    [pscustomobject]@{ ProcessId = 4242; ExecutablePath = $env:XIAOSHE_TEST_RUNNING_PATH }',
    '  }',
    '}',
  ]
  if (lockCandidate) {
    harnessLines.push(
      '$LockedFile = [IO.File]::Open($env:XIAOSHE_TEST_LOCKED_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
      'try { & $env:XIAOSHE_TEST_ENTRY } finally { $LockedFile.Dispose() }',
    )
  } else {
    harnessLines.push('& $env:XIAOSHE_TEST_ENTRY')
  }
  harnessLines.push('')
  await writeFile(harness, harnessLines.join('\r\n'), 'ascii')

  return {
    root,
    checkout,
    distRoot,
    daily,
    candidate,
    entry,
    launchMarker,
    harness,
    expectedExeSha256: sha256(newExe),
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      XIAOSHE_TEST_ENTRY: entry,
      XIAOSHE_TEST_LOCKED_PATH: join(candidate, '小蛇.exe'),
      XIAOSHE_TEST_MARKER: launchMarker,
      XIAOSHE_TEST_RUNNING_PATH: running ? join(daily, '小蛇.exe') : '',
    },
  }
}

test('Windows CLI installer resolves its product root under Windows PowerShell 5.1', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-windows-installer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const installer = resolve(productRoot, 'scripts', 'install-windows-cli.ps1')
  const checked = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer,
    '-BinPath', join(root, 'bin'), '-CheckOnly', '-NoPathUpdate',
  ], { encoding: 'utf8', windowsHide: true })

  assert.equal(checked.status, 0, checked.stderr || checked.stdout)
  const report = JSON.parse(checked.stdout)
  assert.equal(report.schema, 'xiaoshe-windows-cli/v1')
})

test('Windows developer validation fails closed when the desktop package is absent', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-developer-validation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const setup = join(root, 'setup')
  const scripts = join(root, 'scripts')
  await Promise.all([mkdir(join(setup, 'profile'), { recursive: true }), mkdir(scripts, { recursive: true })])
  await copyFile(join(productRoot, 'setup', 'install-windows.ps1'), join(setup, 'install-windows.ps1'))
  await copyFile(join(productRoot, 'scripts', 'windows-proxy-environment.ps1'), join(scripts, 'windows-proxy-environment.ps1'))
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
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, relative.endsWith('.json') ? '{}\n' : '# fixture\n')
  }

  const checked = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(setup, 'install-windows.ps1'), '-CheckOnly', '-RunDeveloperValidation',
  ], { encoding: 'utf8', windowsHide: true })
  assert.notEqual(checked.status, 0, 'explicit developer validation must not skip a missing desktop package')
  assert.match(`${checked.stdout}\n${checked.stderr}`.replace(/\s+/gu, ''), /apps[\\/]desktop-shell[\\/]package\.json/iu)
})

test('Windows CLI installer leaves command wrappers untouched during an isolated service bootstrap', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-cli-isolation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  const installer = resolve(productRoot, 'scripts', 'install-windows-cli.ps1')
  const installed = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer,
    '-XsRoot', productRoot, '-BinPath', bin, '-NoPathUpdate',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, XIAOSHE_SETUP_SKIP_CLI_INSTALL: '1' },
  })

  assert.equal(installed.status, 0, installed.stderr || installed.stdout)
  const report = JSON.parse(installed.stdout)
  assert.equal(report.skipped, true, 'service bootstrap must not repoint persistent s/ss commands')
  assert.equal(await readFile(join(bin, 'ss.cmd'), 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), null)
  assert.equal(await readFile(join(bin, 's.cmd'), 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), null)
})

test('Windows desktop ServerOnly bootstrap scopes command isolation to its automatic installer', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-server-bootstrap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'product')
  const setup = join(checkout, 'setup')
  const scripts = join(checkout, 'scripts')
  const entry = join(checkout, '启动小蛇.ps1')
  const installer = join(setup, 'install-windows.ps1')
  const marker = join(root, 'installer-environment.txt')
  await Promise.all([mkdir(setup, { recursive: true }), mkdir(scripts, { recursive: true })])
  await copyFile(join(productRoot, '启动小蛇.ps1'), entry)
  await copyFile(join(productRoot, 'scripts', 'lifecycle-lease.mjs'), join(scripts, 'lifecycle-lease.mjs'))
  await writeFile(installer, [
    "$isIsolated = if ($env:XIAOSHE_SETUP_SKIP_CLI_INSTALL -eq '1') { '1' } else { '0' }",
    "$isIsolated | Set-Content -LiteralPath $env:XIAOSHE_TEST_MARKER -Encoding ASCII -NoNewline",
    "throw 'synthetic stop after installer boundary'",
    '',
  ].join('\r\n'), 'ascii')

  const launched = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry, '-ServerOnly',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      LOCALAPPDATA: join(root, 'local-app-data'),
      DSH_HOME: join(root, 'dsh-home'),
      XIAOSHE_DSH_PORT: '39792',
      XIAOSHE_TEST_MARKER: marker,
    },
  })

  assert.notEqual(launched.status, 0, 'the synthetic installer must stop the remaining desktop startup')
  const isolated = await readFile(marker, 'ascii').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  assert.equal(isolated, '1', JSON.stringify({ status: launched.status, stdout: launched.stdout, stderr: launched.stderr }))
})

test('Windows s command launches the terminal entry and forwards arguments', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await installCommands()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  const launched = spawnSync('cmd.exe', ['/d', '/c', 's.cmd', 'alpha', 'beta'], {
    cwd: fixture.bin,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(launched.status, 0, launched.stderr || launched.stdout)

  const markers = await readdir(fixture.fakeRoot)
  assert.equal(markers.includes('terminal.invocation'), true, 's must invoke the terminal entry')
  assert.equal(markers.includes('desktop.invocation'), false, 's must not invoke the desktop entry')
  assert.equal(await readFile(join(fixture.fakeRoot, 'terminal.invocation'), 'ascii'), 'alpha|beta')
})

test('Windows ss command launches the desktop entry', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await installCommands()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  const launched = spawnSync('cmd.exe', ['/d', '/c', 'ss.cmd'], {
    cwd: fixture.bin,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(launched.status, 0, launched.stderr || launched.stdout)

  const markers = await readdir(fixture.fakeRoot)
  assert.equal(markers.includes('desktop.invocation'), true, 'ss must invoke the desktop entry')
  assert.equal(markers.includes('terminal.invocation'), false, 'ss must not invoke the terminal entry')
  assert.equal(await readFile(join(fixture.fakeRoot, 'desktop.invocation'), 'ascii'), '')
})

test('Windows desktop entry rejects an incomplete packaged runtime and falls back to Electron development', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-incomplete-desktop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'product')
  const packagedRoot = join(checkout, 'apps', 'desktop-shell', 'dist-desktop', 'win-unpacked')
  const electronRoot = join(checkout, 'apps', 'desktop-shell', 'node_modules', 'electron', 'dist')
  const packaged = join(packagedRoot, '小蛇.exe')
  const electron = join(electronRoot, 'electron.exe')
  const entry = join(checkout, '启动小蛇.ps1')

  await Promise.all([
    mkdir(join(packagedRoot, 'resources'), { recursive: true }),
    mkdir(join(electronRoot, 'locales'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(packaged, 'incomplete executable'),
    writeFile(join(packagedRoot, 'resources', 'app.asar'), 'application payload'),
    writeFile(join(checkout, 'apps', 'desktop-shell', 'package.json'), '{}\n'),
    writeFile(electron, 'electron executable'),
    writeFile(join(electronRoot, 'icudtl.dat'), 'icu'),
    writeFile(join(electronRoot, 'resources.pak'), 'resources'),
    writeFile(join(electronRoot, 'snapshot_blob.bin'), 'snapshot'),
    writeFile(join(electronRoot, 'v8_context_snapshot.bin'), 'v8 snapshot'),
    writeFile(join(electronRoot, 'locales', 'en-US.pak'), 'locale'),
  ])
  await copyFile(resolve(productRoot, '启动小蛇.ps1'), entry)

  const checked = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry, '-CheckOnly',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: join(root, 'local-app-data') },
  })
  assert.equal(checked.status, 0, checked.stderr || checked.stdout)
  const report = JSON.parse(checked.stdout)
  assert.equal(report.kind, 'electron-development')
  assert.equal(report.selectedDesktop, electron)
})

test('Windows terminal entry check reports its runtime inputs without starting the host', {
  skip: process.platform !== 'win32',
}, () => {
  const script = resolve(productRoot, 'scripts', 'windows-terminal-entry.ps1')
  const checked = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-CheckOnly',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, XIAOSHE_DSH_PORT: '39791' },
  })
  assert.equal(checked.status, 0, checked.stderr || checked.stdout)

  const report = JSON.parse(checked.stdout)
  assert.equal(report.schema, 'xiaoshe-windows-terminal/v1')
  assert.equal(report.xsRoot, productRoot)
  assert.equal(report.port, 39791)
  assert.equal(report.hostStarted, false)
  assert.match(report.terminalEntry, /packages[\\/]terminal-client[\\/]lib[\\/]bin\.js$/u)
  assert.equal(report.nodeMajor >= 24, true)
})

test('published product includes the Windows terminal entry', async () => {
  const manifest = JSON.parse(await readFile(resolve(productRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.files.includes('scripts/windows-terminal-entry.ps1'), true)
  assert.equal(manifest.files.includes('scripts/windows-promote-desktop-update.ps1'), true)
  assert.equal(manifest.files.includes('scripts/windows-proxy-environment.ps1'), true)
  assert.equal(manifest.files.includes('scripts/windows-build-product.ps1'), true)
})

test('Windows proxy helper converts the explicit user proxy without replacing explicit environment values', {
  skip: process.platform !== 'win32',
}, () => {
  const helper = resolve(productRoot, 'scripts', 'windows-proxy-environment.ps1')
  const command = [
    '. $env:XIAOSHE_TEST_PROXY_HELPER',
    "$FromRegistry = Resolve-XiaosheWindowsProxyEnvironment -HttpProxy '' -HttpsProxy '' -NoProxy '' -SystemProxyEnabled $true -SystemProxyServer '127.0.0.1:7897' -SystemProxyOverride '<local>;*.lan'",
    "$Explicit = Resolve-XiaosheWindowsProxyEnvironment -HttpProxy 'http://explicit.example:8080' -HttpsProxy 'http://secure.example:8443' -NoProxy 'example.test' -SystemProxyEnabled $true -SystemProxyServer '127.0.0.1:7897' -SystemProxyOverride '<local>'",
    "$SystemWithExplicitBypass = Resolve-XiaosheWindowsProxyEnvironment -HttpProxy '' -HttpsProxy '' -NoProxy 'user.example' -SystemProxyEnabled $true -SystemProxyServer '127.0.0.1:7897' -SystemProxyOverride '*.registry.lan'",
    "$OnlyHttp = Resolve-XiaosheWindowsProxyEnvironment -HttpProxy 'http://http-only.example:8080' -HttpsProxy '' -NoProxy '' -SystemProxyEnabled $true -SystemProxyServer '127.0.0.1:7897' -SystemProxyOverride '<local>'",
    "$OnlyHttps = Resolve-XiaosheWindowsProxyEnvironment -HttpProxy '' -HttpsProxy 'http://https-only.example:8080' -NoProxy '' -SystemProxyEnabled $true -SystemProxyServer '127.0.0.1:7897' -SystemProxyOverride '<local>'",
    '@($FromRegistry, $Explicit, $SystemWithExplicitBypass, $OnlyHttp, $OnlyHttps) | ConvertTo-Json -Compress',
  ].join('; ')
  const checked = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, XIAOSHE_TEST_PROXY_HELPER: helper },
  })
  assert.equal(checked.status, 0, checked.stderr || checked.stdout)
  const [fromRegistry, explicit, systemWithExplicitBypass, onlyHttp, onlyHttps] = JSON.parse(checked.stdout)
  assert.deepEqual(
    { enabled: fromRegistry.enabled, httpProxy: fromRegistry.httpProxy, httpsProxy: fromRegistry.httpsProxy, source: fromRegistry.source },
    { enabled: true, httpProxy: 'http://127.0.0.1:7897/', httpsProxy: 'http://127.0.0.1:7897/', source: 'windows-user-proxy' },
  )
  assert.match(fromRegistry.noProxy, /(?:^|,)localhost(?:,|$)/u)
  assert.match(fromRegistry.noProxy, /(?:^|,)127\.0\.0\.1(?:,|$)/u)
  assert.match(fromRegistry.noProxy, /(?:^|,)::1(?:,|$)/u)
  assert.match(fromRegistry.noProxy, /(?:^|,)\*\.lan(?:,|$)/u)
  assert.deepEqual(
    { httpProxy: explicit.httpProxy, httpsProxy: explicit.httpsProxy, noProxy: explicit.noProxy, source: explicit.source },
    { httpProxy: 'http://explicit.example:8080/', httpsProxy: 'http://secure.example:8443/', noProxy: 'example.test,localhost,127.0.0.1,::1', source: 'environment' },
  )
  assert.equal(systemWithExplicitBypass.noProxy, 'user.example,localhost,127.0.0.1,::1')
  assert.deepEqual(
    { enabled: onlyHttp.enabled, httpProxy: onlyHttp.httpProxy, httpsProxy: onlyHttp.httpsProxy },
    { enabled: true, httpProxy: 'http://http-only.example:8080/', httpsProxy: null },
  )
  assert.deepEqual(
    { enabled: onlyHttps.enabled, httpProxy: onlyHttps.httpProxy, httpsProxy: onlyHttps.httpsProxy },
    { enabled: true, httpProxy: null, httpsProxy: 'http://https-only.example:8080/' },
  )
})

test('Windows launcher enables Node env-proxy before the DSH entrypoint', async () => {
  const launcher = await readFile(resolve(productRoot, '启动小蛇.ps1'), 'utf8')
  assert.match(launcher, /windows-proxy-environment\.ps1/u)
  assert.match(
    launcher,
    /\$Arguments\s*=\s*@\(\s*'--use-env-proxy',\s*\('[^']+'\s*-f\s*\$DshEntry\)/u,
    'Node must parse --use-env-proxy as a runtime option rather than a DSH application argument',
  )
})

test('Windows launcher restores caller proxy variables after a failed child launch without logging credentials', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-proxy-restore-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const harness = join(root, 'proxy-restore.ps1')
  await writeFile(harness, [
    '. $env:XIAOSHE_TEST_PROXY_HELPER',
    "Remove-Item Env:\\XIAOSHE_TEST_START_PROCESS -ErrorAction SilentlyContinue",
    '$BeforeHttp = $env:HTTP_PROXY',
    '$BeforeHttps = $env:HTTPS_PROXY',
    '$BeforeNoProxy = $env:NO_PROXY',
    "$ProxyEnvironment = [pscustomobject]@{ httpProxy = 'http://scoped.example:8080/'; httpsProxy = 'http://scoped.example:8080/'; noProxy = 'scoped.example,localhost' }",
    "$Caught = ''",
    'try {',
    '  Invoke-XiaosheWithProxyEnvironment -ProxyEnvironment $ProxyEnvironment -Action {',
    "    $env:XIAOSHE_TEST_START_PROCESS = '1'",
    "    throw 'synthetic child launch failure'",
    '  }',
    '} catch { $Caught = $_.Exception.Message }',
    '[pscustomobject]@{',
    "  started = $env:XIAOSHE_TEST_START_PROCESS -eq '1'",
    '  error = $Caught',
    '  httpRestored = $env:HTTP_PROXY -ceq $BeforeHttp',
    '  httpsRestored = $env:HTTPS_PROXY -ceq $BeforeHttps',
    '  noProxyRestored = $env:NO_PROXY -ceq $BeforeNoProxy',
    '} | ConvertTo-Json -Compress',
    '',
  ].join('\r\n'), 'ascii')
  const secret = 'proxy-test-secret'
  const checked = await run(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8_000,
    env: {
      ...process.env,
      XIAOSHE_TEST_PROXY_HELPER: resolve(productRoot, 'scripts', 'windows-proxy-environment.ps1'),
      HTTP_PROXY: `http://user:${secret}@caller.example:8080`,
      HTTPS_PROXY: `http://user:${secret}@caller.example:8080`,
      NO_PROXY: 'caller.example',
    },
  })
  assert.doesNotMatch(`${checked.stdout}\n${checked.stderr}`, new RegExp(secret, 'u'))
  const report = JSON.parse(checked.stdout.trim().split(/\r?\n/u).at(-1))
  assert.deepEqual(report, { started: true, error: 'synthetic child launch failure', httpRestored: true, httpsRestored: true, noProxyRestored: true })
  const launcher = await readFile(resolve(productRoot, '启动小蛇.ps1'), 'utf8')
  assert.match(launcher, /Invoke-XiaosheWithProxyEnvironment/u)
})

test('Windows product build is non-interactive and restores the caller CI environment', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-noninteractive-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const helper = resolve(productRoot, 'scripts', 'windows-build-product.ps1')
  const fakePnpm = join(root, 'fake-pnpm.cmd')
  const marker = join(root, 'build-calls.txt')
  const harness = join(root, 'probe.ps1')
  await writeFile(fakePnpm, [
    '@echo off',
    'echo %CI%^|%*>>"%XIAOSHE_TEST_MARKER%"',
    'exit /b 0',
    '',
  ].join('\r\n'), 'ascii')
  await writeFile(harness, [
    "$ErrorActionPreference = 'Stop'",
    "$env:CI = 'caller-sentinel'",
    '& $env:XIAOSHE_TEST_BUILD_HELPER -XsRoot $env:XIAOSHE_TEST_BUILD_ROOT -Pnpm $env:XIAOSHE_TEST_PNPM',
    "if ($env:CI -cne 'caller-sentinel') { throw 'CI environment was not restored' }",
    '',
  ].join('\r\n'), 'ascii')

  const checked = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      XIAOSHE_TEST_BUILD_HELPER: helper,
      XIAOSHE_TEST_BUILD_ROOT: root,
      XIAOSHE_TEST_MARKER: marker,
      XIAOSHE_TEST_PNPM: fakePnpm,
    },
  })
  assert.equal(checked.status, 0, checked.stderr || checked.stdout)
  assert.deepEqual(
    (await readFile(marker, 'ascii')).trim().split(/\r?\n/u),
    [
      'true|-r --filter ./packages/** run build',
      'true|run build',
    ],
  )

  const missingCiMarker = join(root, 'build-calls-without-ci.txt')
  const missingCiHarness = join(root, 'probe-without-ci.ps1')
  await writeFile(missingCiHarness, [
    "$ErrorActionPreference = 'Stop'",
    'Remove-Item Env:\\CI -ErrorAction SilentlyContinue',
    '$BeforeLocation = (Get-Location).Path',
    '& $env:XIAOSHE_TEST_BUILD_HELPER -XsRoot $env:XIAOSHE_TEST_BUILD_ROOT -Pnpm $env:XIAOSHE_TEST_PNPM',
    "if (Test-Path Env:\\CI) { throw 'CI environment was introduced into the caller' }",
    "if ((Get-Location).Path -cne $BeforeLocation) { throw 'working directory was not restored' }",
    '',
  ].join('\r\n'), 'ascii')
  const checkedWithoutCi = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', missingCiHarness,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, XIAOSHE_TEST_BUILD_HELPER: helper, XIAOSHE_TEST_BUILD_ROOT: root, XIAOSHE_TEST_MARKER: missingCiMarker, XIAOSHE_TEST_PNPM: fakePnpm },
  })
  assert.equal(checkedWithoutCi.status, 0, checkedWithoutCi.stderr || checkedWithoutCi.stdout)
  assert.deepEqual((await readFile(missingCiMarker, 'ascii')).trim().split(/\r?\n/u), [
    'true|-r --filter ./packages/** run build',
    'true|run build',
  ])
})

test('Windows product build restores CI and location when the runtime build fails', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-failed-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fakePnpm = join(root, 'fake-pnpm.cmd')
  const harness = join(root, 'probe.ps1')
  await writeFile(fakePnpm, [
    '@echo off',
    'if "%~1"=="run" exit /b 23',
    'exit /b 0',
    '',
  ].join('\r\n'), 'ascii')
  await writeFile(harness, [
    "$ErrorActionPreference = 'Stop'",
    "$env:CI = 'caller-sentinel'",
    '$BeforeLocation = (Get-Location).Path',
    "$Caught = ''",
    'try {',
    '  & $env:XIAOSHE_TEST_BUILD_HELPER -XsRoot $env:XIAOSHE_TEST_BUILD_ROOT -Pnpm $env:XIAOSHE_TEST_PNPM',
    '} catch { $Caught = $_.Exception.Message }',
    "if ($Caught -notmatch 'runtime build failed') { throw 'runtime build failure was not propagated' }",
    "if ($env:CI -cne 'caller-sentinel') { throw 'CI environment was not restored after failure' }",
    "if ((Get-Location).Path -cne $BeforeLocation) { throw 'working directory was not restored after failure' }",
    '',
  ].join('\r\n'), 'ascii')
  const checked = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      XIAOSHE_TEST_BUILD_HELPER: resolve(productRoot, 'scripts', 'windows-build-product.ps1'),
      XIAOSHE_TEST_BUILD_ROOT: root,
      XIAOSHE_TEST_PNPM: fakePnpm,
    },
  })
  assert.equal(checked.status, 0, checked.stderr || checked.stdout)
})

test('developer installers and Windows launcher require the DSH HTTP fetch package', async () => {
  const windowsInstaller = await readFile(resolve(productRoot, 'setup', 'install-windows.ps1'), 'utf8')
  const macosInstaller = await readFile(resolve(productRoot, 'setup', 'install-macos.sh'), 'utf8')
  const windowsLauncher = await readFile(resolve(productRoot, '启动小蛇.ps1'), 'utf8')

  assert.match(
    windowsInstaller,
    /Join-Path \$DshRoot 'packages\\web\\web-fetch-http'/u,
    'Windows setup must install the DSH HTTP fetch provider into the web Profile',
  )
  assert.match(
    macosInstaller,
    /"\$DSH_ROOT\/packages\/web\/web-fetch-http"/u,
    'macOS setup must install the DSH HTTP fetch provider into the web Profile',
  )
  assert.match(
    windowsLauncher,
    /'@deepseek-ai\\dsh-web-fetch-http'\s*=\s*\(Join-Path \$DshRoot 'packages\\web\\web-fetch-http'\)/u,
    'Windows cold start must treat a missing or stale HTTP fetch provider as an incomplete Profile',
  )
})

test('Windows terminal entry rejects ports outside the TCP range', {
  skip: process.platform !== 'win32',
}, () => {
  const script = resolve(productRoot, 'scripts', 'windows-terminal-entry.ps1')
  const checked = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-CheckOnly',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, XIAOSHE_DSH_PORT: '70000' },
  })
  assert.notEqual(checked.status, 0, 'ports above 65535 must be rejected')
  assert.match(checked.stderr, /between 1 and 65535/u)
})

test('Windows desktop entry resolves the localized installed application', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const localAppData = await mkdtemp(join(tmpdir(), 'xiaoshe-local-app-data-'))
  t.after(() => rm(localAppData, { recursive: true, force: true }))
  const installed = join(localAppData, 'Programs', '小蛇', '小蛇.exe')
  await mkdir(dirname(installed), { recursive: true })
  await writeFile(installed, '')
  await writeElectronSupportFiles(dirname(installed), { appAsar: 'installed application' })

  const script = resolve(productRoot, 'scripts', 'windows-start-entry.ps1')
  const checked = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-CheckOnly',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: localAppData },
  })
  assert.equal(checked.status, 0, checked.stderr || checked.stdout)
  assert.match(checked.stdout, /\\u5c0f\\u86c7/u, 'localized JSON must remain ASCII-safe over Windows PowerShell pipes')

  const report = JSON.parse(checked.stdout)
  assert.equal(report.schema, 'xiaoshe-windows-desktop/v1')
  assert.equal(report.kind, 'installed')
  assert.equal(report.selectedDesktop, installed)
  assert.equal(report.launched, false)
})

test('Windows desktop entry launches a packaged executable without binding an empty argument list', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await createDesktopLaunchHarness(t, [
    'function Start-Process {',
    '  param(',
    '    [Parameter(Mandatory=$true)][string]$FilePath,',
    '    [ValidateNotNullOrEmpty()][object[]]$ArgumentList,',
    '    [string]$WorkingDirectory,',
    '    [string]$WindowStyle',
    '  )',
    "  $Value = if ($PSBoundParameters.ContainsKey('ArgumentList')) { 'arguments-bound' } else { 'launched-without-arguments' }",
    '  Set-Content -LiteralPath $env:XIAOSHE_TEST_MARKER -Value $Value -Encoding ASCII -NoNewline',
    '}',
  ].join('\r\n'))

  const launched = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture.harness,
  ], { encoding: 'utf8', windowsHide: true, env: fixture.env })
  const marker = await readFile(fixture.marker, 'ascii').catch(() => null)

  assert.equal(launched.status, 0, launched.stderr || launched.stdout)
  assert.equal(marker, 'launched-without-arguments', launched.stderr || 'desktop process was not launched')
})

test('Windows ss promotes a verified pending desktop package before launching it', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await createPendingDesktopUpdateHarness(t)
  const launched = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture.harness,
  ], { encoding: 'utf8', windowsHide: true, env: fixture.env })

  assert.equal(launched.status, 0, launched.stderr || launched.stdout)
  const launchedSha = await readFile(fixture.launchMarker, 'ascii').catch(() => null)
  assert.equal(launchedSha, fixture.expectedExeSha256, JSON.stringify({
    stdout: launched.stdout,
    stderr: launched.stderr,
    distEntries: await readdir(fixture.distRoot),
  }))
  assert.equal(await readFile(join(fixture.daily, '小蛇.exe')).then(sha256), fixture.expectedExeSha256)
  assert.equal(await readFile(join(fixture.distRoot, 'win-unpacked.before-pending-test', '小蛇.exe'), 'utf8'), 'old-xiaoshe-executable')
  assert.equal(await readFile(join(fixture.distRoot, 'pending-package-update.json'), 'utf8').catch(() => null), null)
})

test('Windows ss leaves a pending package untouched while the current desktop is running', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await createPendingDesktopUpdateHarness(t, { running: true })
  const launched = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture.harness,
  ], { encoding: 'utf8', windowsHide: true, env: fixture.env })

  assert.equal(launched.status, 0, launched.stderr || launched.stdout)
  assert.equal(await readFile(fixture.launchMarker, 'utf8').catch(() => null), null, 'the old package must not be relaunched while an update is waiting')
  assert.equal(await readFile(join(fixture.daily, '小蛇.exe'), 'utf8'), 'old-xiaoshe-executable')
  assert.notEqual(await readFile(join(fixture.distRoot, 'pending-package-update.json'), 'utf8').catch(() => null), null)
})

test('Windows ss rejects an unverified pending package without changing the daily package', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await createPendingDesktopUpdateHarness(t, { invalidHash: true })
  const launched = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture.harness,
  ], { encoding: 'utf8', windowsHide: true, env: fixture.env })

  assert.notEqual(launched.status, 0, 'a hash mismatch must fail closed')
  assert.equal(await readFile(fixture.launchMarker, 'utf8').catch(() => null), null)
  assert.equal(await readFile(join(fixture.daily, '小蛇.exe'), 'utf8'), 'old-xiaoshe-executable')
  assert.equal(await readFile(join(fixture.candidate, '小蛇.exe'), 'utf8'), 'new-xiaoshe-executable')
  assert.notEqual(await readFile(join(fixture.distRoot, 'pending-package-update.json'), 'utf8').catch(() => null), null)
})

test('Windows ss restores the daily package if pending package activation fails', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await createPendingDesktopUpdateHarness(t, { lockCandidate: true })
  const launched = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture.harness,
  ], { encoding: 'utf8', windowsHide: true, env: fixture.env })

  assert.notEqual(launched.status, 0, 'a locked candidate must fail instead of leaving a partial activation')
  assert.equal(await readFile(fixture.launchMarker, 'utf8').catch(() => null), null)
  assert.equal(await readFile(join(fixture.daily, '小蛇.exe'), 'utf8'), 'old-xiaoshe-executable')
  assert.equal(await readFile(join(fixture.candidate, '小蛇.exe'), 'utf8'), 'new-xiaoshe-executable')
  assert.equal(await readFile(join(fixture.distRoot, 'win-unpacked.before-pending-test', '小蛇.exe'), 'utf8').catch(() => null), null)
  assert.notEqual(await readFile(join(fixture.distRoot, 'pending-package-update.json'), 'utf8').catch(() => null), null)
})

for (const kind of ['installed', 'packaged-development', 'electron-development']) {
  test(`Windows interactive desktop launch requests a visible window: ${kind}`, {
    skip: process.platform !== 'win32',
  }, async (t) => {
    // Catch Hidden being applied to the interactive GUI rather than only to
    // background helpers. Run the real entry but intercept OS process creation
    // so this regression test cannot open windows or touch the user's profile.
    const root = await mkdtemp(join(tmpdir(), 'xiaoshe-visible-launch-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const checkout = join(root, 'product with spaces')
    const localAppData = join(root, 'local-app-data')
    const executable = kind === 'installed'
      ? join(localAppData, 'Programs', '小蛇', '小蛇.exe')
      : kind === 'packaged-development'
        ? join(checkout, 'apps', 'desktop-shell', 'dist-desktop', 'win-unpacked', '小蛇.exe')
        : join(checkout, 'apps', 'desktop-shell', 'node_modules', 'electron', 'dist', 'electron.exe')
    await mkdir(dirname(executable), { recursive: true })
    await mkdir(checkout, { recursive: true })
    await mkdir(localAppData, { recursive: true })
    await writeFile(executable, '')
    if (kind === 'electron-development') {
      await writeElectronSupportFiles(dirname(executable))
      await writeFile(join(checkout, 'apps', 'desktop-shell', 'package.json'), '{}\n')
    } else {
      await writeElectronSupportFiles(dirname(executable), { appAsar: 'application payload' })
    }
    const entry = join(checkout, '启动小蛇.ps1')
    await copyFile(join(productRoot, '启动小蛇.ps1'), entry)
    const marker = join(root, 'window-style.txt')
    const harness = join(root, 'probe.ps1')
    await writeFile(harness, [
      'function Start-Process {',
      '  param([string]$FilePath, [object[]]$ArgumentList, [string]$WorkingDirectory, [string]$WindowStyle)',
      "  if ($FilePath -ne $env:XIAOSHE_TEST_EXECUTABLE) { throw 'wrong desktop selected' }",
      '  Set-Content -LiteralPath $env:XIAOSHE_TEST_MARKER -Value $WindowStyle -Encoding ASCII -NoNewline',
      '}',
      '& $env:XIAOSHE_TEST_ENTRY',
    ].join('\r\n'), 'ascii')
    const launched = spawnSync(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness,
    ], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, LOCALAPPDATA: localAppData, XIAOSHE_TEST_ENTRY: entry, XIAOSHE_TEST_MARKER: marker, XIAOSHE_TEST_EXECUTABLE: executable },
    })
    assert.equal(launched.status, 0, launched.stderr || launched.stdout)
    assert.equal(await readFile(marker, 'ascii'), 'Normal', 'ss must not pass a hidden first-window state to the interactive desktop')
  })
}

test('Windows desktop entry preserves a spaced Electron application path as one argument', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe electron root-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }))
  const fakeRoot = join(root, 'product with spaces')
  const appRoot = join(fakeRoot, 'apps', 'desktop-shell')
  const electron = join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  const marker = join(root, 'electron.marker')
  const localAppData = join(root, 'local-app-data')
  await mkdir(dirname(electron), { recursive: true })
  await mkdir(localAppData, { recursive: true })
  await copyFile(process.execPath, electron)
  await writeElectronSupportFiles(dirname(electron))
  await writeFile(join(appRoot, 'package.json'), '{"main":"probe.cjs"}\n')
  await writeFile(join(appRoot, 'probe.cjs'), [
    "require('node:fs').writeFileSync(process.env.XIAOSHE_TEST_MARKER, JSON.stringify({ appRoot: process.argv[1], pid: process.pid }), 'utf8')",
    '',
  ].join('\n'))
  const entry = join(fakeRoot, '启动小蛇.ps1')
  await copyFile(resolve(productRoot, '启动小蛇.ps1'), entry)

  const launched = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: localAppData, XIAOSHE_TEST_MARKER: marker },
  })
  assert.equal(launched.status, 0, launched.stderr || launched.stdout)

  let observed = null
  for (let attempt = 0; attempt < 40 && observed === null; attempt += 1) {
    const value = await readFile(marker, 'utf8').catch(() => null)
    if (value !== null) observed = JSON.parse(value)
    if (observed === null) await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  }
  assert.equal(observed?.appRoot, appRoot, launched.stderr || 'Electron did not receive the complete application path')

  // Start-Process intentionally detaches the GUI. The assertion marker can be
  // visible a few milliseconds before that process releases electron.exe and
  // its working directory. Wait for the owned fixture PID so full parallel test
  // runs cannot report a false EBUSY teardown failure.
  let exited = false
  for (let attempt = 0; attempt < 100 && !exited; attempt += 1) {
    try {
      process.kill(observed.pid, 0)
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
      exited = true
    }
  }
  assert.equal(exited, true, 'Electron argument probe did not exit within the bounded test window')
})

for (const scenario of [
  { name: 'development package uses this checkout', installed: false, original: undefined, expected: 'checkout' },
  { name: 'development package treats whitespace override as unset', installed: false, original: '   ', expected: 'checkout' },
  { name: 'development package preserves explicit root override', installed: false, original: 'C:\\intentional-root', expected: 'C:\\intentional-root' },
  { name: 'installed package retains its versioned runtime', installed: true, original: undefined, expected: null },
  { name: 'failed development launch restores caller environment', installed: false, original: '   ', expected: 'checkout', failLaunch: true },
]) {
  test(`Windows launch root: ${scenario.name}`, { skip: process.platform !== 'win32' }, async (t) => {
    // Exercise the real PowerShell entry; replace only the external process
    // launch so the fixture cannot start a user's desktop or change a profile.
    const root = await mkdtemp(join(tmpdir(), 'xiaoshe launch root-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const checkout = join(root, 'current source')
    const localAppData = join(root, 'local-app-data')
    const executable = scenario.installed
      ? join(localAppData, 'Programs', '小蛇', '小蛇.exe')
      : join(checkout, 'apps', 'desktop-shell', 'dist-desktop', 'win-unpacked', '小蛇.exe')
    await mkdir(dirname(executable), { recursive: true })
    await mkdir(checkout, { recursive: true })
    await mkdir(localAppData, { recursive: true })
    await writeFile(executable, '')
    await writeElectronSupportFiles(dirname(executable), { appAsar: 'application payload' })
    const entry = join(checkout, '启动小蛇.ps1')
    await copyFile(join(productRoot, '启动小蛇.ps1'), entry)
    const marker = join(root, 'result.json')
    const harness = join(root, 'probe.ps1')
    await writeFile(harness, [
      '$global:result = @{ observed = $null; after = $null; failed = $false; error = $null }',
      'function Start-Process {',
      '  param([string]$FilePath, [object[]]$ArgumentList, [string]$WorkingDirectory, [string]$WindowStyle)',
      '  $global:result.observed = $env:XIAOSHE_PRODUCT_ROOT',
      "  if ($env:XIAOSHE_TEST_FAIL -eq '1') { throw 'synthetic launch failure' }",
      '}',
      'try { & $env:XIAOSHE_TEST_ENTRY } catch { $global:result.failed = $true; $global:result.error = $_.Exception.Message }',
      '$global:result.after = $env:XIAOSHE_PRODUCT_ROOT',
      '$global:result | ConvertTo-Json | Set-Content -LiteralPath $env:XIAOSHE_TEST_MARKER -Encoding UTF8',
    ].join('\r\n'), 'ascii')
    const env = { ...process.env, LOCALAPPDATA: localAppData, XIAOSHE_TEST_ENTRY: entry, XIAOSHE_TEST_MARKER: marker, XIAOSHE_TEST_FAIL: scenario.failLaunch ? '1' : '0' }
    if (scenario.original === undefined) delete env.XIAOSHE_PRODUCT_ROOT
    else env.XIAOSHE_PRODUCT_ROOT = scenario.original
    const launched = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', windowsHide: true, env })
    assert.equal(launched.status, 0, launched.stderr || launched.stdout)
    const report = JSON.parse((await readFile(marker, 'utf8')).replace(/^\uFEFF/u, ''))
    assert.equal(report.observed, scenario.expected === 'checkout' ? checkout : scenario.expected, JSON.stringify(report))
    assert.equal(report.after, scenario.original ?? null, 'launch must not leave a process-wide root override behind')
    assert.equal(report.failed, scenario.failLaunch === true)
  })
}
