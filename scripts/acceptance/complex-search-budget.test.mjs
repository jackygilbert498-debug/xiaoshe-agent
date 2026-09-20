import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { AgentRegistry } from '../../runtime/DSH/packages/core/agent/lib/index.js'
import { WebRuntime } from '../../runtime/DSH/packages/web/web/lib/index.js'
import { DeepSeekSearchProvider, DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MODEL } from '../../runtime/DSH/packages/web/web-search-deepseek/lib/index.js'
import { createComplexSearchBudget, readComplexSearchLedger, installComplexSearchBudget, SEARCH_ROUTE, searchUsage } from './complex-search-budget.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const key = 'synthetic-test-credential-not-real'
const payload = (usage = { input_tokens: 7, output_tokens: 3 }) => ({ content: [
  { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.org/public', title: 'Public component result' }] },
  { type: 'text', citations: [{ url: 'https://example.org/public', cited_text: 'Synthetic component snippet' }] },
], usage })
const options = overrides => ({ ...SEARCH_ROUTE, apiKey: key, ...overrides })
async function fixture(t, liveAuthorized = true) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'xs-complex-search-component-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, config: { ledgerDirectory: join(root, 'budget'), runId: randomUUID(), sessionId: 'prebound-online-session', liveAuthorized } }
}
const credentials = { resolveApiKey: async () => key }
const search = (gate, config, query = 'public component query', signal) => gate.search(config.sessionId, { query, maxResults: 5 }, signal, credentials)
async function ledgerText(config) {
  return (await Promise.all((await fs.readdir(config.ledgerDirectory)).map(name => fs.readFile(join(config.ledgerDirectory, name), 'utf8')))).join('\n')
}

test('provider DI retains official defaults, exact body and record-before-transport order', async () => {
  assert.equal(DEEPSEEK_DEFAULT_BASE_URL, SEARCH_ROUTE.baseURL); assert.equal(DEEPSEEK_DEFAULT_MODEL, SEARCH_ROUTE.model)
  const order = [], requests = []
  const provider = new DeepSeekSearchProvider(() => options({ recordRequest: value => { order.push('record'); requests.push(value) } }), async (url, init) => {
    order.push('transport'); assert.equal(url, SEARCH_ROUTE.endpoint); assert.equal(init.redirect, 'error')
    assert.equal(init.headers['x-api-key'], key); assert.equal(init.headers.authorization, `Bearer ${key}`)
    assert.deepEqual(JSON.parse(init.body), requests[0].body)
    return Response.json(payload())
  })
  const result = await provider.search({ query: 'public query' })
  assert.deepEqual(order, ['record', 'transport']); assert.equal(result.sources[0].snippet, 'Synthetic component snippet')
  assert.equal(requests[0].body.max_tokens, 2048); assert.equal(requests[0].body.tools[0].max_uses, 5)
  let calls = 0
  const rejected = new DeepSeekSearchProvider(() => options({ recordRequest: () => { throw Error('pre-dispatch record failed') } }), async () => { calls++; return Response.json(payload()) })
  await assert.rejects(rejected.search({ query: 'public query' }), /pre-dispatch/u); assert.equal(calls, 0)
})

