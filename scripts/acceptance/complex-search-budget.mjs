// Acceptance-only physical DeepSeek search budget. Not a money cap or a
// sandbox for unrelated adapters/direct networking. Never load in a daily Profile.
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DeepSeekSearchProvider } from '../../runtime/DSH/packages/web/web-search-deepseek/lib/index.js'

export const name = 'xiaoshe-complex-search-budget'
export const inject = ['web', 'agents']
export const MAX_SEARCH_REQUESTS = 8
export const SEARCH_ROUTE = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-flash',
  baseURL: 'https://api.deepseek.com/anthropic/v1', endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
  apiVersion: '2023-06-01', maxTokens: 2048, maxUses: 5, retries: 0 })
const schema = 'xiaoshe-complex-search-budget/v1'
const usageKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
const safeCodes = new Set(['WEB_ABORTED', 'WEB_PROVIDER_ERROR', 'WEB_PROVIDER_CREDENTIAL_MISSING',
  'SEARCH_FAILED', 'SEARCH_LEDGER_UNAVAILABLE', 'SEARCH_IDENTITY_MISMATCH', 'SEARCH_NOT_AUTHORIZED',
  'SEARCH_SESSION_DENIED', 'SEARCH_REQUEST_DENIED', 'SEARCH_ALREADY_ABORTED', 'SEARCH_ROUTE_DENIED',
  'SEARCH_BUDGET_EXHAUSTED', 'SEARCH_TRANSPORT_DI_UNAVAILABLE'])
const sha = value => createHash('sha256').update(value).digest('hex')
const fail = code => Object.assign(new Error(`complex-search-budget: ${code}`), { code })
const now = () => new Date().toISOString()
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/u.test(value)
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const numeric = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink
// APFS directory nlink changes when entries are added. It is not a stable
// directory identity; regular evidence files still require exactly one link.
const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode
const safeError = error => fail(safeCodes.has(error?.code) ? error.code : 'SEARCH_FAILED')
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',')

function identity(config) {
  if (!config || Object.keys(config).some(key => !['ledgerDirectory', 'runId', 'sessionId', 'liveAuthorized'].includes(key))
    || typeof config.ledgerDirectory !== 'string' || !isAbsolute(config.ledgerDirectory) || resolve(config.ledgerDirectory) !== config.ledgerDirectory
    || !textId(config.runId) || !textId(config.sessionId)
    || config.liveAuthorized !== undefined && typeof config.liveAuthorized !== 'boolean') throw fail('SEARCH_INVALID_CONFIG')
  return Object.freeze({ schema, runId: config.runId, sessionId: config.sessionId,
    scenario: 'offline-to-online-topic-switch', mode: config.liveAuthorized === true ? 'bounded_search' : 'no_search',
    maxRequests: config.liveAuthorized === true ? MAX_SEARCH_REQUESTS : 0, ...SEARCH_ROUTE })
}

async function readJson(io, path) {
  const before = await io.lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65536
    || typeof process.getuid === 'function' && before.uid !== process.getuid() || (before.mode & 0o7777) !== 0o600) throw fail('SEARCH_INVALID_LEDGER')
  const file = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat(), bytes = await file.readFile(), after = await io.lstat(path)
    if (!same(before, opened) || !same(before, after) || before.size !== bytes.length || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail('SEARCH_INVALID_LEDGER')
    return JSON.parse(bytes)
  } finally { await file.close() }
}

/** Unknown values are null. No provider message, key, header, body or query is retained. */
export function searchUsage(payload) {
  const usage = payload?.usage
  if (numeric(usage?.input_tokens) === null || numeric(usage?.output_tokens) === null) return null
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    cacheReadTokens: numeric(usage.cache_read_input_tokens), cacheWriteTokens: numeric(usage.cache_creation_input_tokens),
    reasoningTokens: numeric(usage.reasoning_tokens), serverSearchUses: numeric(usage.server_tool_use?.web_search_requests) }
}

