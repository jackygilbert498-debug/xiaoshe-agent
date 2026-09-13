import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MigrationExporter } from '../lib/exporter.js'
import { MigrationImporter } from '../lib/importer.js'
import { MigrationJournal } from '../lib/journal.js'
import { sha256Bytes } from '../lib/schema.js'

const temporaryRoots = new Set()
test.after(async () => Promise.all([...temporaryRoots].map(root => rm(root, { recursive: true, force: true }))))

async function bundle(root = undefined, id = 's1', options = {}) {
  if (root === undefined) {
    root = await mkdtemp(join(tmpdir(), 'xiaoshe-migration-roundtrip-'))
    temporaryRoots.add(root)
  }
  const path = join(root, `bundle-${id}`)
  await new MigrationExporter({
    sessions: { async list() { return [{ id, cwd: '/old/project' }] }, async inspect() { return { meta: { id, cwd: '/old/project' }, events: [{ seq: 0, type: 'turn/end', data: {} }] } } },
    settings: { describe() { return options.settings ?? [] } }, workspaces: { list() { return [{ id: `w-${id}`, path: '/old/project', title: 'P', createdAt: 'x', updatedAt: 'x', sessionIds: [id] }] }, get archivedSessionIds() { return options.archivedSessionIds ?? [] } },
  }).exportTo(path)
  return { root, path }
}

