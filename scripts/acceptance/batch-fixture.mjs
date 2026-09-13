/** Fixed, synthetic three-item loopback application; never an external-site claim. */
import { createServer } from 'node:http'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fixtureSaveClient } from './fixture-save-client.mjs'

export const BATCH_ITEMS = Object.freeze([1, 2, 3].map(index => Object.freeze({ itemId: `item-${index}`, source: `input-${index}.jsonl`, target: `output/item-${index}.json` })))
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const hash = value => createHash('sha256').update(value).digest('hex')
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function batchSourceBytes() {
  return Object.fromEntries(BATCH_ITEMS.map(({ itemId }, index) => {
    const first = { project: `${itemId}-${randomUUID().slice(0, 8)}`, amount: randomInt(1, 100), quantity: index + 1, owner: '林' }
    const second = { project: `${itemId}-second`, amount: 0, quantity: 0 }
    return [itemId, Buffer.from(`${JSON.stringify(first)}\n${index === 2 ? '{"project":' : JSON.stringify(second)}\n`)]
  }))
}

function recordValue(value) {
  if (!value || Object.keys(value).join(',') !== 'items' || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 50) throw Error('invalid record')
  for (const row of value.items) if (!row || Object.keys(row).sort().join(',') !== 'amount,owner,project,quantity'
    || typeof row.project !== 'string' || !row.project || row.project.length > 200 || !Number.isFinite(row.amount) || row.amount < 0
    || !Number.isSafeInteger(row.quantity) || row.quantity < 0 || row.owner !== null && typeof row.owner !== 'string') throw Error('invalid item')
  return value
}

