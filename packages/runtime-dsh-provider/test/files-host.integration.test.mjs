import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from '../../../runtime/DSH/node_modules/tsx/dist/esm/api/index.mjs'
import { DshRuntimeFiles, DshAgentRuntimeSession } from './.generated/client.mjs'

register({ tsconfig: fileURLToPath(new URL('../../../runtime/DSH/tsconfig.base.json', import.meta.url)) })
const dsh = '../../../runtime/DSH/'
const { Context } = await import(dsh + 'vendor/cordis/src/index.ts')
const { default: Sessions } = await import(dsh + 'packages/core/session/src/index.ts')
const { default: Agents } = await import(dsh + 'packages/core/agent/src/index.ts')
const { default: Commands } = await import(dsh + 'packages/interaction/commands/src/index.ts')
const { createScope } = await import(dsh + 'packages/core/scope/src/index.ts')
const { createInboxStub } = await import(dsh + 'packages/test-support/agent-loop-testkit/src/inbox.ts')
const { LocalAttachmentStore } = await import(dsh + 'packages/attachment/attachment-local/src/index.ts')
const { default: WebServer } = await import(dsh + 'packages/host/webserver/src/index.ts')
const Connection = await import(dsh + 'packages/client/connection/src/index.ts')
const { FileUploads } = await import(dsh + 'packages/client/file-upload/src/index.ts')
const { FileUploadRuntime } = await import(dsh + 'packages/client/file-upload/src/client/runtime.ts')
const { FILE_UPLOAD_PATH } = await import(dsh + 'packages/client/file-upload/src/protocol.ts')
const { SessionCommandController } = await import(dsh + 'packages/api/session-controller/src/commands.ts')
const ok = value => ({ ok: true, value })

/** Boot real authenticated HTTP/storage services; only model selection and Agent execution are fixtures. */
async function openHost(t) {
  const tempParent = await realpath(tmpdir())
  const home = await mkdtemp(join(tempParent, 'xiaoshe-files-host-'))
  const ctx = new Context(), client = new Context(), reopened = new Context(), sockets = new Set()
  const globals = new Map(['location', '__DSH_FILE_UPLOAD__'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let files, runtime
  t.after(async () => {
    try {
      runtime?.dispose(); files?.dispose()
      for (const socket of sockets) socket.destroy()
      await Promise.all([client.fiber.dispose(), reopened.fiber.dispose(), ctx.fiber.dispose()])
    } finally {
      for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
      // Delete only the exact owned mkdtemp directory, after checking its resolved parent and prefix.
      const target = await realpath(home)
      assert.equal(resolve(dirname(target)), resolve(tempParent))
      assert.ok(basename(target).startsWith('xiaoshe-files-host-'))
      await rm(target, { recursive: true, force: true })
    }
  })
  await ctx.plugin(Sessions); await ctx.plugin(Agents); await ctx.plugin(Commands)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  const agents = new Map()
  for (const id of ['files-a', 'files-b']) {
    const session = ctx.sessions.create(id, { meta: { cwd: home } }), inbox = createInboxStub()
    const agent = {
      id, session, inbox, status: 'idle',
      followup(message) { inbox.append('next-turn', message) },
      steer(message) { inbox.append('next-step', message) }, cancel() {},
    }
    agent.ctx = createScope(ctx, agent).ctx
    ctx.agents.register(agent); agents.set(id, agent)
  }
  ctx.provide('llm', { listProviders: () => [{ id: 'fixture', name: 'Fixture' }] })
  const selection = { current: { provider: 'fixture', model: 'no-network' }, assembled: undefined }
  const controller = new SessionCommandController(ctx, {
    resolveAgent: async id => ({ agent: agents.get(id) }),
    selectionFor: () => selection,
    serializeImageAdmission: (_agent, operation) => operation(),
  }, home)
  const records = new Map()
  ctx.provide('credentials', { async modifyRecord(key, mutate) {
    const next = await mutate(records.get(key))
    if (next !== undefined) records.set(key, next)
    return records.get(key)
  } })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  ctx.webServer.server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await ctx.plugin({ inject: Connection.inject, apply: Connection.apply })
  await ctx.plugin(FileUploads)
  const base = 'http://127.0.0.1:' + ctx.webServer.port
  const launch = new URL(ctx.connection.authenticatedUrl(base))
  let cookie
  ctx.connection.authorizeIndex({ method: 'GET', url: launch.pathname + launch.search, headers: { host: launch.host } }, {
    writeHead(_status, headers) { cookie = headers['set-cookie'].split(';')[0] }, end() {},
  })
  assert.equal(typeof cookie, 'string')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: base, search: '' } })
  // Public embedded-carrier hook: real fetch and real Connection auth; no Remote upload fallback.
  Object.defineProperty(globalThis, '__DSH_FILE_UPLOAD__', { configurable: true, value: {
    fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, cookie, origin: base } }),
  } })
  await client.plugin(FileUploadRuntime)
  let requestId = 0
  const sessions = {
    list: { getSnapshot: () => ({ current: 'files-a', ids: [...agents.keys()], byId: { 'files-a': {}, 'files-b': {} } }), subscribe: () => () => {} },
    binding: id => agents.has(id) ? { session: {
      getSnapshot: () => ({ nodes: [] }),
      prompt: async (content, mode) => {
        try { return ok(await controller.prompt({ sessionId: id, requestId: `provider-${++requestId}`, content, mode })) }
        catch (error) { return { ok: false, error } }
      },
    } } : undefined,
  }
  files = new DshRuntimeFiles(sessions, client.fileUpload, undefined, { getSnapshot: () => ({ sessionId: 'files-a', items: [] }) })
  runtime = new DshAgentRuntimeSession(sessions, {}, files)
  // A second store instance proves durable bytes can be reopened independently of receipt state.
  await reopened.plugin(LocalAttachmentStore, { dshHome: home })
  return { ctx, reopened, agents, files, runtime, controller, base, cookie }
}

