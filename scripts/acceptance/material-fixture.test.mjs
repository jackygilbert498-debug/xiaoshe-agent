import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { startMaterialFixture, materialSource, materialExpected } from './material-fixture.mjs'
import { startBatchFixture } from './batch-fixture.mjs'

async function fixture(t, scenario = 'normal', faultMode) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'xs-material-server-test-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const server = await startMaterialFixture({ runId: randomUUID(), scenario, directory, faultMode })
  t.after(() => server.close())
  return { server, directory, source: materialSource() }
}
const submit = (server, value) => fetch(server.url + 'save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })

// Execute the actual served script with a minimal DOM and real loopback HTTP.
// This is client/HTTP integration, not an Electron or real-model journey.
async function pageClient(url, network = fetch) {
  const html = await (await fetch(url)).text()
  const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1]
  assert.equal(typeof script, 'string')
  const nodes = Object.fromEntries(['form', 'payload', 'status', 'record', 'refresh'].map(id => [id, { value: '', textContent: '' }]))
  const calls = []
  runInNewContext(script, {
    document: { getElementById: id => { assert.ok(nodes[id]); return nodes[id] } },
    fetch: (path, options) => { const target = new URL(path, url).href; calls.push({ url: target, method: options?.method ?? 'GET' }); return network(target, options) },
  }, { timeout: 1000 })
  return { nodes, calls, async send(text) { nodes.payload.value = text; await nodes.form.onsubmit({ preventDefault() {} }); return nodes.status.textContent } }
}

async function pageFixture(t, kind) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'xs-save-page-test-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const server = kind === 'batch'
    ? await startBatchFixture({ runId: randomUUID(), directory })
    : await startMaterialFixture({ runId: randomUUID(), scenario: 'normal', directory })
  t.after(() => server.close())
  return { server, directory, url: kind === 'batch' ? server.itemUrls['item-1'] : server.url,
    recordPath: join(directory, kind === 'batch' ? 'item-1.json' : 'server-record.json') }
}

for (const kind of ['material', 'batch']) {
  test(`${kind} served page distinguishes local JSON parse failure and actual HTTP 400 without inventing approval`, async t => {
    const { server, url, recordPath } = await pageFixture(t, kind), client = await pageClient(url)
    assert.match(await client.send('{'), /本次未发送/u)
    assert.equal(client.calls.length, 0)
    const wrongShape = JSON.stringify(materialExpected(materialSource()).items)
    const message = await client.send(wrongShape)
    assert.match(message, /服务器拒绝本次请求（HTTP 400）/u)
    assert.doesNotMatch(message, /待确认|审批|items|project/u)
    assert.deepEqual(client.calls.map(row => row.method), ['POST'], 'the client must not retry or silently fix the document')
    await assert.rejects(readFile(recordPath), { code: 'ENOENT' })
    const evidence = await server.evidence()
    const post = evidence.requests.find(row => row.method === 'POST')
    assert.equal(post.status, 400, 'status comes from the actual server response')
    assert.equal(evidence.submissions.filter(row => row.persisted).length, 0)
  })

  test(`${kind} served page reads the real saved record and treats a duplicate as rejection, not a second success`, async t => {
    const { server, url, recordPath } = await pageFixture(t, kind), client = await pageClient(url)
    const value = materialExpected(materialSource()), body = JSON.stringify(value)
    assert.match(await client.send(body), /已保存（服务器记录）/u)
    assert.deepEqual(JSON.parse(client.nodes.record.textContent), value)
    const original = await readFile(recordPath, 'utf8')
    assert.deepEqual(client.calls.map(row => row.method), ['POST', 'GET'])
    assert.match(await client.send(body), /拒绝本次重复提交（HTTP 409）/u)
    assert.deepEqual(client.calls.map(row => row.method), ['POST', 'GET', 'POST'])
    assert.equal(await readFile(recordPath, 'utf8'), original)
    const evidence = await server.evidence()
    assert.equal(evidence.submissions.filter(row => row.persisted).length, 1)
    assert.equal(evidence.submissions.length, 2, 'the fixture must still expose the failed duplicate')
  })

  test(`${kind} served page keeps 5xx, lost responses, malformed success and failed readback unknown without retrying`, async t => {
    const { url } = await pageFixture(t, kind), body = JSON.stringify(materialExpected(materialSource()))
    for (const mode of ['500', '408', 'lost', 'malformed-success', 'readback-failed']) {
      const client = await pageClient(url, async (_url, options) => {
        if (options?.method !== 'POST') throw Error('synthetic failed GET')
        if (mode === 'lost') throw Error('synthetic lost response')
        if (mode === '500' || mode === '408') return new Response('{}', { status: Number(mode) })
        return new Response(mode === 'malformed-success' ? '{' : '{"saved":true}', { status: 200 })
      })
      const message = await client.send(body)
      assert.match(message, /保存结果待确认/u, mode)
      assert.doesNotMatch(message, /未接受|已保存（服务器记录）|审批/u, mode)
      assert.equal(client.calls.filter(row => row.method === 'POST').length, 1, mode)
      assert.equal(client.calls.length, mode === 'readback-failed' ? 2 : 1, mode)
    }
    for (const code of [403, 404, 405, 415, 429]) {
      const client = await pageClient(url, async () => new Response('{}', { status: code }))
      assert.ok((await client.send(body)).includes(`HTTP ${code}`))
      assert.equal(client.calls.length, 1)
    }
  })
}