async function replaceBundleJson(path, relativePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  await writeFile(join(path, ...relativePath.split('/')), bytes)
  const manifestPath = join(path, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const entry = manifest.files.find(row => row.path === relativePath)
  entry.bytes = bytes.byteLength
  entry.sha256 = sha256Bytes(bytes)
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
}

async function addBundleJson(path, relativePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  await writeFile(join(path, ...relativePath.split('/')), bytes)
  const manifestPath = join(path, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.files.push({ path: relativePath, bytes: bytes.byteLength, sha256: sha256Bytes(bytes) })
  manifest.files.sort((left, right) => left.path.localeCompare(right.path))
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
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

test('MigrationImporter rejects duplicate session identities before mutation', async () => {
  const { root, path } = await bundle()
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
  const originalPath = manifest.files.find(row => row.path.startsWith('sessions/') && row.path.endsWith('.json')).path
  const original = JSON.parse(await readFile(join(path, ...originalPath.split('/')), 'utf8'))
  await addBundleJson(path, 'sessions/duplicate.json', original)
  let creates = 0
  const importer = new MigrationImporter({
    sessions: {
      async list() { return [] },
      async inspect() { throw new Error('unused') },
      async create() { creates += 1 },
      async append() {},
    },
    journalPath: join(root, 'journal.json'),
  })

  await assert.rejects(importer.preview(path, [{ from: '/old/project', to: root }]), /duplicate session/iu)
  assert.equal(creates, 0)
})

test('MigrationImporter imports a pre-status schema v1 settings document with the legacy safe default', async () => {
  const { root, path } = await bundle(undefined, 'legacy-v1', {
    // c2377a39's exporter emitted exactly this row: schema v1 had no status.
    settings: [{ ns: 'editor', user: { theme: 'dark' } }],
  })
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
  const sourceSettings = JSON.parse(await readFile(join(path, 'settings.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(sourceSettings, [{ ns: 'editor', user: { theme: 'dark' } }])

  const stored = {}
  const settings = {
    describe() { return [{ ns: 'editor', user: {}, revision: 0, status: 'ready', secrets: [] }] },
    async mutate(_ns, ops) {
      for (const op of ops) stored[op.path.join('.')] = op.value
    },
  }
  const importer = new MigrationImporter({
    sessions: { async list() { return [] }, async inspect() { throw new Error('unused') }, async create() {}, async append() {} },
    settings,
    journalPath: join(root, 'journal.json'),
  })

  const preview = await importer.preview(path, [{ from: '/old/project', to: root }])
  await importer.apply(preview)

  assert.equal(stored.theme, 'dark')
})

test('MigrationImporter rejects mixed legacy and status-aware settings rows before mutation', async () => {
  const { root, path } = await bundle(undefined, 'mixed-status', {
    settings: [
      { ns: 'editor', user: { theme: 'dark' } },
      { ns: 'models', user: { provider: 'safe' }, status: 'ready' },
    ],
  })
  let creates = 0
  const importer = new MigrationImporter({
    sessions: {
      async list() { return [] },
      async inspect() { throw new Error('unused') },
      async create() { creates += 1 },
      async append() {},
    },
    journalPath: join(root, 'journal.json'),
  })

  await assert.rejects(importer.preview(path, [{ from: '/old/project', to: root }]), /settings.*status.*invalid/iu)
  assert.equal(creates, 0)
})

test('MigrationImporter apply rejects a duplicate attachment identity before any mutation without disclosing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-migration-duplicate-attachment-'))
  temporaryRoots.add(root)
  const path = join(root, 'bundle')
  const secretId = 'must-not-leak-attachment-id'
  const ref = { attachmentId: secretId, mediaType: 'image/png', bytes: 3 }
  await new MigrationExporter({
    sessions: {
      async list() { return [{ id: 's1' }] },
      async inspect() { return { meta: { id: 's1' }, events: [{ seq: 0, data: { image: ref } }] } },
    },
    attachments: { async readImage() { return { ref, data: Uint8Array.from([1, 2, 3]) } } },
    settings: { describe() { return [] } },
    workspaces: { list() { return [] }, get archivedSessionIds() { return [] } },
  }).exportTo(path)
  let creates = 0
  let saves = 0
  const importer = new MigrationImporter({
    sessions: {
      async list() { return [] },
      async inspect() { throw new Error('unused') },
      async create() { creates += 1 },
      async append() {},
    },
    attachments: { async saveImage() { saves += 1; return ref } },
    journalPath: join(root, 'journal.json'),
  })
  const preview = await importer.preview(path, [])
  const index = JSON.parse(await readFile(join(path, 'attachments', 'index.json'), 'utf8'))
  await replaceBundleJson(path, 'attachments/index.json', [index[0], { ...index[0] }])

  await assert.rejects(importer.apply(preview), (error) => {
    assert.match(error.message, /duplicate attachment identity/iu)
    assert.doesNotMatch(error.message, /must-not-leak/iu)
    return true
  })
  assert.deepEqual({ creates, saves }, { creates: 0, saves: 0 })
})

test('MigrationImporter apply rejects a duplicate settings namespace before any mutation without disclosing it', async () => {
  const { root, path } = await bundle(undefined, 'duplicate-settings', {
    settings: [{ ns: 'must-not-leak-settings-ns', user: { theme: 'dark' }, status: 'ready' }],
  })
  let creates = 0
  let mutations = 0
  const settings = {
    describe() { return [{ ns: 'must-not-leak-settings-ns', user: {}, revision: 0, status: 'ready', secrets: [] }] },
    async mutate() { mutations += 1 },
  }
  const importer = new MigrationImporter({
    sessions: {
      async list() { return [] },
      async inspect() { throw new Error('unused') },
      async create() { creates += 1 },
      async append() {},
    },
    settings,
    journalPath: join(root, 'journal.json'),
  })
  const preview = await importer.preview(path, [{ from: '/old/project', to: root }])
  const rows = JSON.parse(await readFile(join(path, 'settings.json'), 'utf8'))
  await replaceBundleJson(path, 'settings.json', [rows[0], { ...rows[0], user: { theme: 'light' } }])

  await assert.rejects(importer.apply(preview), (error) => {
    assert.match(error.message, /duplicate settings identity/iu)
    assert.doesNotMatch(error.message, /must-not-leak/iu)
    return true
  })
  assert.deepEqual({ creates, mutations }, { creates: 0, mutations: 0 })
})

test('MigrationImporter apply rejects a duplicate workspace identity before any mutation without disclosing it', async () => {
  const { root, path } = await bundle(undefined, 'duplicate-workspace')
  let sessionCreates = 0
  let workspaceCreates = 0
  const importer = new MigrationImporter({
    sessions: {
      async list() { return [] },
      async inspect() { throw new Error('unused') },
      async create() { sessionCreates += 1 },
      async append() {},
    },
    workspaces: {
      list() { return [] },
      async create() { workspaceCreates += 1; return {} },
    },
    journalPath: join(root, 'journal.json'),
  })
  const mappings = [{ from: '/old/project', to: root }]
  const preview = await importer.preview(path, mappings)
  const document = JSON.parse(await readFile(join(path, 'workspaces.json'), 'utf8'))
  document.workspaces[0].id = 'must-not-leak-workspace-id'
  document.workspaces.push({ ...document.workspaces[0], path: '/old/second-project' })
  await replaceBundleJson(path, 'workspaces.json', document)

  await assert.rejects(importer.apply(preview), (error) => {
    assert.match(error.message, /duplicate workspace identity/iu)
    assert.doesNotMatch(error.message, /must-not-leak/iu)
    return true
  })
  assert.deepEqual({ sessionCreates, workspaceCreates }, { sessionCreates: 0, workspaceCreates: 0 })
})

test('MigrationImporter consumes only session bytes still bound to the verified manifest', async () => {
  const { root, path } = await bundle()
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
  const sessionPath = manifest.files.find(row => row.path.startsWith('sessions/') && row.path.endsWith('.json')).path
  const sessionFile = join(path, ...sessionPath.split('/'))
  const original = JSON.parse(await readFile(sessionFile, 'utf8'))
  let replaced = false
  const importer = new MigrationImporter({
    sessions: {
      async list() {
        if (!replaced) {
          replaced = true
          await writeFile(sessionFile, `${JSON.stringify({ ...original, meta: { ...original.meta, cwd: '/tampered' } })}\n`)
        }
        return []
      },
      async inspect() { throw new Error('unused') },
      async create() { throw new Error('must not import unverified bytes') },
      async append() {},
    },
    journalPath: join(root, 'journal.json'),
  })

  await assert.rejects(importer.preview(path, [{ from: '/tampered', to: root }]), /hash mismatch/iu)
})

test('MigrationImporter preview reports unmapped workspace paths before confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-migration-workspace-preview-'))
  temporaryRoots.add(root)
  const path = join(root, 'bundle')
  await new MigrationExporter({
    sessions: { async list() { return [] }, async inspect() { throw new Error('unused') } },
    settings: { describe() { return [] } },
    workspaces: {
      list() { return [{ id: 'workspace-only', path: '/workspace/not-in-session', sessionIds: [] }] },
      get archivedSessionIds() { return [] },
    },
  }).exportTo(path)
  const importer = new MigrationImporter({
    sessions: { async list() { return [] }, async inspect() { throw new Error('unused') }, async create() {}, async append() {} },
    workspaces: { list() { return [] }, async create() { throw new Error('must not mutate during preview') } },
    journalPath: join(root, 'journal.json'),
  })

  const preview = await importer.preview(path, [])

  assert.deepEqual(preview.conflicts, [{ kind: 'path-unmapped', id: 'workspace-only', detail: '/workspace/not-in-session' }])
})