test('omitted transport still uses native fetch against a private loopback component, with no retry', async t => {
  let calls = 0; const order = []
  const server = createServer(async (req, res) => {
    calls++; order.push('network'); let text = ''; for await (const chunk of req) text += chunk
    assert.equal(req.url, '/messages'); assert.equal(JSON.parse(text).model, SEARCH_ROUTE.model)
    const rejected = JSON.parse(text).messages[0].content[0].text.includes('local HTTP failure')
    res.writeHead(rejected ? 503 : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(rejected ? { error: { message: 'private component failure' } } : payload()))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const provider = new DeepSeekSearchProvider(() => options({ baseURL: `http://127.0.0.1:${server.address().port}`, recordRequest: () => { order.push('record') } }))
  assert.equal((await provider.search({ query: 'local component only' })).sources.length, 1); assert.equal(calls, 1)
  await assert.rejects(provider.search({ query: 'local HTTP failure' }), error => error.code === 'WEB_PROVIDER_ERROR')
  assert.equal(calls, 2); assert.deepEqual(order, ['record', 'network', 'record', 'network'])
  const controller = new AbortController(); controller.abort()
  await assert.rejects(provider.search({ query: 'cancelled' }, controller.signal), error => error.code === 'WEB_ABORTED')
  assert.equal(calls, 2)
})

test('unapproved zero mode mounts but resolves no credential and dispatches no HTTP even before ready', async t => {
  const { config } = await fixture(t, false); let calls = 0, resolved = 0, recorded = 0
  const gate = createComplexSearchBudget(config, { fetcher: async () => { calls++; return Response.json(payload()) } })
  await assert.rejects(gate.search(config.sessionId, { query: 'query' }, undefined,
    { resolveApiKey: async () => { resolved++; return key }, recordRequest: () => { recorded++ } }), /SEARCH_NOT_AUTHORIZED/u)
  const result = await gate.snapshot()
  assert.equal(result.mode, 'no_search'); assert.equal(result.maxRequests, 0); assert.equal(result.mounts.length, 1)
  assert.equal(result.reservedRequests, 0); assert.equal(result.deniedRequests, 1)
  assert.deepEqual([calls, resolved, recorded], [0, 0, 0])
})

test('real Cordis web provider uses the current initiator and same-fiber unload removes it', async t => {
  const { config } = await fixture(t, false), ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new WebRuntime(ctx, { searchProvider: SEARCH_ROUTE.provider }); const agents = new AgentRegistry(ctx)
  let resolutions = 0
  class TestCredentials extends Service { constructor(ctx) { super(ctx, 'credentials') } async resolve() { resolutions++; return { value: key } } }
  new TestCredentials(ctx)
  let gate
  const fiber = ctx.plugin({ name: 'component-search-budget', inject: ['web', 'agents'], apply(child) { gate = installComplexSearchBudget(child, config) } })
  await fiber; await gate.ready
  await assert.rejects(agents.withInitiator({ session: { id: config.sessionId, append() { assert.fail('not in no-search mode') } } },
    () => ctx.web.search({ query: 'public query' })), /SEARCH_NOT_AUTHORIZED/u)
  assert.equal(resolutions, 0)
  await fiber.dispose()
  await assert.rejects(ctx.web.search({ query: 'gone' }), error => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING')
})

test('endpoint/model/slots/credentials cannot be supplied through Profile config', async t => {
  const { config } = await fixture(t)
  for (const change of [{ endpoint: 'https://other.invalid' }, { model: 'other' }, { maxRequests: 99 }, { apiKey: key },
    { liveAuthorized: 'true' }, { sessionIds: ['a'] }, { sessionId: '' }, { ledgerDirectory: 'relative' }, { fetcher: () => {} }]) {
    assert.throws(() => createComplexSearchBudget({ ...config, ...change }), /SEARCH_INVALID_CONFIG/u)
  }
  assert.throws(() => { SEARCH_ROUTE.endpoint = 'https://other.invalid' }, TypeError)
})

test('foreign/agentless sessions fail before credentials or HTTP and cannot borrow the online binding', async t => {
  const { config } = await fixture(t); let calls = 0, resolved = 0
  const gate = createComplexSearchBudget(config, { fetcher: async () => { calls++; return Response.json(payload()) } })
  for (const session of [undefined, 'other-scenario', `${config.sessionId}-suffix`]) await assert.rejects(gate.search(session,
    { query: 'query' }, undefined, { resolveApiKey: async () => { resolved++; return key } }), /SEARCH_SESSION_DENIED/u)
  assert.deepEqual([calls, resolved], [0, 0]); assert.equal((await gate.snapshot()).deniedRequests, 3)
})

test('every physical dispatch observes a durable reservation; twelve concurrent searches consume at most eight slots', async t => {
  const { config } = await fixture(t); let calls = 0; const durable = new Set(), written = new Set()
  const io = { ...fs, open: async (path, ...args) => {
    const handle = await fs.open(path, ...args), sync = handle.sync.bind(handle)
    handle.sync = async () => { await sync(); if (/request-\d+\.json$/u.test(path)) written.add(path); if (path === config.ledgerDirectory) for (const p of written) durable.add(p) }
    return handle
  } }
  const gate = createComplexSearchBudget(config, { io, fetcher: async (_url, init) => {
    calls++; const rows = await Promise.all([...durable].map(p => fs.readFile(p, 'utf8').then(JSON.parse)))
    assert.ok(rows.some(row => row.bodySha256 === hash(init.body)))
    await new Promise(resolve => setTimeout(resolve, 2)); return Response.json(payload())
  } })
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => search(gate, config, `public query ${i}`)))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 8); assert.equal(calls, 8)
  const result = await gate.snapshot()
  assert.equal(result.reservedRequests, 8); assert.equal(result.dispatchedRequests, 8); assert.equal(result.finishedRequests, 8)
  assert.equal(result.deniedRequests, 4); assert.equal(result.remainingRequests, 0)
  assert.deepEqual(result.requests.map(row => row.ordinal), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(result.totalUsage.inputTokens, 56); assert.equal(result.totalUsage.cacheWriteTokens, null)
  assert.equal((await ledgerText(config)).includes(key), false)
})

test('a second mounted gate shares consumed slots rather than resetting them', async t => {
  const { config } = await fixture(t); let calls = 0
  const fetcher = async () => { calls++; return Response.json(payload()) }
  const first = createComplexSearchBudget(config, { fetcher }); await search(first, config)
  const second = createComplexSearchBudget(config, { fetcher }); await second.ready
  await Promise.all(Array.from({ length: 7 }, () => search(second, config)))
  await assert.rejects(search(first, config)); const r = await second.snapshot()
  assert.equal(calls, 8); assert.equal(r.mounts.length, 2); assert.equal(r.reservedRequests, 8)
})

test('response usage is numeric-only, optional fields remain null and absent usage remains unknown', async t => {
  assert.equal(searchUsage({ usage: { input_tokens: '7', output_tokens: 3 } }), null)
  assert.deepEqual(searchUsage({ usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1, reasoning_tokens: 0, server_tool_use: { web_search_requests: 4 } } }),
  { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 0, serverSearchUses: 4 })
  const { config } = await fixture(t)
  const gate = createComplexSearchBudget(config, { fetcher: async () => Response.json(payload(null)) })
  await search(gate, config); const r = await gate.snapshot()
  assert.equal(r.finishedRequests, 1); assert.equal(r.unknownUsageRequests, 1); assert.equal(r.totalUsage, null); assert.equal(r.cost, null)
})