test('actual truncated response page receives 200 but rejects JSON, stays unknown and resolves only by explicit GET', async t => {
  const { server, directory, source } = await fixture(t, 'response_lost'), received = []
  const client = await pageClient(server.url, async (url, options) => {
    const response = await fetch(url, options), row = { status: response.status, method: options?.method ?? 'GET',
      contentLength: response.headers.get('content-length'), connection: response.headers.get('connection') }
    received.push(row)
    const json = response.json.bind(response)
    response.json = async () => { try { const value = await json(); row.jsonComplete = true; return value }
      catch (error) { row.jsonRejected = true; throw error } }
    return response
  })
  const expected = materialExpected(source)
  assert.match(await client.send(JSON.stringify(expected)), /保存结果待确认/u)
  assert.deepEqual(received, [{ status: 200, method: 'POST', contentLength: '73', connection: 'close', jsonRejected: true }])
  assert.deepEqual(client.calls.map(row => row.method), ['POST'])
  const originalBytes = await readFile(join(directory, 'server-record.json'))
  assert.deepEqual(JSON.parse(originalBytes), expected)
  let evidence = await server.evidence()
  assert.equal(evidence.faultMode, 'truncate_after_headers')
  assert.equal(evidence.requests.filter(row => row.path.endsWith('/record')).length, 0, 'the failed body must not trigger automatic readback')
  await client.nodes.refresh.onclick()
  assert.deepEqual(client.calls.map(row => row.method), ['POST', 'GET'])
  assert.deepEqual(JSON.parse(client.nodes.record.textContent), expected)
  assert.match(client.nodes.status.textContent, /已保存（服务器记录）/u)
  evidence = await server.evidence()
  assert.equal(evidence.submissions.length, 1)
  assert.equal(evidence.droppedResponses, 1)
  const post = evidence.requests.find(row => row.method === 'POST'), entry = evidence.submissions[0], fault = entry.responseFault
  assert.equal(post.status, 200); assert.equal(post.transportFinished, true)
  assert.equal(entry.requestOrdinal, post.ordinal); assert.equal(fault.requestOrdinal, post.ordinal)
  assert.equal(fault.schema, 'xiaoshe-material-response-fault/v1'); assert.equal(fault.mode, 'truncate_after_headers')
  assert.equal(fault.termination, 'ordered_end'); assert.equal(fault.headersSent, true); assert.equal(fault.status, 200)
  assert.equal(fault.connection, 'close'); assert.equal(fault.bodyBytesPassedToEnd, Buffer.byteLength('{"saved":'))
  assert.equal(fault.declaredContentLength, fault.bodyBytesPassedToEnd + 64)
  assert.equal(fault.bodySha256, createHash('sha256').update('{"saved":').digest('hex'))
  assert.equal(fault.injectedAt, entry.responseDroppedAt)
  assert.ok(Date.parse(entry.persistedAt) <= Date.parse(fault.headersFlushedAt))
  assert.ok(Date.parse(fault.headersFlushedAt) <= Date.parse(fault.injectedAt))
  assert.ok(Date.parse(fault.injectedAt) <= Date.parse(post.finishedAt))
  assert.match(await client.send(JSON.stringify(expected)), /拒绝本次重复提交（HTTP 409）/u)
  assert.deepEqual(client.calls.map(row => row.method), ['POST', 'GET', 'POST'])
  assert.deepEqual(await readFile(join(directory, 'server-record.json')), originalBytes)
  evidence = await server.evidence()
  assert.equal(evidence.submissions.length, 2); assert.equal(evidence.submissions.filter(row => row.persisted).length, 1)
  assert.equal(evidence.submissions[1].responseFault, undefined); assert.equal(evidence.droppedResponses, 1)
})