test('MigrationImporter preview rejects an attachment index that reads outside the verified bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-migration-attachment-path-'))
  temporaryRoots.add(root)
  const path = join(root, 'bundle')
  const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 3 }
  await new MigrationExporter({
    sessions: {
      async list() { return [{ id: 's1' }] },
      async inspect() { return { meta: { id: 's1' }, events: [{ seq: 0, data: { image: ref } }] } },
    },
    attachments: { async readImage() { return { ref, data: Uint8Array.from([1, 2, 3]) } } },
    settings: { describe() { return [] } },
    workspaces: { list() { return [] }, get archivedSessionIds() { return [] } },
  }).exportTo(path)
  await writeFile(join(root, 'outside.bin'), Uint8Array.from([9, 9, 9]))
  const index = JSON.parse(await readFile(join(path, 'attachments', 'index.json'), 'utf8'))
  index[0].file = '../outside.bin'
  await replaceBundleJson(path, 'attachments/index.json', index)
  const importer = new MigrationImporter({
    sessions: { async list() { return [] }, async inspect() { throw new Error('unused') }, async create() {}, async append() {} },
    attachments: { async saveImage() { return ref } },
    journalPath: join(root, 'journal.json'),
  })

  await assert.rejects(importer.preview(path, []), /unsafe attachment|attachment.*bundle/iu)
})