test('HTTP failure, malformed JSON and provider mapping failure preserve status without retry or secret errors', async t => {
  const { config } = await fixture(t); let calls = 0
  const responses = [Response.json({ error: { message: key } }, { status: 429 }), new Response('broken-json', { status: 200 }),
    Response.json({ content: [], usage: { input_tokens: 9, output_tokens: 4 } })]
  const gate = createComplexSearchBudget(config, { fetcher: async () => responses[calls++] })
  for (let i = 0; i < 3; i++) await assert.rejects(search(gate, config), error => !String(error).includes(key) && error.cause === undefined)
  const r = await gate.snapshot()
  assert.equal(calls, 3); assert.equal(r.errorRequests, 3)
  assert.deepEqual(r.requests.map(row => row.receipt.httpStatus), [429, 200, 200])
  assert.equal(r.requests[2].receipt.usage.inputTokens, 9)
  assert.equal((await ledgerText(config)).includes(key), false)
})

test('transport error/cancellation never retries and error causes are not exposed', async t => {
  const { config } = await fixture(t); let calls = 0
  const controller = new AbortController()
  const gate = createComplexSearchBudget(config, { fetcher: async () => { calls++; controller.abort(key); throw Error(key) } })
  await assert.rejects(search(gate, config, 'public', controller.signal), error => error.cause === undefined && !String(error).includes(key))
  const r = await gate.snapshot(); assert.equal(calls, 1); assert.equal(r.requests[0].receipt.outcome, 'aborted')
  assert.equal(r.requests[0].receipt.httpStatus, null); assert.equal(r.requests[0].receipt.usage, null)
  await assert.rejects(search(gate, config, 'already aborted', controller.signal), /SEARCH_ALREADY_ABORTED/u)
  assert.equal(calls, 1); assert.equal((await gate.snapshot()).reservedRequests, 1)
})