function page(itemId, base, record) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>批量资料交付 ${itemId}</title>
<style>body{font:16px system-ui;margin:24px}textarea{width:95%;height:180px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>批量资料交付 ${itemId}</h1><p>每项只能保存一次。续做前先查看服务器已保存记录，不要重复提交。</p>
<form id="form"><label for="payload">结构化结果 JSON</label><textarea id="payload" aria-label="结构化结果 JSON"></textarea><button type="submit">保存结果</button><button type="button" id="refresh">查看已保存记录</button></form>
<p id="status">${record ? '已保存（服务器记录）' : '尚未保存'}</p><pre id="record">${record ? escape(JSON.stringify(record)) : ''}</pre>
<script>const base=${JSON.stringify(base)},form=document.getElementById('form'),payload=document.getElementById('payload'),status=document.getElementById('status'),record=document.getElementById('record');
async function observe(){const response=await fetch(base+'record',{cache:'no-store'});if(!response.ok)throw Error('读取失败');const row=await response.json();status.textContent=row.record?'已保存（服务器记录）':'尚未保存';record.textContent=row.record?JSON.stringify(row.record):'';}
document.getElementById('refresh').onclick=()=>observe().catch(()=>{status.textContent='读取失败；请勿重复提交';});
${fixtureSaveClient}</script></html>`
}

export async function startBatchFixture({ runId, directory }) {
  if (!uuid.test(runId)) throw Error('invalid batch identity')
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory || (await readdir(directory)).length) throw Error('batch fixture requires an empty canonical directory')
  const basePath = `/${runId}/`, requests = [], submissions = []
  let origin, queue = Promise.resolve(), closing = false, closed = false, errorCode = null, closePromise
  const latest = async itemId => {
    try {
      const file = await open(join(directory, `${itemId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw Error('unsafe server record')
        return recordValue(JSON.parse(await file.readFile('utf8')))
      } finally { await file.close() }
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const json = (response, status, value) => {
    if (response.destroyed) return
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value))
  }
  const server = createServer((request, response) => {
    if (closing) { json(response, 503, { error: 'closing' }); return }
    if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin) { json(response, 403, { error: 'origin rejected' }); return }
    let url
    try { url = new URL(request.url, origin) } catch { json(response, 400, { error: 'invalid URL' }); return }
    const item = BATCH_ITEMS.find(item => [item.itemId + '/', item.itemId + '/save', item.itemId + '/record'].some(suffix => url.pathname === basePath + suffix))
    if (url.origin !== origin || url.search || !item) { json(response, 404, { error: 'not found' }); return }
    const row = { ordinal: requests.length + 1, itemId: item.itemId, method: request.method, path: url.pathname, at: new Date().toISOString() }
    requests.push(row)
    if (requests.length > 500) { row.status = 429; json(response, 429, { error: 'request limit' }); return }
    const itemPath = `${basePath}${item.itemId}/`
    if (request.method === 'GET' && [itemPath, itemPath + 'record'].includes(url.pathname)) {
      void latest(item.itemId).then(record => {
        row.recordSha256 = record ? hash(JSON.stringify(record)) : null; row.finishedAt = new Date().toISOString(); row.status = 200
        if (response.destroyed) return
        if (url.pathname.endsWith('/record')) { json(response, 200, { itemId: item.itemId, record }); return }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" })
        response.end(page(item.itemId, itemPath, record))
      }, () => { errorCode = 'read_failed'; row.status = 500; json(response, 500, { error: errorCode }) }); return
    }
    if (request.method !== 'POST' || url.pathname !== itemPath + 'save') { row.status = 405; json(response, 405, { error: 'method not allowed' }); return }
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') { row.status = 415; json(response, 415, { error: 'JSON required' }); return }
    let body = '', size = 0, rejected = false
    request.setEncoding('utf8'); request.on('error', () => {})
    request.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 32768) { rejected = true; row.status = 413; response.destroy() } else body += chunk })
    request.on('end', () => {
      if (rejected || closing) return
      queue = queue.then(async () => {
        if (closing) { row.status = 503; json(response, 503, { error: 'closing' }); return }
        // Every completed POST is observable, including invalid retries. A
        // successful first save never launders a repeated submit into success.
        const entry = { ordinal: submissions.length + 1, itemId: item.itemId, requestOrdinal: row.ordinal, at: new Date().toISOString(), bodySha256: hash(body), persisted: false }
        submissions.push(entry)
        const duplicate = submissions.some(other => other !== entry && other.itemId === item.itemId && other.persisted)
        if (duplicate) { entry.status = row.status = 409; json(response, 409, { error: 'duplicate submission observed; inspect saved record' }); return }
        let record
        try { record = recordValue(JSON.parse(body)) } catch { entry.status = row.status = 400; json(response, 400, { error: 'invalid record' }); return }
        entry.record = record
        const file = await open(join(directory, `${item.itemId}.json`), 'wx', 0o600)
        try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync() } finally { await file.close() }
        entry.persisted = true; entry.persistedAt = new Date().toISOString(); entry.status = row.status = 200
        json(response, 200, { itemId: item.itemId, saved: true })
      }).catch(() => { errorCode = 'write_failed'; row.status = 500; json(response, 500, { error: errorCode }) })
    })
  })
  server.requestTimeout = server.headersTimeout = 10000
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  origin = `http://127.0.0.1:${server.address().port}`
  server.on('error', () => { errorCode = 'server_error' })
  return {
    url: origin + basePath,
    itemUrls: Object.fromEntries(BATCH_ITEMS.map(({ itemId }) => [itemId, `${origin}${basePath}${itemId}/`])),
    async evidence() { await queue; return { schema: 'xiaoshe-batch-server/v1', runId, origin, basePath,
      requests: structuredClone(requests), submissions: structuredClone(submissions),
      records: Object.fromEntries(await Promise.all(BATCH_ITEMS.map(async ({ itemId }) => [itemId, await latest(itemId)]))), errorCode, closed } },
    close() {
      if (closePromise) return closePromise
      closing = true
      closePromise = (async () => {
        await new Promise((done, fail) => { server.close(error => error ? fail(error) : done()); server.closeAllConnections() })
        await queue; closed = true
      })()
      return closePromise
    },
  }
}
