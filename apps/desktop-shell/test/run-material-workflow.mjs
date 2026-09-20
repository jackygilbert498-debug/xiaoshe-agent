/** Electron-only local fixture: real product components, deliberately no LLM. */
import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserWorkspace } from '../src/browser-workspace.mjs'
import { createBrowserEndpoint, requestBrowser } from '../../../scripts/isolated-browser-protocol.mjs'
import { ControlledFileWriter } from '../../../packages/coding-workbench/lib/patch.js'
import { WorkbenchTransactionStore } from '../../../packages/coding-workbench/lib/transactions.js'
import { readTextFile } from '../../../packages/coding-workbench/lib/read-model.js'
import { WorkspacePathPolicy } from '../../../packages/coding-workbench/lib/path-policy.js'

const output = process.env.XIAOSHE_MATERIAL_WORKFLOW_OUTPUT
const sourceSha256 = process.env.XIAOSHE_MATERIAL_WORKFLOW_SOURCE_SHA
if (!output || !isAbsolute(output) || !/^[a-f0-9]{64}$/u.test(sourceSha256 ?? '')) throw new Error('fixture requires an absolute output directory and source SHA')
await mkdir(output, { recursive: true, mode: 0o700 })
const profile = join(output, 'owned-browser-profile')
await mkdir(profile, { mode: 0o700 })
app.setPath('userData', profile)
app.on('window-all-closed', () => {})
const startedAt = Date.now()
const report = {
  schema: 'xiaoshe-task-run/v1', runId: randomUUID(), createdAt: new Date(startedAt).toISOString(),
  binding: { sourceSha256, runtimeIdentity: null }, executionKind: 'component_fixture',
  tasks: [], cleanup: [], paidModelRequests: 0, authenticatedExternalSiteTested: false,
}
const checks = []
const extraChecks = []
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let workspace, endpoint, host, server, fixtureRoot
let failed = false
async function check(id, fn, rows = checks) {
  try { await fn(); rows.push({ id, state: 'pass' }); process.stdout.write(`[pass] ${id}\n`) }
  catch (error) { rows.push({ id, state: 'fail' }); throw error }
}

const page = `<!doctype html><meta charset="utf-8"><title>审核资料交付验收</title>
<h1>本机审核资料交付</h1><p>仅使用合成资料，不连接真实账号。</p>
<form id="form"><label>资料编号<input id="batch" aria-label="资料编号"></label>
<label>审核摘要<textarea id="summary" aria-label="审核摘要"></textarea></label>
<button>保存审核结果</button></form><p id="result">尚未提交</p>
<script>form.onsubmit=async e=>{e.preventDefault();const response=await fetch('/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({batch:batch.value,summary:summary.value})});const saved=await response.json();result.textContent=response.ok?'已保存：'+saved.batch+'；'+saved.summary:'保存失败';};</script>`