test('cancellation after durable reserve consumes the slot but records no HTTP dispatch', async t => {
  const { config } = await fixture(t), controller = new AbortController(); let reserved = false, calls = 0
  const io = { ...fs, open: async (path, ...args) => {
    const handle = await fs.open(path, ...args), sync = handle.sync.bind(handle)
    handle.sync = async () => { await sync(); if (/request-1\.json$/u.test(path)) reserved = true; if (path === config.ledgerDirectory && reserved) controller.abort() }
    return handle
  } }
  const gate = createComplexSearchBudget(config, { io, fetcher: async () => { calls++; return Response.json(payload()) } })
  await assert.rejects(search(gate, config, 'public', controller.signal))
  const r = await gate.snapshot(); assert.equal(calls, 0); assert.equal(r.reservedRequests, 1)
  assert.equal(r.dispatchedRequests, 0); assert.equal(r.requests[0].receipt.outcome, 'aborted')
})

test('partial reservation failure stays consumed and closes all later dispatch', async t => {
  const { config } = await fixture(t); let calls = 0
  const io = { ...fs, open: async (path, ...args) => {
    const handle = await fs.open(path, ...args)
    if (/request-1\.json$/u.test(path) && args[0] === 'wx') handle.writeFile = async () => { await handle.write('{'); throw Object.assign(Error(key), { code: 'EIO' }) }
    return handle
  } }
  const gate = createComplexSearchBudget(config, { io, fetcher: async () => { calls++; return Response.json(payload()) } })
  await assert.rejects(search(gate, config), error => !String(error).includes(key))
  await assert.rejects(search(gate, config), /SEARCH_LEDGER_UNAVAILABLE/u)
  assert.equal(calls, 0); assert.equal(await fs.readFile(join(config.ledgerDirectory, 'request-1.json'), 'utf8'), '{')
})

test('receipt persistence failure after HTTP closes future calls and never refunds the reservation', async t => {
  const { config } = await fixture(t); let calls = 0
  const io = { ...fs, open: async (path, ...args) => {
    if (/receipt-1\.json$/u.test(path) && args[0] === 'wx') throw Object.assign(Error(key), { code: 'EIO' })
    return fs.open(path, ...args)
  } }
  const gate = createComplexSearchBudget(config, { io, fetcher: async () => { calls++; return Response.json(payload()) } })
  await assert.rejects(search(gate, config), /SEARCH_LEDGER_UNAVAILABLE/u)
  await assert.rejects(search(gate, config), /SEARCH_LEDGER_UNAVAILABLE/u)
  const r = await readComplexSearchLedger(config.ledgerDirectory)
  assert.equal(calls, 1); assert.equal(r.reservedRequests, 1); assert.equal(r.unknownDispatchRequests, 1); assert.equal(r.requests[0].outcome, 'unknown')
})

test('manifest identity changes and directory substitution fail closed', async t => {
  const { root, config } = await fixture(t); let calls = 0
  const gate = createComplexSearchBudget(config, { fetcher: async () => { calls++; return Response.json(payload()) } }); await gate.ready
  const other = createComplexSearchBudget({ ...config, liveAuthorized: false })
  await assert.rejects(other.ready, /SEARCH_IDENTITY_MISMATCH/u)
  await fs.rename(config.ledgerDirectory, join(root, 'original-budget'))
  await fs.mkdir(join(root, 'foreign')); await fs.symlink(join(root, 'foreign'), config.ledgerDirectory)
  await assert.rejects(search(gate, config), /SEARCH_LEDGER_UNAVAILABLE/u)
  assert.equal(calls, 0); assert.deepEqual(await fs.readdir(join(root, 'foreign')), [])
})

