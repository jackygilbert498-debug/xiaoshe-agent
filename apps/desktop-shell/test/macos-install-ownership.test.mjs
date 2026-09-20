import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { assertOwnedInstallDirectory, removeOwnedInstallDirectory, reserveInstallDirectory } from '../../../scripts/acceptance/macos-install-uninstall.mjs'

const run = promisify(execFile)
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xiaoshe-owned-install-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, target: join(root, 'Test.app') }
}

test('install claim is exclusive and cleans an owned partial copy', async t => {
  const { target } = await fixture(t)
  const owned = await reserveInstallDirectory(target)
  await assert.rejects(reserveInstallDirectory(target), { code: 'EEXIST' })
  await mkdir(join(target, 'Contents'))
  await writeFile(join(target, 'Contents', 'partial-copy.txt'), 'interrupted copy')
  await assertOwnedInstallDirectory(owned)
  await removeOwnedInstallDirectory(owned)
  await assert.rejects(lstat(target), { code: 'ENOENT' })
  await removeOwnedInstallDirectory(owned)
})

test('existing files and dangling links cannot be claimed or overwritten', async t => {
  const { root, target } = await fixture(t)
  await writeFile(target, 'existing user file')
  await assert.rejects(reserveInstallDirectory(target), { code: 'EEXIST' })
  assert.equal(await readFile(target, 'utf8'), 'existing user file')
  await rm(target)
  const missing = join(root, 'missing-user-target')
  await symlink(missing, target)
  await assert.rejects(reserveInstallDirectory(target), { code: 'EEXIST' })
  assert.equal((await lstat(target)).isSymbolicLink(), true)
  await assert.rejects(lstat(missing), { code: 'ENOENT' })
})

test('cleanup retains a replacement application instead of deleting foreign contents', async t => {
  const { root, target } = await fixture(t)
  const owned = await reserveInstallDirectory(target)
  const displaced = join(root, 'owned-displaced.app')
  await rename(target, displaced)
  await mkdir(target)
  await writeFile(join(target, 'user.txt'), 'replacement user application')
  await assert.rejects(assertOwnedInstallDirectory(owned), /ownership changed/u)
  await assert.rejects(removeOwnedInstallDirectory(owned), /ownership changed/u)
  assert.equal(await readFile(join(target, 'user.txt'), 'utf8'), 'replacement user application')
  assert.equal((await lstat(displaced)).isDirectory(), true)
})

test('cleanup retains a substituted symlink and its destination', async t => {
  const { root, target } = await fixture(t)
  const owned = await reserveInstallDirectory(target)
  await rename(target, join(root, 'owned-displaced.app'))
  const foreign = join(root, 'foreign.app')
  await mkdir(foreign)
  await writeFile(join(foreign, 'user.txt'), 'user application')
  await symlink(foreign, target, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(removeOwnedInstallDirectory(owned), /ownership changed/u)
  assert.equal((await lstat(target)).isSymbolicLink(), true)
  assert.equal(await readFile(join(foreign, 'user.txt'), 'utf8'), 'user application')
})

test('real macOS ditto preserves the reserved directory identity and copies only fixture bytes', { skip: process.platform !== 'darwin' }, async t => {
  const { root, target } = await fixture(t)
  const source = join(root, 'Source.app')
  await mkdir(join(source, 'Contents'), { recursive: true })
  await writeFile(join(source, 'Contents', 'fixture.txt'), 'not an executable application')
  const owned = await reserveInstallDirectory(target)
  await run('/usr/bin/ditto', [source, target], { timeout: 10_000 })
  await assertOwnedInstallDirectory(owned)
  assert.equal(await readFile(join(target, 'Contents', 'fixture.txt'), 'utf8'), 'not an executable application')
  await removeOwnedInstallDirectory(owned)
  await assert.rejects(lstat(target), { code: 'ENOENT' })
  assert.equal(await readFile(join(source, 'Contents', 'fixture.txt'), 'utf8'), 'not an executable application')
})