async function run() {
try {
  await app.whenReady()
  fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'xs-material-inputs-')))
  const inputPath = join(fixtureRoot, 'source.json')
  const outputPath = join(fixtureRoot, 'review-result.json')
  const source = { batch: 'REVIEW-7429', records: [
    { id: '素材-01', durationSeconds: 8, watermark: false },
    { id: '素材-02', durationSeconds: 3, watermark: false },
    { id: '素材-03', durationSeconds: 9, watermark: true },
  ] }
  const original = JSON.stringify(source, null, 2) + '\n'
  await writeFile(inputPath, original, { flag: 'wx', mode: 0o600 })
  await writeFile(outputPath, '{}\n', { flag: 'wx', mode: 0o600 })
  const initialHash = hash(await readFile(inputPath))
  let parsed
  await check('source-read', async () => {
    const read = await readTextFile(inputPath)
    assert.equal(read.truncated, false)
    parsed = JSON.parse(read.text)
    assert.equal(parsed.records.length, 3)
    assert.equal(parsed.batch, 'REVIEW-7429')
  })
  // This deterministic transformation tests plumbing, not model reasoning.
  const result = { batch: parsed.batch, records: parsed.records.map(row => ({ id: row.id,
    decision: row.durationSeconds >= 5 && !row.watermark ? '通过' : '待复核',
    reasons: [row.durationSeconds < 5 ? '时长不足' : null, row.watermark ? '含水印' : null].filter(Boolean),
  })) }
  const ledgerPath = join(fixtureRoot, 'transactions.json')
  const paths = new WorkspacePathPolicy({ list: () => [{ id: 'fixture', path: fixtureRoot }] })
  const writer = new ControlledFileWriter({ paths, store: new WorkbenchTransactionStore(ledgerPath) })
  let transactionId
  await check('structured-output-readback', async () => {
    const challenge = await writer.prepare({ workspaceId: 'fixture', relativePath: 'review-result.json', absolutePath: outputPath, newText: JSON.stringify(result, null, 2) + '\n' })
    transactionId = challenge.id
    assert.equal(await readFile(outputPath, 'utf8'), '{}\n', 'preparation cannot write the result')
    await writer.confirm(challenge.id, challenge.token)
    const persisted = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.deepEqual(persisted, result)
    assert.deepEqual(persisted.records.map(row => row.decision), ['通过', '待复核', '待复核'])
  })
  const summary = result.records.map(row => `${row.id}：${row.decision}${row.reasons.length ? '（' + row.reasons.join('、') + '）' : ''}`).join('；')
  let saved, saveCalls = 0
  const savedPath = join(fixtureRoot, 'server-receipt.json')
  server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(page); return }
      if (request.method !== 'POST' || request.url !== '/save') { response.writeHead(404); response.end(); return }
      let body = ''
      for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 16_384) { response.writeHead(413); response.end(); return } }
      const value = JSON.parse(body)
      assert.equal(typeof value.batch, 'string'); assert.equal(typeof value.summary, 'string')
      if (saveCalls > 0) { response.writeHead(409); response.end('{}'); return }
      await writeFile(savedPath, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
      saved = value; saveCalls++
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(saved))
    } catch { response.writeHead(500); response.end('{}') }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const site = `http://127.0.0.1:${server.address().port}`
  host = new BrowserWindow({ width: 1000, height: 760, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  await host.loadURL('data:text/html,<title>Isolated fixture host</title>')
  const productOrigin = 'http://127.0.0.1:38993'
  const bridgeRoot = join(profile, 'bridge')
  const owner = 'material-workflow-fixture'
  workspace = new BrowserWorkspace({ window: host, productUrl: productOrigin, userDataPath: profile, partition: `material-${process.pid}` })
  const blocked = []
  workspace.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const allowed = new URL(details.url).origin === site
    if (!allowed) blocked.push(new URL(details.url).origin)
    callback({ cancel: !allowed })
  })
  endpoint = await createBrowserEndpoint({ origin: productOrigin, root: bridgeRoot, dispatch: (...args) => workspace.agent(...args) })
  const call = (command, args = {}) => requestBrowser({ origin: productOrigin, root: bridgeRoot, ownerId: owner, command, args })
  // The first agent open already takes a real DOM snapshot. Mount this owned
  // fixture first so Chromium can establish its viewport; do not bypass the
  // product's refusal to act on a never-mounted 0 x 0 page.
  host.setOpacity(0.01); host.showInactive()
  workspace.mount(owner, { x: 10, y: 10, width: 960, height: 710 })
  assert.equal(host.isVisible(), true)
  assert.equal(workspace.activeOwner, owner)
  let snapshot = await call('open', { url: site })
  const { width, height } = snapshot.viewport
  assert.ok(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0,
    'first open must observe a real nonzero Chromium viewport')
  report.browserPreparation = { mainPid: process.pid,
    rendererPid: workspace.tab(snapshot.tab_id, owner).view.webContents.getOSProcessId(),
    viewport: { width, height }, hostVisible: host.isVisible(), mountedOwner: workspace.activeOwner }
  snapshot = await call('snapshot', { tab_id: snapshot.tab_id })
  const element = name => {
    const row = snapshot.elements.find(row => row.name === name)
    assert.ok(row, `missing fixture element: ${name}`)
    return { tab_id: snapshot.tab_id, snapshot_id: snapshot.snapshot_id, element_id: row.element_id }
  }
  await check('browser-submitted', async () => {
    snapshot = await call('type', { ...element('资料编号'), text: result.batch, replace: true })
    snapshot = await call('type', { ...element('审核摘要'), text: summary, replace: true })
    snapshot = await call('click', element('保存审核结果'))
    // A click response is not acceptance. The following checks independently
    // inspect durable server data and a fresh browser snapshot.
  })
  await check('server-value-matched', async () => {
    const deadline = Date.now() + 5_000
    while (!saved && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(saveCalls, 1)
    assert.deepEqual(JSON.parse(await readFile(savedPath, 'utf8')), { batch: result.batch, summary })
  })
  await check('page-readback-matched', async () => {
    const proof = await call('verify', { tab_id: snapshot.tab_id, after_snapshot_id: snapshot.snapshot_id, expect_text: `已保存：${result.batch}；${summary}` })
    assert.equal(proof.status, 'verified')
    assert.notEqual(proof.current.snapshot_id, snapshot.snapshot_id)
    assert.deepEqual(blocked, [])
  })
  await check('original-input-unchanged', async () => { assert.equal(hash(await readFile(inputPath)), initialHash) })
  await check('ledger-reload-and-revert', async () => {
    const reopened = new ControlledFileWriter({ paths, store: new WorkbenchTransactionStore(ledgerPath) })
    assert.equal(reopened.list().find(row => row.id === transactionId)?.state, 'applied')
    await reopened.revert(transactionId)
    assert.equal(await readFile(outputPath, 'utf8'), '{}\n')
    assert.deepEqual(JSON.parse(await readFile(savedPath, 'utf8')), saved, 'local undo cannot silently undo an external submission')
  }, extraChecks)
} catch (error) {
  failed = true
  // Keep report errors bounded and free of source contents, tokens and paths.
  report.error = { name: error?.name ?? 'Error', stage: checks.find(row => row.state === 'fail')?.id ?? extraChecks.find(row => row.state === 'fail')?.id ?? 'setup-or-execution' }
  process.stderr.write(`material workflow failed: ${report.error.stage} (${report.error.name}): ${String(error?.message).slice(0, 1200)}\n`)
} finally {
  for (const [id, cleanup] of [
    ['private-channel-closed', async () => { await endpoint?.close() }],
    ['browser-closed', async () => { await workspace?.dispose(); if (host && !host.isDestroyed()) host.destroy() }],
    ['server-closed', async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }],
    ['owned-fixture-cleanup', async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }) }],
  ]) {
    try { await cleanup(); report.cleanup.push({ id, state: 'pass' }) }
    catch { failed = true; report.cleanup.push({ id, state: 'fail' }) }
  }
  // Electron cannot delete its live userData reliably. The parent must finish
  // and attest that cleanup before any retained report becomes a green result.
  report.cleanup.push({ id: 'parent-owned-profile-cleanup', state: 'pending_external' })
  report.tasks.push({ taskId: 'material-browser-delivery', state: failed ? 'fail' : 'partial', checks,
    metrics: { durationMs: Date.now() - startedAt, retryCount: 0, humanInterventions: 0, inputTokens: null, outputTokens: null, cost: null } })
  report.extraChecks = extraChecks
  report.finishedAt = new Date().toISOString()
  report.profileCleanup = 'pending_parent_after_electron_exit'
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  app.exit(failed ? 1 : 0)
}
}
void run().catch(() => { process.stderr.write('material workflow report/cleanup failed\n'); app.exit(1) })