test('parallel provider instances do not cross-bind query bodies or request observations', async t => {
  const { config } = await fixture(t), recorded = [], sent = []
  const gate = createComplexSearchBudget(config, { fetcher: async (_url, init) => { sent.push(JSON.parse(init.body)); return Response.json(payload()) } })
  await Promise.all(['one', 'two'].map(query => gate.search(config.sessionId, { query }, undefined, {
    resolveApiKey: async () => { await new Promise(resolve => setTimeout(resolve, query === 'one' ? 5 : 1)); return key },
    recordRequest: value => { recorded.push(value.body); assert.equal(value.body.messages[0].content[0].text, `Perform a web search for the query: ${query}`) },
  })))
  assert.equal(sent.length, 2); assert.deepEqual(sent, recorded)
  assert.equal((await gate.snapshot()).reservedRequests, 2)
})

test('real currentInitiator binding permits only the prebound session under concurrent Cordis calls', async t => {
  const { config } = await fixture(t), ctx = new Context(); let calls = 0, resolutions = 0
  t.after(() => ctx.fiber.dispose())
  new WebRuntime(ctx, { searchProvider: SEARCH_ROUTE.provider }); const agents = new AgentRegistry(ctx), recorded = []
  class TestCredentials extends Service { constructor(ctx) { super(ctx, 'credentials') } async resolve(ref) {
    assert.equal(ref, 'DEEPSEEK_API_KEY'); resolutions++; return { value: key }
  } }
  new TestCredentials(ctx); let gate
  const fiber = ctx.plugin({ name: 'bound-search-component', inject: ['web', 'agents'], apply(child) {
    gate = installComplexSearchBudget(child, config, { fetcher: async () => { calls++; return Response.json(payload()) } })
  } })
  await fiber; await gate.ready
  const results = await Promise.allSettled([config.sessionId, 'foreign-session'].map(id => agents.withInitiator({ session: {
    id, append(event) { assert.equal(id, config.sessionId); recorded.push(event) },
  } }, () => ctx.web.search({ query: `public query ${id}` }))))
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'SEARCH_SESSION_DENIED')
  assert.deepEqual([calls, resolutions, recorded.length], [1, 1, 1])
  assert.equal(recorded[0], 'web/deepseek-search-llm-request'); assert.equal((await gate.snapshot()).deniedRequests, 1)
})

test('invalid search inputs are denied before credentials; arbitrary error codes and causes are sanitized', async t => {
  const { config } = await fixture(t); let calls = 0, resolved = 0
  const gate = createComplexSearchBudget(config, { fetcher: async () => { calls++; return Response.json(payload()) } })
  for (const request of [{ query: '' }, { query: 'public', endpoint: 'https://other.invalid' }, { query: 'public', maxResults: 0 }, { query: 'x'.repeat(4097) }]) {
    await assert.rejects(gate.search(config.sessionId, request, undefined, { resolveApiKey: async () => { resolved++; return key } }), /SEARCH_REQUEST_DENIED/u)
  }
  assert.deepEqual([calls, resolved], [0, 0])
  await assert.rejects(gate.search(config.sessionId, { query: 'public' }, undefined, {
    resolveApiKey: async () => key,
    recordRequest: () => { throw Object.assign(Error(key), { code: 'SEARCH_SECRET_MARKER', cause: Error(key) }) },
  }), error => error.code === 'SEARCH_FAILED' && error.cause === undefined && !String(error).includes(key))
  assert.equal(calls, 0); assert.equal((await gate.snapshot()).reservedRequests, 0)
})

test('post-run reader rejects fabricated fixed fields, success state or extra secret properties', async t => {
  const { config } = await fixture(t)
  const gate = createComplexSearchBudget(config, { fetcher: async () => Response.json(payload()) }); await search(gate, config)
  const file = join(config.ledgerDirectory, 'receipt-1.json'), original = await fs.readFile(file, 'utf8'), receipt = JSON.parse(original)
  for (const change of [{ authorization: key }, { dispatched: false }, { httpStatus: null }, { errorCode: 'SEARCH_SECRET_MARKER' }]) {
    await fs.writeFile(file, JSON.stringify({ ...receipt, ...change })); await assert.rejects(readComplexSearchLedger(config.ledgerDirectory), /SEARCH_INVALID_RECEIPT/u)
  }
  await fs.writeFile(file, original)
  assert.equal((await readComplexSearchLedger(config.ledgerDirectory)).finishedRequests, 1)
})