function checkRow(row, manifest, ordinal) {
  if (!exactKeys(row, ['schema', 'runId', 'sessionId', 'ordinal', 'pid', 'at', 'bodySha256', 'bodyBytes'])
    || row.schema !== schema || row.runId !== manifest.runId || row.sessionId !== manifest.sessionId
    || row.ordinal !== ordinal || !Number.isSafeInteger(row.pid) || row.pid < 1 || !validTime(row.at)
    || !/^[a-f\d]{64}$/u.test(row.bodySha256 ?? '') || !Number.isSafeInteger(row.bodyBytes) || row.bodyBytes < 1) throw fail('SEARCH_INVALID_REQUEST')
}

/** Post-run reader: reservations without complete receipts remain unknown, never refunded. */
export async function readComplexSearchLedger(ledgerDirectory, io = fs) {
  const directory = await io.lstat(ledgerDirectory)
  if (!directory.isDirectory() || directory.isSymbolicLink() || await io.realpath(ledgerDirectory) !== ledgerDirectory
    || (directory.mode & 0o7777) !== 0o700 || typeof process.getuid === 'function' && directory.uid !== process.getuid()) throw fail('SEARCH_INVALID_LEDGER')
  const manifest = await readJson(io, join(ledgerDirectory, 'manifest.json'))
  const expected = identity({ ledgerDirectory, runId: manifest.runId, sessionId: manifest.sessionId, liveAuthorized: manifest.mode === 'bounded_search' })
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw fail('SEARCH_IDENTITY_MISMATCH')
  const names = await io.readdir(ledgerDirectory), requests = [], mounts = [], denied = []
  for (const file of names) {
    if (file === 'manifest.json') continue
    let match
    if ((match = /^request-(\d+)\.json$/u.exec(file))) {
      const ordinal = Number(match[1]); if (ordinal < 1 || ordinal > manifest.maxRequests || String(ordinal) !== match[1]) throw fail('SEARCH_INVALID_REQUEST')
      const request = await readJson(io, join(ledgerDirectory, file)); checkRow(request, manifest, ordinal)
      let receipt = null
      try { receipt = await readJson(io, join(ledgerDirectory, `receipt-${ordinal}.json`)) } catch { /* Missing/torn means unknown. */ }
      if (receipt && (!exactKeys(receipt, ['schema', 'runId', 'sessionId', 'ordinal', 'pid', 'at', 'dispatched', 'httpStatus', 'usage', 'outcome', 'errorCode'])
        || receipt.schema !== schema || receipt.runId !== manifest.runId || receipt.sessionId !== manifest.sessionId
        || receipt.ordinal !== ordinal || receipt.pid !== request.pid || !validTime(receipt.at)
        || Date.parse(receipt.at) < Date.parse(request.at) || typeof receipt.dispatched !== 'boolean'
        || !['finished', 'error', 'aborted'].includes(receipt.outcome)
        || receipt.httpStatus !== null && (!Number.isInteger(receipt.httpStatus) || receipt.httpStatus < 100 || receipt.httpStatus > 599)
        || receipt.errorCode !== null && !safeCodes.has(receipt.errorCode)
        || receipt.outcome === 'finished' && (!receipt.dispatched || receipt.httpStatus < 200 || receipt.httpStatus >= 300 || receipt.errorCode !== null)
        || receipt.outcome !== 'finished' && receipt.errorCode === null
        || !receipt.dispatched && (receipt.httpStatus !== null || receipt.usage !== null))) throw fail('SEARCH_INVALID_RECEIPT')
      if (receipt?.usage !== null && receipt?.usage !== undefined && (Object.keys(receipt.usage).sort().join(',') !== [...usageKeys, 'serverSearchUses'].sort().join(',')
        || ['inputTokens', 'outputTokens'].some(key => numeric(receipt.usage[key]) === null)
        || Object.values(receipt.usage).some(value => value !== null && numeric(value) === null))) throw fail('SEARCH_INVALID_USAGE')
      requests.push({ ...request, receipt, outcome: receipt?.outcome ?? 'unknown' })
    } else if (/^receipt-\d+\.json$/u.test(file)) {
      if (!names.includes(file.replace('receipt-', 'request-'))) throw fail('SEARCH_ORPHAN_RECEIPT')
    } else if (/^mounted-\d+-[a-f\d-]{36}\.json$/u.test(file)) {
      const row = await readJson(io, join(ledgerDirectory, file))
      if (!exactKeys(row, ['schema', 'runId', 'sessionId', 'pid', 'at'])
        || row.schema !== schema || row.runId !== manifest.runId || row.sessionId !== manifest.sessionId || !Number.isSafeInteger(row.pid)
        || row.pid < 1 || !file.startsWith(`mounted-${row.pid}-`) || !validTime(row.at)) throw fail('SEARCH_INVALID_MOUNT')
      mounts.push(row)
    } else if (/^denied-[a-f\d-]{36}\.json$/u.test(file)) {
      const row = await readJson(io, join(ledgerDirectory, file))
      if (!exactKeys(row, ['schema', 'runId', 'sessionId', 'reason', 'at'])
        || row.schema !== schema || row.runId !== manifest.runId || row.sessionId !== manifest.sessionId
        || !safeCodes.has(row.reason) || !validTime(row.at)) throw fail('SEARCH_INVALID_DENIAL')
      denied.push(row)
    } else throw fail('SEARCH_UNKNOWN_LEDGER_ENTRY')
  }
  requests.sort((a, b) => a.ordinal - b.ordinal)
  if (requests.some((row, i) => row.ordinal !== i + 1)) throw fail('SEARCH_REQUEST_GAP')
  if (!mounts.length || requests.some(row => !mounts.some(mount => mount.pid === row.pid && mount.at <= row.at))) throw fail('SEARCH_INVALID_MOUNT')
  if (!sameDirectory(directory, await io.lstat(ledgerDirectory)) || await io.realpath(ledgerDirectory) !== ledgerDirectory) throw fail('SEARCH_INVALID_LEDGER')
  const totalUsage = requests.length && requests.every(row => row.receipt?.usage)
    ? Object.fromEntries([...usageKeys, 'serverSearchUses'].map(key => [key, requests.every(row => row.receipt.usage[key] !== null)
      ? numeric(requests.reduce((sum, row) => sum + row.receipt.usage[key], 0)) : null])) : null
  return { schema, runId: manifest.runId, sessionId: manifest.sessionId, mode: manifest.mode, route: SEARCH_ROUTE,
    maxRequests: manifest.maxRequests, reservedRequests: requests.length,
    dispatchedRequests: requests.filter(row => row.receipt?.dispatched).length,
    unknownDispatchRequests: requests.filter(row => !row.receipt).length,
    finishedRequests: requests.filter(row => row.outcome === 'finished').length,
    errorRequests: requests.filter(row => ['error', 'aborted'].includes(row.outcome)).length,
    deniedRequests: denied.length, remainingRequests: manifest.maxRequests - requests.length,
    unknownUsageRequests: requests.filter(row => !row.receipt?.usage).length, totalUsage,
    monetaryHardCap: false, cost: null, mounts, requests, denied }
}

