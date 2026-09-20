/** Offline HTTP fixture tests; no model, native browser or task-success claim. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { BATCH_ITEMS, batchSourceBytes, startBatchFixture } from './batch-fixture.mjs'

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'xs-batch-server-test-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const server = await startBatchFixture({ runId: randomUUID(), directory })
  t.after(() => server.close())
  return { server, directory }
}
const expected = bytes => ({ items: bytes.toString().trim().split('\n').map(line => { const row = JSON.parse(line); return { ...row, owner: row.owner ?? null } }) })
const submit = (server, itemId, value) => fetch(server.itemUrls[itemId] + 'save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })

test('fixed three-item source has two valid inputs and exactly the third input second line malformed', () => {
  const sources = batchSourceBytes()
  assert.deepEqual(Object.keys(sources), BATCH_ITEMS.map(item => item.itemId))
  for (const id of ['item-1', 'item-2']) assert.equal(expected(sources[id]).items.length, 2)
  const lines = sources['item-3'].toString().trim().split('\n')
  assert.equal(lines.length, 2)
  assert.doesNotThrow(() => JSON.parse(lines[0])); assert.throws(() => JSON.parse(lines[1]))
})

test('each item saves independently once and duplicate attempts remain visible including invalid retry bodies', async t => {
  const { server, directory } = await fixture(t), sources = batchSourceBytes()
  for (const id of ['item-1', 'item-2']) {
    const record = expected(sources[id])
    assert(!(await (await fetch(server.itemUrls[id])).text()).includes(record.items[0].project))
    assert.equal((await submit(server, id, record)).status, 200)
    assert.deepEqual(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')), record)
    assert.deepEqual((await (await fetch(server.itemUrls[id] + 'record')).json()).record, record)
  }
  assert.equal((await submit(server, 'item-1', {})).status, 409)
  assert.equal((await submit(server, 'item-2', expected(sources['item-2']))).status, 409)
  const evidence = await server.evidence()
  assert.deepEqual(evidence.submissions.map(row => [row.itemId, row.status, row.persisted]), [['item-1', 200, true], ['item-2', 200, true], ['item-1', 409, false], ['item-2', 409, false]])
  assert.equal(evidence.records['item-3'], null)
})

test('GET and reloaded page read actual disk state instead of an in-memory saved value', async t => {
  const { server, directory } = await fixture(t), record = expected(batchSourceBytes()['item-1'])
  await submit(server, 'item-1', record)
  const changed = structuredClone(record); changed.items[0].project = 'test-only-disk-change'
  await writeFile(join(directory, 'item-1.json'), JSON.stringify(changed))
  assert.deepEqual((await (await fetch(server.itemUrls['item-1'] + 'record')).json()).record, changed)
  assert((await (await fetch(server.itemUrls['item-1'])).text()).includes('test-only-disk-change'))
  const evidence = await server.evidence()
  assert.deepEqual(evidence.records['item-1'], changed)
  assert.notEqual(evidence.requests.at(-1).recordSha256, evidence.submissions[0].bodySha256)
})

test('unknown item, origin, method and invalid payload fail without a save', async t => {
  const { server } = await fixture(t)
  assert.equal((await fetch(server.url + 'item-4/')).status, 404)
  assert.equal((await fetch(server.itemUrls['item-1'], { headers: { Origin: 'https://outside.invalid' } })).status, 403)
  assert.equal((await fetch(server.itemUrls['item-1'] + 'record', { method: 'POST' })).status, 405)
  assert.equal((await submit(server, 'item-1', {})).status, 400)
  assert.deepEqual((await server.evidence()).records, { 'item-1': null, 'item-2': null, 'item-3': null })
})

test('close blocks an unfinished POST and settles the queue before reporting no late writes', { timeout: 5000 }, async t => {
  const { server, directory } = await fixture(t), body = JSON.stringify(expected(batchSourceBytes()['item-1']))
  const pending = request(server.itemUrls['item-1'] + 'save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } })
  pending.on('error', () => {})
  const disconnected = new Promise(done => pending.once('close', done))
  pending.write(body.slice(0, -1))
  while (!(await server.evidence()).requests.length) await delay(5)
  await Promise.all([server.close(), server.close()])
  pending.end(body.slice(-1)); await disconnected
  const evidence = await server.evidence()
  assert.equal(evidence.closed, true); assert.equal(evidence.submissions.length, 0)
  await assert.rejects(readFile(join(directory, 'item-1.json')), { code: 'ENOENT' })
})
