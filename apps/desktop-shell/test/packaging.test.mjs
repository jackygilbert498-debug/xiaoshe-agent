import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
  assert.match(main, /prepareProductRoot/u)
  assert.match(main, /app\.getPath\('userData'\)/u)
  assert.match(main, /app\.getVersion\(\)/u)
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
