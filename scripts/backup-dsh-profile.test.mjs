import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const script = fileURLToPath(new URL('./backup-dsh-profile.ps1', import.meta.url))
const windows = process.platform === 'win32'
const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-backup-profile-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'profile'), backup = join(root, 'backup')
  await mkdir(source)
  return { root, source, backup }
}
const backupProfile = (source, backup) => run(shell, [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  '-SourceRoot', source, '-BackupRoot', backup,
], { timeout: 15_000, windowsHide: true })
const missing = async path => assert.rejects(access(path), error => error.code === 'ENOENT')

test('PowerShell backup source retains its UTF-8 BOM', async () => {
  assert.deepEqual((await readFile(script)).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]))
})

test('Windows PowerShell 5.1 backs up durable files without either rebuildable dependency tree', { skip: !windows }, async t => {
  const version = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { windowsHide: true })
  assert.match(version.stdout.trim(), /^5\.1\./)
  const { root, source, backup } = await fixture(t)
  const external = join(root, 'outside-dependencies')
  await mkdir(external)
  await writeFile(join(external, 'must-not-copy.txt'), 'external dependency sentinel')
  await symlink(external, join(source, 'node_modules'), 'junction')
  await mkdir(join(source, '.dsh-module-fallback'))
  await symlink(external, join(source, '.dsh-module-fallback/node_modules'), 'junction')
  await writeFile(join(source, '.dsh-module-fallback/package.json'), '{"generated":true}')
  const persistent = {
    'cordis.patch.yml': 'user-setting: preserved\n',
    'package.json': '{"dependencies":{"custom":"1"}}',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'sessions/history.jsonl': '{"persistent":"session"}\n',
    '.custom/durable.txt': 'custom hidden state',
  }
  for (const [path, value] of Object.entries(persistent)) {
    await mkdir(join(source, path, '..'), { recursive: true })
    await writeFile(join(source, path), value)
  }
  await backupProfile(source, backup)
  for (const [path, value] of Object.entries(persistent)) assert.equal(await readFile(join(backup, path), 'utf8'), value)
  await missing(join(backup, 'node_modules'))
  await missing(join(backup, '.dsh-module-fallback'))
  assert.equal(await readFile(join(external, 'must-not-copy.txt'), 'utf8'), 'external dependency sentinel')
})

test('Windows backup refuses existing destinations without replacing contents', { skip: !windows }, async t => {
  const { source, backup } = await fixture(t)
  await mkdir(backup); await writeFile(join(backup, 'keep.txt'), 'existing backup')
  await assert.rejects(backupProfile(source, backup))
  assert.equal(await readFile(join(backup, 'keep.txt'), 'utf8'), 'existing backup')
})

test('Windows backup refuses its source or a destination inside it', { skip: !windows }, async t => {
  const { source } = await fixture(t)
  await writeFile(join(source, 'keep.txt'), 'source state')
  await assert.rejects(backupProfile(source, source))
  const nested = join(source, 'nested-backup')
  await assert.rejects(backupProfile(source, nested))
  await missing(nested)
  assert.equal(await readFile(join(source, 'keep.txt'), 'utf8'), 'source state')
})