test('MigrationImporter preview rejects malformed settings and workspace records instead of silently dropping them', async () => {
  const { root, path } = await bundle()
  await replaceBundleJson(path, 'settings.json', [{ user: { theme: 'dark' } }])
  const importer = new MigrationImporter({
    sessions: { async list() { return [] }, async inspect() { throw new Error('unused') }, async create() {}, async append() {} },
    settings: { describe() { return [] }, async replace() {} },
    journalPath: join(root, 'journal.json'),
  })

  await assert.rejects(importer.preview(path, []), /settings.*invalid/iu)
})

test('MigrationImporter preserves target secrets omitted from a redacted settings export', async () => {
  const { root, path } = await bundle(undefined, 's1', {
    settings: [{
      ns: 'models',
      user: { theme: 'light' },
      revision: 3,
      status: 'ready',
      secrets: [{ path: ['apiKey'], set: true }],
    }],
  })
  const stored = { models: { apiKey: 'target-device-key' } }
  let revision = 8
  const settings = {
    describe() {
      return [{
        ns: 'models',
        user: Object.fromEntries(Object.entries(stored.models).filter(([key]) => key !== 'apiKey')),
        revision,
        status: 'ready',
        secrets: [{ path: ['apiKey'], set: true }],
      }]
    },
    async replace(ns, section) {
      stored[ns] = structuredClone(section)
      revision += 1
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(expectedRevision, revision)
      for (const op of ops) {
        assert.equal(op.path.length, 1)
        if (op.op === 'set') stored[ns][op.path[0]] = structuredClone(op.value)
        else delete stored[ns][op.path[0]]
      }
      revision += 1
    },
  }
  const sessions = {
    async list() { return [] },
    async inspect() { throw new Error('unused') },
    async create() {},
    async append() {},
  }
  const importer = new MigrationImporter({ sessions, settings, journalPath: join(root, 'journal.json') })

  await importer.apply(await importer.preview(path, [{ from: '/old/project', to: root }]))

  assert.deepEqual(stored.models, { apiKey: 'target-device-key', theme: 'light' })
})

test('MigrationImporter preserves nested target secrets while importing sibling settings leaves', async () => {
  const { root, path } = await bundle(undefined, 's1', {
    settings: [{
      ns: 'models',
      user: { provider: { endpoint: 'https://api.example.test' } },
      revision: 3,
      status: 'ready',
      secrets: [{ path: ['provider', 'apiKey'], set: true }],
    }],
  })
  const stored = { models: { provider: { apiKey: 'target-device-key' } } }
  let revision = 8
  const settings = {
    describe() {
      return [{
        ns: 'models',
        // A redacted consumer cannot reconstruct the hidden nested sibling.
        user: {},
        revision,
        status: 'ready',
        secrets: [{ path: ['provider', 'apiKey'], set: true }],
      }]
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(expectedRevision, revision)
      assert.deepEqual(ops, [{ op: 'set', path: ['provider', 'endpoint'], value: 'https://api.example.test' }])
      for (const op of ops) {
        let target = stored[ns]
        for (const part of op.path.slice(0, -1)) target = target[part] ??= {}
        target[op.path.at(-1)] = structuredClone(op.value)
      }
      revision += 1
    },
  }
  const sessions = {
    async list() { return [] },
    async inspect() { throw new Error('unused') },
    async create() {},
    async append() {},
  }
  const importer = new MigrationImporter({ sessions, settings, journalPath: join(root, 'journal.json') })

  await importer.apply(await importer.preview(path, [{ from: '/old/project', to: root }]))

  assert.deepEqual(stored.models, {
    provider: { apiKey: 'target-device-key', endpoint: 'https://api.example.test' },
  })
})

