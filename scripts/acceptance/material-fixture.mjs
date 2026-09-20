/** Owned loopback test application, deliberately not an external-site claim. */
import { createServer } from 'node:http'
import { randomUUID, createHash, randomInt } from 'node:crypto'
import { open, readFile, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fixtureSaveClient } from './fixture-save-client.mjs'

export const MATERIAL_SCENARIOS = Object.freeze(['normal', 'missing_input', 'response_lost', 'takeover'])
export const MATERIAL_RESPONSE_FAULT_MODES = Object.freeze(['truncate_after_headers', 'destroy_before_headers'])
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const hash = value => createHash('sha256').update(value).digest('hex')
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function materialSource() {
  return [
    { project: `alpha-${randomUUID().slice(0, 8)}`, amount: randomInt(100, 900) / 10, quantity: randomInt(1, 7), owner: '林' },
    { project: `beta-${randomUUID().slice(0, 8)}`, amount: randomInt(100, 900) / 10, quantity: 0 },
    { project: `gamma-${randomUUID().slice(0, 8)}`, amount: 0, quantity: randomInt(1, 7), owner: '周' },
  ]
}

export function materialExpected(rows) {
  return { items: rows.map(({ project, amount, quantity, owner }) => ({ project, amount, quantity, owner: owner ?? null })) }
}

function parsedRecord(value) {
  if (!value || Object.keys(value).join(',') !== 'items' || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 50) throw new Error('invalid structured record')
  for (const row of value.items) {
    if (!row || Object.keys(row).sort().join(',') !== 'amount,owner,project,quantity'
      || typeof row.project !== 'string' || row.project.length > 200 || !Number.isFinite(row.amount)
      || !Number.isSafeInteger(row.quantity) || (row.owner !== null && typeof row.owner !== 'string')) throw new Error('invalid item')
  }
  return value
}

