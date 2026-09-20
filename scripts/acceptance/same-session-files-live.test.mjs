import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveProfilePatch, selectedCredential, unusedPort, startOwnedHost, rpcClient, completedNewTurn, secretRedactor } from './same-session-files-live.mjs'

test('paid profile selects native standard without copying credentials or enabling extra providers', () => {
  const patch = liveProfilePatch({ productRoot: '/product', acceptanceRoot: '/owned', runId: 'run', sessionId: 'session' })
  for (const id of ['credentials', 'llm-deepseek', 'llm-pi-ai', 'session-title-llm', 'web-search-deepseek', 'session-telemetry-otel']) {
    assert.equal(patch.find(row => row.id === id).disabled, true)
  }
  assert.deepEqual(patch.find(row => row.id === 'tools').config, { mode: 'native' })
  assert.equal(patch.find(row => row.id === 'agent-presets').config.includeUserRoot, false)
  const plugins = patch.find(row => row.insert).insert
  assert.match(plugins[1].name, /live-official-budget\.mjs$/u)
  assert.deepEqual(plugins[1].config.sessionIds, ['session'])
  assert.equal(plugins[1].config.maxRequests, 16)
})

test('exact credential loader rejects symlink/world-readable/missing/malformed selected values', { skip: process.platform === 'win32' ? 'POSIX uid/mode enforcement requires macOS/Linux' : false }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xs-credential-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'store.yaml')
  await writeFile(path, 'DEEPSEEK_API_KEY: " test-fixture-not-a-real-key "\nOTHER: untouched\n', { mode: 0o600 })
  assert.equal(await selectedCredential(path), 'test-fixture-not-a-real-key')
  await symlink(path, join(dir, 'link'))
  await assert.rejects(selectedCredential(join(dir, 'link')))
  await chmod(path, 0o644); await assert.rejects(selectedCredential(path), /permissions/u)
  await chmod(path, 0o600); await writeFile(path, 'OTHER: value\n')
  await assert.rejects(selectedCredential(path), /missing/u)
  await writeFile(path, 'DEEPSEEK_API_KEY: "not a valid key"\n')
  await assert.rejects(selectedCredential(path), /invalid/u)
})

test('poll completion requires a new user event followed by new turn/end, not an idle list', () => {
  const history = { events: [] }
  const add = (seq, type, data) => history.events.push({ event: { seq, type, data } })
  add(1, 'turn/end', { reason: { kind: 'completed' } })
  assert.equal(completedNewTurn(history, 1), null)
  add(2, 'user/message', { id: 'new-user', source: { kind: 'user' } })
  assert.equal(completedNewTurn(history, 1), null)
  add(3, 'turn/end', { reason: { kind: 'completed' } })
  assert.deepEqual(completedNewTurn(history, 1), { messageId: 'new-user', reason: 'completed' })
})

test('RPC client refuses remote servers, credentials, default daily port and extra paths', () => {
  for (const url of ['https://api.deepseek.com', 'http://127.0.0.1:3080', 'http://user:secret@127.0.0.1:3456', 'http://127.0.0.1:3456/path', 'http://127.0.0.1:3456?q=1']) {
    assert.throws(() => rpcClient(url))
  }
  assert.equal(typeof rpcClient('http://127.0.0.1:3456'), 'function')
})

test('owned child output is redacted and its real process group is released', { skip: process.platform === 'win32' ? 'POSIX process-group isolation requires macOS/Linux' : false }, async () => {
  const host = startOwnedHost(process.execPath, ['-e', 'console.log(process.env.TEST_VALUE); setInterval(() => {}, 1000)'],
    { env: { PATH: process.env.PATH, TEST_VALUE: 'fixture-secret' }, secret: 'fixture-secret' })
  try {
    for (let i = 0; i < 50 && !host.output.includes('REDACTED'); i++) await new Promise(done => setTimeout(done, 20))
    assert.match(host.output, /\[REDACTED\]/u)
    assert.ok(!host.output.includes('fixture-secret'))
  } finally { assert.equal((await host.stop()).absent, true) }
})

test('owned spawn failure is released and dynamic port is never the daily port', { skip: process.platform === 'win32' ? 'POSIX process-group isolation requires macOS/Linux' : false }, async () => {
  const host = startOwnedHost('/does-not-exist/xiaoshe', [], { env: {} })
  assert.equal((await host.stop()).absent, true)
  const port = await unusedPort()
  assert.ok(Number.isInteger(port) && port > 0 && port !== 3080)
})

test('log redaction spans stream chunks and precedes 1MiB truncation', () => {
  const secret = 'fake-key-with-a-long-sensitive-tail', chunks = []
  const redactor = secretRedactor(secret, value => chunks.push(value))
  redactor.write(Buffer.from('a'.repeat(1_048_570) + secret.slice(0, 10)))
  redactor.write(Buffer.from(secret.slice(10) + 'z'.repeat(1_048_566)))
  redactor.end()
  const output = chunks.join('').slice(-1_048_576)
  assert.ok(!output.includes('sensitive-tail'))
  assert.ok(!chunks.join('').includes(secret))
  assert.match(chunks.join(''), /\[REDACTED\]/u)
})