test('MigrationImporter fails closed before mutation when a redacted secret is nested in an imported array', async () => {
  const { root, path } = await bundle(undefined, 's1', {
    settings: [{
      ns: 'models',
      user: { profiles: [{ endpoint: 'https://api.example.test' }] },
      revision: 3,
      status: 'ready',
      secrets: [{ path: ['profiles', '0', 'apiKey'], set: true }],
    }],
  })
  let creates = 0
  let mutations = 0
  const importer = new MigrationImporter({
    sessions: {
      async list() { return [] },
      async inspect() { throw new Error('unused') },
      async create() { creates += 1 },
      async append() {},
    },
    settings: {
      describe() {
        return [{
          ns: 'models',
          user: {},
          revision: 8,
          status: 'ready',
          secrets: [{ path: ['profiles', '0', 'apiKey'], set: true }],
        }]
      },
      async mutate() { mutations += 1 },
    },
    journalPath: join(root, 'journal.json'),
  })

  await assert.rejects(
    importer.preview(path, [{ from: '/old/project', to: root }]),
    /cannot safely import.*array.*profiles/iu,
  )
  assert.equal(creates, 0)
  assert.equal(mutations, 0)
})

test('MigrationImporter preflight rejects a bundle exported from degraded settings', async () => {
  const { root, path } = await bundle(undefined, 's1', {
    settings: [{ ns: 'models', user: { theme: 'light' }, status: 'degraded' }],
  })
  let creates = 0
  const importer = new MigrationImporter({
    sessions: {
      async list() { return [] },
      async inspect() { throw new Error('unused') },
      async create() { creates += 1 },
      async append() {},
    },
    journalPath: join(root, 'journal.json'),
  })

  await assert.rejects(
    importer.preview(path, [{ from: '/old/project', to: root }]),
    /source settings.*degraded/iu,
  )
  assert.equal(creates, 0)
})

test('MigrationImporter rechecks degraded target settings before importing any sessions', async () => {
  const { root, path } = await bundle(undefined, 's1', {
    settings: [{ ns: 'models', user: { theme: 'light' }, status: 'ready' }],
  })
  let targetStatus = 'ready'
  let creates = 0
  const importer = new MigrationImporter({
    sessions: {
      async list() { return [] },
      async inspect() { throw new Error('unused') },
      async create() { creates += 1 },
      async append() {},
    },
    settings: {
      describe() { return [{ ns: 'models', user: {}, revision: 2, status: targetStatus, secrets: [] }] },
      async mutate() { throw new Error('degraded settings cannot be mutated') },
    },
    journalPath: join(root, 'journal.json'),
  })
  const preview = await importer.preview(path, [{ from: '/old/project', to: root }])
  targetStatus = 'degraded'

  await assert.rejects(importer.apply(preview), /target settings.*degraded/iu)
  assert.equal(creates, 0)
})

test('MigrationImporter revalidates target sessions after preview before any mutation', async () => {
  const { root, path } = await bundle()
  const rows = []
  let creates = 0
  const sessions = {
    async list() { return rows },
    async inspect() { return { meta: { id: 's1', cwd: '/concurrent-change' }, events: [] } },
    async create() { creates += 1 },
    async append() { throw new Error('must not append after target drift') },
  }
  const importer = new MigrationImporter({ sessions, journalPath: join(root, 'journal.json') })
  const mappings = [{ from: '/old/project', to: root }]
  const preview = await importer.preview(path, mappings)
  rows.push({ id: 's1', cwd: '/concurrent-change' })

  await assert.rejects(importer.apply(preview), /changed after preview|conflicts/u)
  assert.equal(creates, 0)
})

test('MigrationImporter keeps completed journals for independent bundles', async () => {
  const { root, path: bundleA } = await bundle()
  const { path: bundleB } = await bundle(root, 's2')
  const created = []
  const events = new Map()
  const sessions = {
    async list() { return created },
    async inspect(id) { return { meta: created.find(row => row.id === id), events: events.get(id) ?? [] } },
    async create(meta) { created.push(meta) },
    async append(id, rows) { events.set(id, [...(events.get(id) ?? []), ...rows]) },
  }
  const importer = new MigrationImporter({ sessions, journalPath: join(root, 'journal.json') })

  await importer.apply(await importer.preview(bundleA, [{ from: '/old/project', to: root }]))
  await importer.apply(await importer.preview(bundleB, [{ from: '/old/project', to: root }]))

  assert.deepEqual(created.map(row => row.id).sort(), ['s1', 's2'])
})