test('product files use actual authenticated Host stream storage and session-owned prompt receipts', { timeout: 30000 }, async t => {
  const h = await openHost(t)
  const endpoint = h.base + FILE_UPLOAD_PATH + '?sessionId=files-a&name=denied.bin'
  await t.test('Connection rejects missing credentials and foreign Origin before upload', async () => {
    const unauthenticated = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([255]) })
    assert.equal(unauthenticated.status, 401); await unauthenticated.text()
    const foreignOrigin = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: h.cookie, origin: 'https://untrusted.invalid' }, body: new Uint8Array([255]) })
    assert.equal(foreignOrigin.status, 403); await foreignOrigin.text()
    assert.equal(h.agents.get('files-a').inbox.nextTurn.length, 0)
  })
  for (const [name, bytes] of [
    ['中文材料.bin', Uint8Array.from({ length: 128 * 1024 + 7 }, (_, index) => index % 256)],
    ['空文件.txt', new Uint8Array()],
  ]) await t.test(`upload ${name}, bind exact attachment, reopen exact bytes and reject stale receipts`, async () => {
    const uploaded = await h.files.upload({ sessionId: 'files-a', name, file: new Blob([bytes], { type: 'application/octet-stream' }) })
    assert.equal(uploaded.ok, true, JSON.stringify(uploaded))
    assert.equal(uploaded.value.name, name); assert.equal(uploaded.value.bytes, bytes.length)
    const receipt = uploaded.value, owner = h.agents.get('files-a'), other = h.agents.get('files-b')
    const attachment = h.ctx.fileUploads.resolve(owner, receipt.receiptId)
    assert.deepEqual(attachment, { attachmentId: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), name, bytes: bytes.length })
    // Bypass the product's own ownership guard to prove the Host independently rejects a foreign receipt.
    await assert.rejects(h.controller.prompt({ sessionId: other.id, requestId: 'foreign-' + receipt.receiptId, mode: 'queue', content: [{ type: 'file', receiptId: receipt.receiptId }] }), {
      code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' },
    })
    assert.equal(other.inbox.nextTurn.length, 0)
    assert.equal((await h.runtime.sendTurn({ sessionId: owner.id, content: '', mode: 'queue', files: [receipt] })).ok, true)
    const delivered = owner.inbox.nextTurn.at(-1)
    assert.deepEqual(delivered.content, [{ type: 'file', attachment }])
    const stored = await readFile(h.ctx.attachments.fileHostPath(attachment))
    assert.deepEqual(stored, Buffer.from(bytes))
    const chunks = []
    for await (const chunk of h.reopened.attachments.readFileStream(attachment)) chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes))
    // The real Session event observer retires the prompt binding when its message becomes observable.
    owner.inbox.remove(delivered.id)
    owner.session.append('turn/start', { turn: owner.session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1 })
    owner.session.append('user/message', delivered, { surfaceOp: 'append' })
    assert.equal(h.ctx.fileUploads.resolve(owner, receipt.receiptId), undefined)
    await assert.rejects(h.controller.prompt({ sessionId: owner.id, requestId: 'stale-' + receipt.receiptId, mode: 'queue', content: [{ type: 'file', receiptId: receipt.receiptId }] }), {
      code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' },
    })
    assert.equal(owner.inbox.nextTurn.length, 0)
    assert.deepEqual(await readFile(h.reopened.attachments.fileHostPath(attachment)), Buffer.from(bytes))
  })
})