test('page has no expected values until real save; independent disk and reload match posted content', async t => {
  const { server, directory, source } = await fixture(t)
  const expected = materialExpected(source)
  assert.equal(expected.items[1].owner, null)
  assert.equal(expected.items[1].quantity, 0)
  const before = await (await fetch(server.url)).text()
  for (const row of expected.items) assert(!before.includes(row.project))
  assert.equal((await submit(server, expected)).status, 200)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'server-record.json'), 'utf8')), expected)
  assert.deepEqual((await (await fetch(server.url + 'record')).json()).record, expected)
  assert((await (await fetch(server.url)).text()).includes(expected.items[0].project))
  assert.equal((await submit(server, expected)).status, 409)
  const evidence = await server.evidence()
  assert.equal(evidence.submissions.length, 2)
  assert.equal(evidence.submissions[0].persisted, true)
  assert.equal(evidence.submissions[1].persisted, false)
})

test('explicit legacy no-header diagnostic retains actual disconnect and is not silently made a controlled body loss', async t => {
  const { server, directory, source } = await fixture(t, 'response_lost', 'destroy_before_headers')
  const expected = materialExpected(source)
  await assert.rejects(submit(server, expected), /fetch failed/u)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'server-record.json'), 'utf8')), expected)
  assert.deepEqual((await (await fetch(server.url + 'record')).json()).record, expected)
  const evidence = await server.evidence()
  assert.equal(evidence.droppedResponses, 1)
  assert.equal(evidence.faultMode, 'destroy_before_headers')
  assert.equal(evidence.submissions.length, 1)
  assert(Date.parse(evidence.submissions[0].persistedAt) <= Date.parse(evidence.submissions[0].responseDroppedAt))
  const post = evidence.requests.find(row => row.method === 'POST'), fault = evidence.submissions[0].responseFault
  assert.equal(post.status, undefined); assert.equal(post.transportFinished, undefined)
  assert.deepEqual(fault, { schema: 'xiaoshe-material-response-fault/v1', mode: 'destroy_before_headers',
    requestOrdinal: post.ordinal, injectedAt: evidence.submissions[0].responseDroppedAt, headersFlushedAt: null,
    status: null, headersSent: false, declaredContentLength: null, bodyBytesPassedToEnd: 0,
    bodySha256: null, connection: null, termination: 'destroy' })
})

test('response fault configuration is explicit and limited to response_lost without creating new scenarios', async t => {
  const { directory, server } = await fixture(t)
  assert.equal((await server.evidence()).faultMode, null)
  for (const scenario of ['normal', 'missing_input', 'takeover']) for (const faultMode of ['truncate_after_headers', 'destroy_before_headers']) {
    await assert.rejects(startMaterialFixture({ directory, runId: randomUUID(), scenario, faultMode }), /invalid material response fault mode/u)
  }
  for (const faultMode of [null, '', false, 'silent_success', 'truncate-after-headers']) {
    await assert.rejects(startMaterialFixture({ directory, runId: randomUUID(), scenario: 'response_lost', faultMode }), /invalid material response fault mode/u)
  }
})

test('invalid payloads, cross-origin submits and unrelated paths cannot save a record', async t => {
  const { server } = await fixture(t)
  for (const value of [{}, { items: [] }, { items: [{ project: 'x', amount: 2, quantity: 1 }] }, { items: [], extra: 'x' }]) assert.equal((await submit(server, value)).status, 400)
  assert.equal((await fetch(server.url + 'save', { method: 'POST', headers: { Origin: 'https://unrelated.invalid' } })).status, 403)
  assert.equal((await fetch(new URL('/not-allowed', server.url))).status, 404)
  assert.equal((await server.evidence()).submissions.length, 0)
  await server.close()
  assert.equal((await server.evidence()).closed, true)
})

test('closing an in-flight partial POST prevents writes after cleanup is declared complete', { timeout: 5000 }, async t => {
  const { server, directory, source } = await fixture(t)
  const body = JSON.stringify(materialExpected(source))
  const pending = request(server.url + 'save', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
  } })
  pending.on('error', () => {})
  const disconnected = new Promise(done => pending.once('close', done))
  pending.write(body.slice(0, -1))
  while (!(await server.evidence()).requests.length) await delay(5)
  await server.close()
  pending.end(body.slice(-1))
  await disconnected
  const evidence = await server.evidence()
  assert.equal(evidence.closed, true)
  assert.equal(evidence.submissions.length, 0)
  assert.equal(evidence.record, null)
  await assert.rejects(readFile(join(directory, 'server-record.json')), { code: 'ENOENT' })
})