test('MigrationImporter can restart after completing A before importing B', async () => {
  const { root, path: bundleA } = await bundle()
  const { path: bundleB } = await bundle(root, 's2')
  const created = []
  const events = new Map()
  const sessions = {
    async list() { return created },
    async inspect(id) { return { meta: created.find(row => row.id === id), events: events.get(id) ?? [] } },
    async create(meta) { created.push(meta) },
    async append(id, rows) { events.set(id, [...(events.get(id) ?? []), ...rows]) },
  }
  const journalPath = join(root, 'journal.json')
  const first = new MigrationImporter({ sessions, journalPath })
  await first.apply(await first.preview(bundleA, [{ from: '/old/project', to: root }]))
  const afterRestart = new MigrationImporter({ sessions, journalPath })
  await afterRestart.apply(await afterRestart.preview(bundleB, [{ from: '/old/project', to: root }]))

  assert.deepEqual(created.map(row => row.id).sort(), ['s1', 's2'])
})

test('MigrationImporter resumes a bundle interrupted after session creation', async () => {
  const { root, path } = await bundle()
  const created = []
  const events = new Map()
  let interrupted = true
  const sessions = {
    async list() { return created },
    async inspect(id) { return { meta: created.find(row => row.id === id), events: events.get(id) ?? [] } },
    async create(meta) { created.push(meta) },
    async append(id, rows) {
      if (interrupted) { interrupted = false; throw new Error('simulated interruption before append') }
      events.set(id, [...(events.get(id) ?? []), ...rows])
    },
  }
  const importer = new MigrationImporter({ sessions, journalPath: join(root, 'journal.json') })
  const mappings = [{ from: '/old/project', to: root }]

  await assert.rejects(importer.apply(await importer.preview(path, mappings)), /simulated interruption/u)
  const recovery = await importer.preview(path, mappings)

  assert.deepEqual(recovery.conflicts, [])
  assert.equal(recovery.sessions[0].action, 'resume-events')
  await importer.apply(recovery)
  assert.equal(created.length, 1)
  assert.equal(events.get('s1').length, 1)
})

test('MigrationImporter resumes when session creation succeeds before the journal completion commit', async () => {
  const { root, path } = await bundle()
  const created = []
  const events = new Map()
  const sessions = {
    async list() { return created },
    async inspect(id) { return { meta: created.find(row => row.id === id), events: events.get(id) ?? [] } },
    async create(meta) { created.push(meta) },
    async append(id, rows) { events.set(id, [...(events.get(id) ?? []), ...rows]) },
  }
  const blocker = join(root, 'journal-parent')
  await writeFile(blocker, 'not a directory')
  const journalPath = join(blocker, 'journal.json')
  const mappings = [{ from: '/old/project', to: root }]
  const first = new MigrationImporter({ sessions, journalPath })
  await assert.rejects(first.apply(await first.preview(path, mappings)), /EEXIST|not a directory|directory/iu)
  assert.equal(created.length, 0, 'pending intent must become durable before session creation')

  await rm(blocker)
  await mkdir(blocker)
  const second = new MigrationImporter({ sessions, journalPath })
  await second.apply(await second.preview(path, mappings))
  assert.equal(created.length, 1)
  assert.equal(events.get('s1').length, 1)
})

test('MigrationImporter adopts the exact session intermediate state recorded by a pending intent', async () => {
  const { root, path } = await bundle()
  const journalPath = join(root, 'journal.json')
  const mappings = [{ from: '/old/project', to: root }]
  const probe = new MigrationImporter({ sessions: { async list() { return [] }, async inspect() { throw new Error('unused') }, async create() {}, async append() {} }, journalPath })
  const bundleHash = (await probe.preview(path, mappings)).bundleHash
  const journal = new MigrationJournal(journalPath)
  await journal.begin(bundleHash, 'session:s1:created')
  const created = [{ id: 's1', cwd: root }]
  const events = []
  const sessions = {
    async list() { return created },
    async inspect() { return { meta: created[0], events } },
    async create() { throw new Error('must not create the pending session twice') },
    async append(_id, rows) { events.push(...rows) },
  }
  const importer = new MigrationImporter({ sessions, journalPath })
  const preview = await importer.preview(path, mappings)
  assert.equal(preview.sessions[0].action, 'resume-events')
  await importer.apply(preview)
  assert.equal(events.length, 1)
})

