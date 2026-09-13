import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalJson, sha256Bytes, verifyMigrationDirectory } from '../lib/schema.js'
import { mapWorkspacePath, normalizeBundlePath } from '../lib/path-map.js'

test('migration schema is deterministic and rejects unsafe paths', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 1 } }), '{"a":{"x":1,"y":2},"z":1}')
  assert.equal(sha256Bytes(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(normalizeBundlePath('sessions/a.json'), 'sessions/a.json')
  assert.throws(() => normalizeBundlePath('../secret'), /unsafe/u)
  assert.throws(() => normalizeBundlePath('C:/secret'), /unsafe/u)
})

test('workspace mapping is exact, cross-platform and explicit', () => {
  assert.equal(mapWorkspacePath('C:\\Users\\a\\project', [{ from: 'C:\\Users\\a\\project', to: '/Users/a/project' }]), '/Users/a/project')
  assert.equal(mapWorkspacePath('/Users/a/project', [{ from: '/Users/a/project', to: 'D:\\work\\project' }]), 'D:\\work\\project')
  assert.equal(mapWorkspacePath('/unknown', []), undefined)
})

test('verifyMigrationDirectory fails closed on hash and schema mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-migration-schema-'))
  await writeFile(join(root, 'data.json'), '{}')
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, product: 'xiaoshe', exportedAt: 1, files: [{ path: 'data.json', bytes: 2, sha256: sha256Bytes(Buffer.from('{}')) }] }))
  assert.equal((await verifyMigrationDirectory(root)).files.length, 1)
  await writeFile(join(root, 'data.json'), '{ }')
  await assert.rejects(() => verifyMigrationDirectory(root), /hash mismatch/u)
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 2, product: 'xiaoshe', exportedAt: 1, files: [] }))
  await assert.rejects(() => verifyMigrationDirectory(root), /schema/u)
})
