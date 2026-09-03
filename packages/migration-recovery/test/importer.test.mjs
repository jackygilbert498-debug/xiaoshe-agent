import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MigrationExporter } from '../lib/exporter.js'
import { MigrationImporter } from '../lib/importer.js'

async function bundle() {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-migration-roundtrip-'))
  const path = join(root, 'bundle')
  await new MigrationExporter({
    sessions: { async list() { return [{ id: 's1', cwd: '/old/project' }] }, async inspect() { return { meta: { id: 's1', cwd: '/old/project' }, events: [{ seq: 0, type: 'turn/end', data: {} }] } } },
    settings: { describe() { return [] } }, workspaces: { list() { return [{ id: 'w1', path: '/old/project', title: 'P', createdAt: 'x', updatedAt: 'x', sessionIds: ['s1'] }] }, get archivedSessionIds() { return [] } },
  }).exportTo(path)
  return { root, path }
}

test('MigrationImporter previews paths and applies idempotently with journal', async () => {
  const { root, path } = await bundle()
  const created = []
  const appended = []
  const sessions = { async list() { return created }, async inspect(id) { return { meta: created.find(row => row.id === id), events: appended } }, async create(meta) { created.push(meta) }, async append(_id, events) { appended.push(...events) } }
  const workspaces = { rows: [], list() { return this.rows }, async create(path, title) { const row = { id: `w${this.rows.length}`, path, title, sessionIds: [], async attachSession(id) { this.sessionIds.push(id) } }; this.rows.push(row); return row } }
  const importer = new MigrationImporter({ sessions, workspaces, journalPath: join(root, 'journal.json') })
  const preview = await importer.preview(path, [{ from: '/old/project', to: root }])
  assert.deepEqual(preview.conflicts, [])
  assert.equal(preview.sessions[0].action, 'create')
  await importer.apply(preview)
  assert.equal(created.length, 1)
  assert.equal(appended.length, 1)
  const again = await importer.preview(path, [{ from: '/old/project', to: root }])
  assert.equal(again.sessions[0].action, 'skip-identical')
  await importer.apply(again)
  assert.equal(created.length, 1)
})

test('MigrationImporter blocks different session ids and unmapped paths', async () => {
  const { root, path } = await bundle()
  const sessions = { async list() { return [{ id: 's1', cwd: '/other' }] }, async inspect() { return { meta: { id: 's1', cwd: '/other' }, events: [] } }, async create() {}, async append() {} }
  const importer = new MigrationImporter({ sessions, journalPath: join(root, 'journal.json') })
  const unmapped = await importer.preview(path, [])
  assert.ok(unmapped.conflicts.some(row => row.kind === 'path-unmapped'))
  const different = await importer.preview(path, [{ from: '/old/project', to: root }])
  assert.ok(different.conflicts.some(row => row.kind === 'session-different'))
  await assert.rejects(() => importer.apply(different), /conflicts/u)
})