test('MigrationImporter adopts exact pending settings without mutating them twice', async () => {
  const { root, path } = await bundle(undefined, 's1', { settings: [{ ns: 'editor', user: { theme: 'dark' }, revision: 4, status: 'ready' }] })
  const journalPath = join(root, 'journal.json')
  const mappings = [{ from: '/old/project', to: root }]
  const sessions = { async list() { return [] }, async inspect() { throw new Error('unused') }, async create() {}, async append() {} }
  const probe = new MigrationImporter({ sessions, journalPath })
  const bundleHash = (await probe.preview(path, mappings)).bundleHash
  await new MigrationJournal(journalPath).begin(bundleHash, 'settings:editor')
  let mutations = 0
  const settings = {
    describe() { return [{ ns: 'editor', user: { theme: 'dark' }, revision: 5, status: 'ready', secrets: [] }] },
    async mutate() { mutations += 1 },
  }
  const importer = new MigrationImporter({ sessions, settings, journalPath })

  await importer.apply(await importer.preview(path, mappings))

  assert.equal(mutations, 0)
})

test('MigrationImporter adopts exact pending workspace attachments without attaching twice', async () => {
  const { root, path } = await bundle()
  const journalPath = join(root, 'journal.json')
  const mappings = [{ from: '/old/project', to: root }]
  const sessions = {
    async list() { return [{ id: 's1', cwd: root }] },
    async inspect() { return { meta: { id: 's1', cwd: root }, events: [{ seq: 0, type: 'turn/end', data: {} }] } },
    async create() { throw new Error('unused') }, async append() { throw new Error('unused') },
  }
  const probe = new MigrationImporter({ sessions, journalPath })
  const bundleHash = (await probe.preview(path, mappings)).bundleHash
  await new MigrationJournal(journalPath).begin(bundleHash, 'workspace:w-s1')
  let attachments = 0
  const workspaces = {
    list() { return [{ id: 'target', path: root, title: 'P', sessionIds: ['s1'], async attachSession() { attachments += 1 } }] },
    async create() { throw new Error('must not create the pending workspace twice') },
  }
  const importer = new MigrationImporter({ sessions, workspaces, journalPath })

  await importer.apply(await importer.preview(path, mappings))

  assert.equal(attachments, 0)
})

test('MigrationImporter journals and adopts an exact pending archive state', async () => {
  const { root, path } = await bundle(undefined, 's1', { archivedSessionIds: ['s1'] })
  const journalPath = join(root, 'journal.json')
  const mappings = [{ from: '/old/project', to: root }]
  const sessions = {
    async list() { return [{ id: 's1', cwd: root }] },
    async inspect() { return { meta: { id: 's1', cwd: root }, events: [{ seq: 0, type: 'turn/end', data: {} }] } },
    async create() { throw new Error('unused') }, async append() { throw new Error('unused') },
  }
  const probe = new MigrationImporter({ sessions, journalPath })
  const bundleHash = (await probe.preview(path, mappings)).bundleHash
  await new MigrationJournal(journalPath).begin(bundleHash, 'archive:s1')
  let archiveCalls = 0
  const workspaces = {
    list() { return [{ id: 'target', path: root, title: 'P', sessionIds: ['s1'], async attachSession() {} }] },
    get archivedSessionIds() { return ['s1'] },
    async create() { throw new Error('unused') },
    async archiveSession() { archiveCalls += 1 },
  }
  const importer = new MigrationImporter({ sessions, workspaces, journalPath })

  await importer.apply(await importer.preview(path, mappings))

  assert.equal(archiveCalls, 0)
})

