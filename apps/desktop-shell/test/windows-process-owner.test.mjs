import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const helper = resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'windows-process-owner.mjs')
const identity = 'a'.repeat(64)
const token = '11111111-1111-4111-8111-111111111111'

function run(...arguments_) {
  return spawnSync(process.execPath, [helper, ...arguments_], { encoding: 'utf8', windowsHide: true })
}

test('legacy owner state stays readable for authenticated upgrade and CAS removal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-owner-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'state.json')
  await writeFile(path, JSON.stringify({
    schema: 'xiaoshe-windows-process/v1', pid: 1234, port: 3080,
    xsRoot: 'C:\\XS', dshRoot: 'C:\\XS\\runtime\\DSH', creationDate: '42',
  }))

  const read = run('read', '--path', path)
  assert.equal(read.status, 0, read.stderr)
  assert.equal(JSON.parse(read.stdout).legacy, true)
  assert.notEqual(run('remove', '--path', path, '--expected-pid', '9999', '--expected-creation-date', '42').status, 0)
  assert.equal(run('remove', '--path', path, '--expected-pid', '1234', '--expected-creation-date', '42').status, 0)
})

test('current owner state can only be removed by matching pid and ownership token', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-owner-current-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'state.json')
  const write = run('write', '--path', path, '--pid', '4321', '--port', '3180',
    '--xs-root', 'C:\\XS', '--dsh-root', 'C:\\XS\\runtime\\DSH',
    '--runtime-identity', identity, '--ownership-token', token, '--creation-date', '84')
  assert.equal(write.status, 0, write.stderr)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).ownershipToken, token)

  assert.notEqual(run('remove', '--path', path, '--expected-pid', '4321', '--expected-token', '22222222-2222-4222-8222-222222222222').status, 0)
  assert.equal(run('read', '--path', path).status, 0)
  assert.equal(run('remove', '--path', path, '--expected-pid', '4321', '--expected-token', token).status, 0)
  assert.equal(run('remove', '--path', path, '--expected-pid', '4321', '--expected-token', token).status, 0, 'missing state is already removed')
})

test('owner records reject UUID-shaped but malformed ownership tokens', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-owner-token-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'state.json')
  const malformed = `aaaaaaaa-${'-'.repeat(27)}`
  const result = run('write', '--path', path, '--pid', '4321', '--port', '3180',
    '--xs-root', 'C:\\XS', '--dsh-root', 'C:\\XS\\runtime\\DSH',
    '--runtime-identity', identity, '--ownership-token', malformed, '--creation-date', '84')
  assert.notEqual(result.status, 0)
})

test('legacy owner migration requires the complete observed process identity and writes a token record', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-owner-migrate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'state.json')
  const legacy = {
    schema: 'xiaoshe-windows-process/v1', pid: 1234, port: 3080,
    xsRoot: 'C:\\XS', dshRoot: 'C:\\XS\\runtime\\DSH', creationDate: '42',
  }
  await writeFile(path, JSON.stringify(legacy))
  const migrateArgs = [
    'migrate', '--path', path,
    '--expected-pid', '1234', '--expected-port', '3080',
    '--expected-xs-root', legacy.xsRoot, '--expected-dsh-root', legacy.dshRoot,
    '--expected-creation-date', '42', '--runtime-identity', identity, '--ownership-token', token,
  ]

  const wrong = run(...migrateArgs.map(value => value === '1234' ? '1235' : value))
  assert.notEqual(wrong.status, 0)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), legacy)

  const migrated = run(...migrateArgs)
  assert.equal(migrated.status, 0, migrated.stderr)
  const current = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(current.runtimeIdentity, identity)
  assert.equal(current.ownershipToken, token)
  assert.equal(JSON.parse(migrated.stdout).legacy, false)
})
