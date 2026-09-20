import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { localAtomicFileIo } from '../lib/atomic-file.js'
import { WorkbenchTransactionStore } from '../lib/transactions.js'
import { ControlledFileWriter, WorkbenchRecoveryError } from '../lib/patch.js'
import { WorkspacePathPolicy } from '../lib/path-policy.js'

const TOKEN = 'workbench-test-confirm-token-000001'
const run = promisify(execFile)
async function fixture(t, limit = 100) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xiaoshe-recovery-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'file.txt'); const ledger = join(root, 'ledger.json')
  await writeFile(file, 'before')
  const workspaces = [{ id: 'w1', path: root }]
  const paths = new WorkspacePathPolicy({ list: () => workspaces })
  const faults = { ledgerWrite: false, ledgerRename: false, ledgerState: '', fileWrite: false, fileRename: false, afterStage: undefined, fileWrites: 0 }
  const ledgerIo = {
    ...localAtomicFileIo,
    async writeFile(path, bytes, options) {
      if (faults.ledgerWrite) { await localAtomicFileIo.writeFile(path, 'partial-secret-payload', options); throw new Error('PRIVATE-LEDGER-ERROR') }
      return localAtomicFileIo.writeFile(path, bytes, options)
    },
    async rename(from, to) {
      const value = JSON.parse(await readFile(from, 'utf8'))
      if (faults.ledgerRename || faults.ledgerState && value.transactions.some(row => row.state === faults.ledgerState)) throw new Error('PRIVATE-LEDGER-ERROR')
      return localAtomicFileIo.rename(from, to)
    },
  }
  const fileIo = {
    ...localAtomicFileIo,
    async writeFile(path, bytes, options) {
      faults.fileWrites++
      if (faults.fileWrite) { await localAtomicFileIo.writeFile(path, 'partial-secret-payload', options); throw new Error('PRIVATE-FILE-ERROR') }
      await localAtomicFileIo.writeFile(path, bytes, options)
      await faults.afterStage?.()
    },
    async rename(from, to) { if (faults.fileRename) throw new Error('PRIVATE-FILE-ERROR'); return localAtomicFileIo.rename(from, to) },
  }
  let store; let writer
  function restart() {
    store = new WorkbenchTransactionStore(ledger, limit, ledgerIo)
    writer = new ControlledFileWriter({ store, paths, io: fileIo, tokenFactory: () => TOKEN })
    return { store, writer }
  }
  restart()
  return { root, file, ledger, faults, paths, workspaces, restart,
    get store() { return store }, get writer() { return writer },
    prepare: (newText = 'after') => writer.prepare({ workspaceId: 'w1', relativePath: 'file.txt', absolutePath: file, newText }),
  }
}
const recovery = error => error instanceof WorkbenchRecoveryError && !error.message.includes('PRIVATE-')
async function noTemps(root) { assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.xiaoshe.tmp')), []) }

for (const fault of ['ledgerWrite', 'ledgerRename']) test(`ledger ${fault} failure publishes no in-memory state and cleans owned temp`, async t => {
  const f = await fixture(t); const old = await f.prepare(); const before = f.store.list()
  f.faults[fault] = true
  await assert.rejects(() => f.store.update(old.id, row => { row.error = 'mutating callback'; return { ...row, state: 'failed' } }), error => error.code === 'WORKBENCH_STORAGE_FAILED' && !error.message.includes('PRIVATE-'))
  assert.deepEqual(f.store.list(), before)
  f.restart(); assert.deepEqual(f.store.list(), before)
  await noTemps(f.root)
  f.faults[fault] = false
  await f.store.update(old.id, row => ({ ...row, state: 'failed' }))
  assert.equal(f.store.get(old.id).state, 'failed')
})

test('intent persistence failure never mutates the target', async t => {
  const f = await fixture(t); const c = await f.prepare(); f.faults.ledgerState = 'applying'
  await assert.rejects(() => f.writer.confirm(c.id, c.token), error => error.code === 'WORKBENCH_STORAGE_FAILED')
  assert.equal(await readFile(f.file, 'utf8'), 'before'); assert.equal(f.faults.fileWrites, 0)
  assert.equal(f.store.get(c.id).state, 'prepared'); f.restart(); assert.equal(f.store.get(c.id).state, 'prepared')
})

for (const operation of ['confirm', 'revert']) {
  for (const fault of ['fileWrite', 'fileRename', 'finalLedger']) test(`${operation}: ${fault} retains recoverable intent across restart`, async t => {
    const f = await fixture(t); const c = await f.prepare()
    if (operation === 'revert') await f.writer.confirm(c.id, c.token)
    const pending = operation === 'confirm' ? 'applying' : 'reverting'
    const done = operation === 'confirm' ? 'applied' : 'reverted'
    const source = operation === 'confirm' ? 'before' : 'after'; const target = operation === 'confirm' ? 'after' : 'before'
    if (fault === 'finalLedger') f.faults.ledgerState = done; else f.faults[fault] = true
    await assert.rejects(() => operation === 'confirm' ? f.writer.confirm(c.id, c.token) : f.writer.revert(c.id), recovery)
    assert.equal(f.store.get(c.id).state, pending)
    assert.equal(await readFile(f.file, 'utf8'), fault === 'finalLedger' ? target : source)
    await noTemps(f.root)
    f.faults.ledgerState = ''; f.faults.fileWrite = false; f.faults.fileRename = false
    f.restart(); assert.equal(f.store.get(c.id).state, pending)
    const writesBefore = f.faults.fileWrites
    const receipt = await f.writer.recover(c.id)
    assert.equal(receipt.state, done); assert.equal(await readFile(f.file, 'utf8'), target)
    assert.equal(f.faults.fileWrites - writesBefore, fault === 'finalLedger' ? 0 : 1)
    await f.writer.recover(c.id); assert.equal(f.store.get(c.id).state, done)
    f.restart(); assert.equal(f.store.get(c.id).state, done)
  })
}

test('unconfirmed preparation cannot be recovered into a write', async t => {
  const f = await fixture(t); const c = await f.prepare()
  await assert.rejects(() => f.writer.recover(c.id), /no confirmed operation/)
  assert.equal(await readFile(f.file, 'utf8'), 'before')
})
test('pending apply rejects wrong tokens and preserves third-party edits after restart', async t => {
  const f = await fixture(t); const c = await f.prepare(); f.faults.fileRename = true
  await assert.rejects(() => f.writer.confirm(c.id, c.token), recovery)
  f.faults.fileRename = false; f.restart()
  await assert.rejects(() => f.writer.confirm(c.id, 'wrong-token'), /token does not match/)
  await writeFile(f.file, 'user-changed')
  await assert.rejects(() => f.writer.recover(c.id), recovery)
  assert.equal(await readFile(f.file, 'utf8'), 'user-changed'); assert.equal(f.store.get(c.id).state, 'applying')
  await assert.rejects(() => f.prepare('new task'), recovery)
})
test('pending revert preserves later edits instead of blindly rolling them back', async t => {
  const f = await fixture(t); const c = await f.prepare(); await f.writer.confirm(c.id, c.token)
  f.faults.ledgerState = 'reverted'; await assert.rejects(() => f.writer.revert(c.id), recovery)
  await writeFile(f.file, 'later-user-edit'); f.faults.ledgerState = ''; f.restart()
  await assert.rejects(() => f.writer.recover(c.id), recovery)
  assert.equal(await readFile(f.file, 'utf8'), 'later-user-edit'); assert.equal(f.store.get(c.id).state, 'reverting')
})
test('external edit during temporary-file staging is rechecked before replacement', async t => {
  const f = await fixture(t); const c = await f.prepare()
  f.faults.afterStage = () => writeFile(f.file, 'edit-during-stage')
  await assert.rejects(() => f.writer.confirm(c.id, c.token), recovery)
  assert.equal(await readFile(f.file, 'utf8'), 'edit-during-stage'); await noTemps(f.root)
})
test('recovery rejects removed workspaces and remapped workspace paths', async t => {
  const f = await fixture(t); const c = await f.prepare(); f.faults.fileRename = true
  await assert.rejects(() => f.writer.confirm(c.id, c.token), recovery)
  f.faults.fileRename = false; f.workspaces.splice(0); f.restart()
  await assert.rejects(() => f.writer.recover(c.id), recovery)
  const replacement = join(f.root, 'replacement'); await mkdir(replacement); await writeFile(join(replacement, 'file.txt'), 'before')
  f.workspaces.push({ id: 'w1', path: replacement })
  await assert.rejects(() => f.writer.recover(c.id), recovery)
  assert.equal(await readFile(f.file, 'utf8'), 'before'); assert.equal(await readFile(join(replacement, 'file.txt'), 'utf8'), 'before')
})
test('recovery rejects a target replaced with an outside symlink', async t => {
  const f = await fixture(t); const c = await f.prepare(); f.faults.fileRename = true
  await assert.rejects(() => f.writer.confirm(c.id, c.token), recovery)
  f.faults.fileRename = false
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'xiaoshe-outside-'))); t.after(() => rm(outside, { recursive: true, force: true }))
  const victim = join(outside, 'victim'); await writeFile(victim, 'before'); await rename(f.file, `${f.file}.original`)
  try {
    await symlink(victim, f.file)
  } catch (error) {
    // Windows file-link creation requires a privilege this runner may lack.
    // Any other failure must still fail the boundary regression.
    if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error
    t.skip('Windows file-symlink privilege unavailable (actual EPERM)')
    return
  }
  f.restart(); await assert.rejects(() => f.writer.recover(c.id), recovery)
  assert.equal(await readFile(victim, 'utf8'), 'before')
})
test('duplicate confirmations and reverts are idempotent and preserve file mode', async t => {
  const f = await fixture(t); await chmod(f.file, 0o751)
  // Windows exposes only a subset of POSIX mode bits: preserve the actual
  // post-chmod mode there, while still requiring the exact POSIX mode elsewhere.
  const expectedMode = process.platform === 'win32' ? (await lstat(f.file)).mode & 0o777 : 0o751
  const c = await f.prepare()
  const confirmations = await Promise.all([f.writer.confirm(c.id, c.token), f.writer.confirm(c.id, c.token)])
  assert.ok(confirmations.every(row => row.state === 'applied')); assert.equal(f.faults.fileWrites, 1)
  assert.equal((await lstat(f.file)).mode & 0o777, expectedMode)
  assert.equal(await readFile(f.file, 'utf8'), 'after')
  const reversals = await Promise.all([f.writer.revert(c.id), f.writer.revert(c.id)])
  assert.ok(reversals.every(row => row.state === 'reverted')); assert.equal(f.faults.fileWrites, 2)
  assert.equal((await lstat(f.file)).mode & 0o777, expectedMode)
  assert.equal(await readFile(f.file, 'utf8'), 'before')
})
test('different transactions targeting one path cannot both pass the same preimage', async t => {
  const f = await fixture(t); const a = await f.prepare('A'); const b = await f.prepare('B')
  const outcomes = await Promise.allSettled([f.writer.confirm(a.id, a.token), f.writer.confirm(b.id, b.token)])
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(f.faults.fileWrites, 1); assert.equal(await readFile(f.file, 'utf8'), 'A')
  assert.equal(f.store.get(b.id).state, 'failed')
})
test('pending intents survive history trimming and a fresh ledger instance', async t => {
  const f = await fixture(t, 1); const c = await f.prepare(); f.faults.fileRename = true
  await assert.rejects(() => f.writer.confirm(c.id, c.token), recovery)
  for (let i = 0; i < 4; i++) await f.store.save({ ...f.store.get(c.id), id: `other-${i}`, state: 'failed', updatedAt: Date.now() + i + 1 })
  assert.equal(f.store.list().length, 2); f.restart()
  assert.equal(f.store.get(c.id).state, 'applying'); assert.equal(f.store.list().length, 2)
})
test('old schema-1 ledger remains readable; malformed rows fail closed', async t => {
  const f = await fixture(t); const c = await f.prepare()
  const old = f.store.get(c.id); delete old.challenge.confirmedAt
  await writeFile(f.ledger, JSON.stringify({ schemaVersion: 1, transactions: [old] }))
  f.restart(); assert.equal(f.store.get(c.id).state, 'prepared')
  await writeFile(f.ledger, JSON.stringify({ schemaVersion: 1, transactions: [{ ...old, challenge: null }] }))
  assert.throws(() => f.restart(), /ledger is unreadable/)
  await writeFile(f.ledger, 'PRIVATE-LEDGER-CONTENT invalid json')
  assert.throws(() => f.restart(), error => error.message === 'workbench transaction ledger is unreadable')
})
test('corrupt recovery payload is rejected without touching the target', async t => {
  const f = await fixture(t); const c = await f.prepare(); f.faults.fileRename = true
  await assert.rejects(() => f.writer.confirm(c.id, c.token), recovery)
  await f.store.update(c.id, row => ({ ...row, afterBase64: Buffer.from('untrusted-content').toString('base64') }))
  f.faults.fileRename = false; f.restart(); await assert.rejects(() => f.writer.recover(c.id), recovery)
  assert.equal(await readFile(f.file, 'utf8'), 'before')
})

for (const operation of ['confirm', 'revert']) for (const stage of ['intent', 'file', 'final']) test(`real process exit during ${operation}/${stage} is recoverable after restart`, async t => {
  const f = await fixture(t); const c = await f.prepare()
  if (operation === 'revert') await f.writer.confirm(c.id, c.token)
  const helper = fileURLToPath(new URL('./helpers/crash-write-worker.mjs', import.meta.url))
  await assert.rejects(() => run(process.execPath, [helper, JSON.stringify({ root: f.root, file: f.file, ledger: f.ledger, id: c.id, token: c.token, operation, stage })], { timeout: 10_000 }), error => error.code === 71)
  const destination = operation === 'confirm' ? 'after' : 'before'; const state = operation === 'confirm' ? 'applied' : 'reverted'
  f.restart(); const writes = f.faults.fileWrites
  assert.equal((await f.writer.recover(c.id)).state, state)
  assert.equal(await readFile(f.file, 'utf8'), destination)
  assert.equal(f.faults.fileWrites - writes, stage === 'intent' ? 1 : 0)
  f.restart(); assert.equal(f.store.get(c.id).state, state)
})