test('MigrationImporter restarts through interrupted A, completed B, then recovers A', async () => {
  const { root, path: bundleA } = await bundle()
  const { path: bundleB } = await bundle(root, 's2')
  const created = []
  const events = new Map()
  let interrupted = true
  const sessions = {
    async list() { return created },
    async inspect(id) { return { meta: created.find(row => row.id === id), events: events.get(id) ?? [] } },
    async create(meta) { created.push(meta) },
    async append(id, rows) {
      if (id === 's1' && interrupted) { interrupted = false; throw new Error('A interrupted') }
      events.set(id, [...(events.get(id) ?? []), ...rows])
    },
  }
  const journalPath = join(root, 'journal.json')
  const first = new MigrationImporter({ sessions, journalPath })
  const mappings = [{ from: '/old/project', to: root }]
  await assert.rejects(first.apply(await first.preview(bundleA, mappings)), /A interrupted/u)
  const second = new MigrationImporter({ sessions, journalPath })
  await second.apply(await second.preview(bundleB, mappings))
  const third = new MigrationImporter({ sessions, journalPath })
  const recovered = await third.preview(bundleA, mappings)
  assert.equal(recovered.sessions[0].action, 'resume-events')
  await third.apply(recovered)
  assert.equal(events.get('s1').length, 1)
  assert.equal(events.get('s2').length, 1)
})

test('MigrationImporter upgrades a v1 journal without losing its completed bundle', async () => {
  const { root, path: bundleA } = await bundle()
  const { path: bundleB } = await bundle(root, 's2')
  const seed = new MigrationImporter({ sessions: { async list() { return [] }, async inspect() { throw new Error('not used') }, async create() {}, async append() {} }, journalPath: join(root, 'seed.json') })
  const hash = (await seed.preview(bundleA, [{ from: '/old/project', to: root }])).bundleHash
  const journalPath = join(root, 'journal.json')
  await writeFile(journalPath, `${JSON.stringify({ schemaVersion: 1, bundleHash: hash, completed: ['session:s1:created', 'session:s1:events'], updatedAt: 1 })}\n`)
  const created = []
  const sessions = {
    async list() { return created },
    async inspect(id) { return { meta: created.find(row => row.id === id), events: [] } },
    async create(meta) { created.push(meta) }, async append() {},
  }
  const importer = new MigrationImporter({ sessions, journalPath })
  await importer.apply(await importer.preview(bundleB, [{ from: '/old/project', to: root }]))
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  assert.equal(journal.schemaVersion, 3)
  assert.equal(Object.keys(journal.bundles).length, 2)
})

test('MigrationJournal rebases a stale opened instance before storing another bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-migration-journal-stale-'))
  temporaryRoots.add(root)
  const journalPath = join(root, 'journal.json')
  const first = new MigrationJournal(journalPath)
  const stale = new MigrationJournal(journalPath)
  stale.open('bundle-b')

  await first.begin('bundle-a', 'session:a')
  await stale.begin('bundle-b', 'session:b')

  assert.deepEqual([...new MigrationJournal(journalPath).pending('bundle-a')], ['session:a'])
  assert.deepEqual([...new MigrationJournal(journalPath).pending('bundle-b')], ['session:b'])
})

test('MigrationJournal serializes concurrent writes from one instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-migration-journal-one-'))
  temporaryRoots.add(root)
  const journalPath = join(root, 'journal.json')
  const journal = new MigrationJournal(journalPath)

  await Promise.all([
    journal.begin('bundle-a', 'session:a'),
    journal.begin('bundle-b', 'session:b'),
  ])

  assert.deepEqual([...new MigrationJournal(journalPath).pending('bundle-a')], ['session:a'])
  assert.deepEqual([...new MigrationJournal(journalPath).pending('bundle-b')], ['session:b'])
})

test('MigrationJournal serializes concurrent writes from independent instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-migration-journal-pair-'))
  temporaryRoots.add(root)
  const journalPath = join(root, 'journal.json')

  await Promise.all([
    new MigrationJournal(journalPath).begin('bundle-a', 'session:a'),
    new MigrationJournal(journalPath).begin('bundle-b', 'session:b'),
  ])

  assert.deepEqual([...new MigrationJournal(journalPath).pending('bundle-a')], ['session:a'])
  assert.deepEqual([...new MigrationJournal(journalPath).pending('bundle-b')], ['session:b'])
})