function page(basePath, saved) {
  // Source values are never embedded before a real submission. On reload the
  // displayed result comes from the durable server file, not optimistic DOM.
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>小蛇资料交付验收</title>
<style>body{font:16px system-ui;line-height:1.6;margin:24px;color:#263d33}textarea{width:95%;height:180px}button{margin:10px 8px 10px 0;padding:8px 12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>资料交付验收</h1><p>仅处理本轮合成资料。先粘贴结构化 JSON，再保存。结果不明时先查看已保存记录，不要重复提交。</p>
<form id="form"><label for="payload">结构化结果 JSON</label><textarea id="payload" aria-label="结构化结果 JSON"></textarea>
<button type="submit">保存结果</button><button type="button" id="refresh">查看已保存记录</button></form>
<p id="status">${saved ? '已保存（服务器记录）' : '尚未保存'}</p><pre id="record">${saved ? escape(JSON.stringify(saved)) : ''}</pre>
<script>
const base=${JSON.stringify(basePath)};const form=document.getElementById('form'),payload=document.getElementById('payload'),status=document.getElementById('status'),record=document.getElementById('record');
async function observe(){const response=await fetch(base+'record',{cache:'no-store'});if(!response.ok)throw Error('读取失败');const row=await response.json();status.textContent=row.record?'已保存（服务器记录）':'尚未保存';record.textContent=row.record?JSON.stringify(row.record):'';}
document.getElementById('refresh').onclick=()=>observe().catch(()=>{status.textContent='读取失败，保存状态待确认；请勿重复提交';});
${fixtureSaveClient}
</script></html>`
}

export async function startMaterialFixture({ runId, scenario, directory, faultMode }) {
  if (!uuid.test(runId) || !MATERIAL_SCENARIOS.includes(scenario)) throw new Error('invalid material fixture identity')
  if (faultMode !== undefined && (scenario !== 'response_lost' || !MATERIAL_RESPONSE_FAULT_MODES.includes(faultMode))) throw new Error('invalid material response fault mode')
  const effectiveFaultMode = scenario === 'response_lost' ? faultMode ?? 'truncate_after_headers' : null
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('fixture directory must be canonical')
  const basePath = `/${runId}/`, requests = [], submissions = []
  let server, origin, queue = Promise.resolve(), errorCode = null, droppedResponses = 0, closed = false, closing = false
  const savePath = join(directory, 'server-record.json')
  const latest = async () => {
    try { return JSON.parse(await readFile(savePath, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const respond = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(value))
  }
  server = createServer((request, response) => {
    if (closing) { respond(response, 503, { error: 'fixture closing' }); return }
    const at = new Date().toISOString()
    const expectedHost = new URL(origin).host
    if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== origin)) { respond(response, 403, { error: 'origin rejected' }); return }
    const url = new URL(request.url, origin)
    if (url.origin !== origin || ![basePath, `${basePath}save`, `${basePath}record`].includes(url.pathname) || url.search) { respond(response, 404, { error: 'not found' }); return }
    const requestRow = { ordinal: requests.length + 1, method: request.method, path: url.pathname, at }
    requests.push(requestRow)
    // Finish only means Node handed its response bytes to the transport. A
    // deliberately short Content-Length response can finish with status 200
    // while the real client's JSON/body read fails; it is not client success.
    response.once('finish', () => { requestRow.status = response.statusCode; requestRow.finishedAt = new Date().toISOString(); requestRow.transportFinished = true })
    if (requests.length > 500) { respond(response, 429, { error: 'fixture request limit' }); return }
    if (request.method === 'GET' && url.pathname === basePath) {
      void latest().then(saved => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" }); response.end(page(basePath, saved)) }, () => { errorCode = 'read_failed'; respond(response, 500, { error: errorCode }) })
      return
    }
    if (request.method === 'GET' && url.pathname === `${basePath}record`) {
      void latest().then(record => respond(response, 200, { record }), () => { errorCode = 'read_failed'; respond(response, 500, { error: errorCode }) }); return
    }
    if (request.method !== 'POST' || url.pathname !== `${basePath}save`) { respond(response, 405, { error: 'method not allowed' }); return }
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') { respond(response, 415, { error: 'JSON required' }); return }
    let body = '', bytes = 0, rejected = false
    request.setEncoding('utf8')
    request.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 32_768) { rejected = true; response.destroy() } else body += chunk })
    request.on('error', () => {})
    request.on('end', () => {
      if (rejected || closing) return
      queue = queue.then(async () => {
        let record
        try { record = parsedRecord(JSON.parse(body)) } catch { respond(response, 400, { error: 'invalid record' }); return }
        // The exclusive first save intentionally does NOT silently deduplicate
        // retries, including transport resends. Every repeated valid POST is
        // visible and fails the single-POST proof; no business idempotency claim.
        submissions.push({ ordinal: submissions.length + 1, requestOrdinal: requestRow.ordinal, at: new Date().toISOString(), record, bodySha256: hash(body), persisted: false })
        const entry = submissions.at(-1)
        if (entry.ordinal !== 1) { respond(response, 409, { error: 'duplicate submission observed; inspect saved record' }); return }
        const handle = await open(savePath, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync() } finally { await handle.close() }
        entry.persisted = true; entry.persistedAt = new Date().toISOString()
        if (scenario === 'response_lost') {
          droppedResponses++
          if (effectiveFaultMode === 'destroy_before_headers') {
            // Kept as an explicit transport-risk diagnostic. Chromium may
            // resend on a reused socket; this is not reclassified as one POST.
            entry.responseDroppedAt = new Date().toISOString()
            entry.responseFault = { schema: 'xiaoshe-material-response-fault/v1', mode: effectiveFaultMode,
              requestOrdinal: requestRow.ordinal, injectedAt: entry.responseDroppedAt, headersFlushedAt: null,
              status: null, headersSent: response.headersSent, declaredContentLength: null,
              bodyBytesPassedToEnd: 0, bodySha256: null, connection: null, termination: 'destroy' }
            response.destroy(); return
          }
          // Controlled loss after durable save: headers are explicit but the
          // JSON body is incomplete. This limits the injected scenario; it is
          // not an ExactlyOnce guarantee for arbitrary network failures.
          const prefix = Buffer.from('{"saved":', 'utf8'), declaredContentLength = prefix.length + 64
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Length': String(declaredContentLength), Connection: 'close' })
          response.flushHeaders()
          const headersFlushedAt = new Date().toISOString()
          entry.responseDroppedAt = new Date().toISOString()
          entry.responseFault = { schema: 'xiaoshe-material-response-fault/v1', mode: effectiveFaultMode,
            requestOrdinal: requestRow.ordinal, injectedAt: entry.responseDroppedAt, headersFlushedAt,
            status: response.statusCode, headersSent: response.headersSent, declaredContentLength,
            bodyBytesPassedToEnd: prefix.length, bodySha256: hash(prefix), connection: 'close', termination: 'ordered_end' }
          response.end(prefix); return
        }
        respond(response, 200, { saved: true })
      }).catch(() => { errorCode = 'write_failed'; if (!response.destroyed) respond(response, 500, { error: errorCode }) })
    })
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  origin = `http://127.0.0.1:${server.address().port}`
  server.on('error', () => { errorCode = 'server_error' })
  return {
    url: origin + basePath,
    async evidence() { await queue; return { schema: 'xiaoshe-material-server/v1', runId, scenario,
      origin, basePath, faultMode: effectiveFaultMode, requests: structuredClone(requests), submissions: structuredClone(submissions), droppedResponses,
      record: await latest(), errorCode, closed } },
    async close() {
      if (closed) return
      // Stop accepting bodies before observing the final write queue. Waiting
      // on an earlier queue first could let a later request end enqueue a write
      // after close had claimed all durable state was settled.
      closing = true
      await new Promise((done, fail) => { server.close(error => error ? fail(error) : done()); server.closeAllConnections() })
      await queue
      closed = true
    },
  }
}