/** io/fetcher are trusted component-test dependencies, never Profile options. */
export function createComplexSearchBudget(config, { io = fs, fetcher = globalThis.fetch } = {}) {
  const manifest = identity(config), directory = config.ledgerDirectory
  if (typeof fetcher !== 'function') throw fail('SEARCH_TRANSPORT_MISSING')
  let owned, fatal
  const path = name => join(directory, name)
  const poison = () => (fatal = fail('SEARCH_LEDGER_UNAVAILABLE'))
  async function assertDirectory() {
    const actual = await io.lstat(directory)
    if (!actual.isDirectory() || actual.isSymbolicLink() || await io.realpath(directory) !== directory
      || (actual.mode & 0o7777) !== 0o700 || typeof process.getuid === 'function' && actual.uid !== process.getuid()
      || owned && !sameDirectory(owned, actual)) throw fail('SEARCH_LEDGER_UNAVAILABLE')
    owned ??= actual
  }
  async function syncDirectory() {
    await assertDirectory()
    const handle = await io.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0))
    try { if (!sameDirectory(owned, await handle.stat())) throw fail('SEARCH_LEDGER_UNAVAILABLE'); await handle.sync(); await assertDirectory() }
    finally { await handle.close() }
  }
  async function exclusive(file, value) {
    await assertDirectory()
    const handle = await io.open(path(file), 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync() } finally { await handle.close() }
    await syncDirectory() // The request directory entry is durable before dispatch, not just its file contents.
  }
  const ready = (async () => {
    try { await io.mkdir(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    await assertDirectory()
    try { await exclusive('manifest.json', manifest) } catch (error) { if (error.code !== 'EEXIST') throw error }
    if (JSON.stringify(await readJson(io, path('manifest.json'))) !== JSON.stringify(manifest)) throw fail('SEARCH_IDENTITY_MISMATCH')
    const id = `${process.pid}-${randomUUID()}`, pending = `pending-${id}.json`
    await exclusive(pending, { schema, runId: manifest.runId, sessionId: manifest.sessionId, pid: process.pid, at: now() })
    await io.rename(path(pending), path(`mounted-${id}.json`)); await syncDirectory()
  })().catch(error => { fatal = error?.code === 'SEARCH_IDENTITY_MISMATCH' ? fail(error.code) : poison(); throw fatal })
  ready.catch(() => {})
  const assertReady = async () => {
    await ready; if (fatal) throw fatal
    try { await assertDirectory(); if (JSON.stringify(await readJson(io, path('manifest.json'))) !== JSON.stringify(manifest)) throw fail('SEARCH_IDENTITY_MISMATCH') }
    catch { throw poison() }
  }
  async function deny(reason) {
    try { await exclusive(`denied-${randomUUID()}.json`, { schema, runId: manifest.runId, sessionId: manifest.sessionId, reason, at: now() }) }
    catch { throw poison() }
    throw fail(reason)
  }
  return {
    ready,
    snapshot: async () => { await assertReady(); return readComplexSearchLedger(directory, io) },
    async search(sessionId, request, signal, { resolveApiKey, recordRequest } = {}) {
      await assertReady()
      if (manifest.maxRequests === 0) return deny('SEARCH_NOT_AUTHORIZED')
      if (sessionId !== manifest.sessionId) return deny('SEARCH_SESSION_DENIED')
      if (!request || ![Object.prototype, null].includes(Object.getPrototypeOf(request))
        || Object.keys(request).some(key => !['query', 'maxResults'].includes(key))
        || typeof request.query !== 'string' || !request.query.trim() || request.query.length > 4096
        || request.maxResults !== undefined && (!Number.isSafeInteger(request.maxResults) || request.maxResults < 1 || request.maxResults > 50)) return deny('SEARCH_REQUEST_DENIED')
      const query = request.query, maxResults = request.maxResults
      if (signal?.aborted) return deny('SEARCH_ALREADY_ABORTED')
      const attempts = []; let transportFailure
      const dispatch = async (input, init) => {
        await assertReady()
        if (input !== SEARCH_ROUTE.endpoint || init?.method !== 'POST' || init.redirect !== 'error' || init.signal !== signal
          || typeof init.body !== 'string' || init.body.length > 65536) return deny('SEARCH_ROUTE_DENIED')
        let body
        try { body = JSON.parse(init.body) } catch { return deny('SEARCH_ROUTE_DENIED') }
        const expectedBody = { model: SEARCH_ROUTE.model, max_tokens: SEARCH_ROUTE.maxTokens,
          messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: SEARCH_ROUTE.maxUses }] }
        if (JSON.stringify(body) !== JSON.stringify(expectedBody)) return deny('SEARCH_ROUTE_DENIED')
        if (signal?.aborted) return deny('SEARCH_ALREADY_ABORTED')
        let ordinal
        for (let slot = 1; slot <= manifest.maxRequests; slot++) {
          try { await exclusive(`request-${slot}.json`, { schema, runId: manifest.runId, sessionId: manifest.sessionId,
            ordinal: slot, pid: process.pid, at: now(), bodySha256: sha(init.body), bodyBytes: Buffer.byteLength(init.body) }); ordinal = slot; break }
          catch (error) { if (error.code !== 'EEXIST') throw poison() }
        }
        if (!ordinal) return deny('SEARCH_BUDGET_EXHAUSTED')
        const attempt = { ordinal, dispatched: false, httpStatus: null, usage: null }; attempts.push(attempt)
        if (fatal) throw fatal
        if (signal?.aborted) throw fail('SEARCH_ALREADY_ABORTED')
        attempt.dispatched = true
        const response = await fetcher(input, init) // Exactly one HTTP attempt; no retry or redirect follow.
        attempt.httpStatus = response.status
        // Observe the exact JSON the real provider consumes; never clone/log a
        // secret-bearing request or replace its result mapping/error semantics.
        return new Proxy(response, { get(target, key) {
          if (key === 'json') return async () => { const payload = await target.json(); attempt.usage = searchUsage(payload); return payload }
          const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
        } })
      }
      const transport = async (input, init) => {
        try { return await dispatch(input, init) } catch (error) {
          // The provider intentionally wraps transport failures. Keep only our
          // finite guard code, never the provider's message or nested cause.
          if (safeCodes.has(error?.code) && error.code.startsWith('SEARCH_')) transportFailure = error
          throw error
        }
      }
      let errorCode = null, outcome = 'error'
      try {
        const provider = new DeepSeekSearchProvider(() => ({ ...SEARCH_ROUTE, resolveApiKey, apiKeyEnv: 'DEEPSEEK_API_KEY', recordRequest }), transport)
        // Fail closed on stale compiled code which predates the constructor DI.
        if (Object.getOwnPropertyDescriptor(provider, 'transport')?.value !== transport) throw fail('SEARCH_TRANSPORT_DI_UNAVAILABLE')
        const result = await provider.search({ query, ...(maxResults === undefined ? {} : { maxResults }) }, signal)
        outcome = 'finished'; return result
      } catch (error) {
        const safe = safeError(transportFailure ?? error); errorCode = safe.code
        if (signal?.aborted || safe.code === 'WEB_ABORTED' || safe.code === 'SEARCH_ALREADY_ABORTED') outcome = 'aborted'
        throw safe
      } finally {
        for (const attempt of attempts) try {
          await exclusive(`receipt-${attempt.ordinal}.json`, { schema, runId: manifest.runId, sessionId: manifest.sessionId,
            ...attempt, pid: process.pid, at: now(), outcome, errorCode })
        } catch { throw poison() }
      }
    },
  }
}

/** Provider and rejecting guard share this fiber; default provider must be disabled. */
export function installComplexSearchBudget(ctx, config, dependencies) {
  const gate = createComplexSearchBudget(config, dependencies)
  ctx.web.registerSearchProvider({ id: SEARCH_ROUTE.provider, available: () => true,
    async search(request, signal) {
      let agent
      try { agent = ctx.agents.currentInitiator() } catch { throw fail('SEARCH_INITIATOR_UNAVAILABLE') }
      return gate.search(agent?.session?.id, request, signal, {
        resolveApiKey: async () => (await ctx.get('credentials')?.resolve('DEEPSEEK_API_KEY'))?.value,
        recordRequest: value => agent.session.append('web/deepseek-search-llm-request', value),
      })
    } })
  return gate
}
export function apply(ctx, config) { installComplexSearchBudget(ctx, config) }
