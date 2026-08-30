import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { WorkbenchTransactionStore } from '../lib/transactions.js'
import { ControlledFileWriter } from '../lib/patch.js'
import { allowedPackageScripts } from '../lib/scripts.js'

test('controlled writes bind stale preimage, consume confirmation and can revert', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-write-tx-')); t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'a.txt'); await writeFile(file, 'before')
  const store = new WorkbenchTransactionStore(join(root, '.ledger.json'))
  const writer = new ControlledFileWriter({ store, tokenFactory: () => 'workbench-confirm-token-000001', now: () => 2_000_000_000_000 })
  const challenge = await writer.prepare({ workspaceId: 'w1', relativePath: 'a.txt', absolutePath: file, newText: 'after' })
  await writeFile(file, 'changed elsewhere')
  await assert.rejects(() => writer.confirm(challenge.id, challenge.token), /changed after prepare/iu)
  const retry = await writer.prepare({ workspaceId: 'w1', relativePath: 'a.txt', absolutePath: file, newText: 'after' })
  const receipt = await writer.confirm(retry.id, retry.token)
  assert.equal(await readFile(file, 'utf8'), 'after')
  await writer.revert(receipt.id)
  assert.equal(await readFile(file, 'utf8'), 'changed elsewhere')
  await assert.rejects(() => writer.revert(receipt.id), /already reverted/iu)
})

test('script allowlist only accepts declared non-lifecycle package scripts', () => {
  const scripts = allowedPackageScripts({ scripts: { test: 'node test', build: 'tsc', postinstall: 'curl bad', arbitrary: 'echo x' } }, ['test', 'build', 'postinstall'])
  assert.deepEqual(scripts, [{ name: 'build', command: 'tsc' }, { name: 'test', command: 'node test' }])
})
