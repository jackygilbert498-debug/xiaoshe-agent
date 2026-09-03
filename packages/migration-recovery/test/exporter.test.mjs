import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MigrationExporter } from '../lib/exporter.js'
import { verifyMigrationDirectory } from '../lib/schema.js'

test('MigrationExporter emits hashed portable facts without secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-migration-export-'))
  const target = join(root, 'bundle')
  const exporter = new MigrationExporter({
    sessions: {
      async list() { return [{ id: 's1', cwd: 'C:\\private\\project', createdAt: 1, version: 1 }] },
      async inspect() { return { meta: { id: 's1', cwd: 'C:\\private\\project', createdAt: 1, version: 1 }, events: [{ seq: 0, type: 'message', data: { image: { attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } } }] } },
    },
    attachments: { async readImage(ref) { return { ref, data: Uint8Array.from([1, 2, 3]) } } },
    settings: { describe() { return [{ ns: 'models', user: { apiKey: 'must-not-export', theme: 'light' }, secrets: [['apiKey']] }] } },
    workspaces: { list() { return [{ id: 'w1', path: 'C:\\private\\project', title: 'Project', createdAt: 'x', updatedAt: 'x', sessionIds: ['s1'] }] }, get archivedSessionIds() { return [] } },
    plugins: { snapshot() { return { installed: [{ name: 'safe-plugin', version: '1.0.0' }] } } },
  })
  await exporter.exportTo(target)
  const manifest = await verifyMigrationDirectory(target)
  // Export filenames intentionally avoid exposing raw session identifiers.
  assert.ok(manifest.files.some(file => file.path.startsWith('sessions/') && file.path.endsWith('.json')))
  const all = await Promise.all(manifest.files.map(file => readFile(join(target, ...file.path.split('/')), 'utf8').catch(() => '')))
  assert.equal(all.join('\n').includes('must-not-export'), false)
  assert.equal(all.join('\n').includes('apiKey'), false)
})
