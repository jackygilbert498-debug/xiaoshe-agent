import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { finalizeLiveRun } from './live-run-finalize.mjs'
import { createBudgetGate } from './live-request-budget.mjs'

async function fixture(t) {
  const temporaryRoot = await fs.realpath(tmpdir())
  const runId = randomUUID()
  const acceptanceRoot = join(temporaryRoot, `xiaoshe-files-live-${runId}`)
  const outputDirectory = await fs.realpath(await fs.mkdtemp(join(temporaryRoot, 'xs-finalize-proof-')))
  await fs.mkdir(acceptanceRoot, { mode: 0o700 })
  for (const name of ['workspace', 'budget', 'tool-policy']) await fs.mkdir(join(acceptanceRoot, name))
  await fs.writeFile(join(acceptanceRoot, 'workspace/input.jsonl'), 'synthetic fixture\n')
  const gate = createBudgetGate({ ledgerDirectory: join(acceptanceRoot, 'budget'), runId, maxRequests: 0,
    provider: 'disabled', model: 'disabled', sessionIds: [] })
  await gate.ready
  const failures = [], cleanup = [], order = []
  const config = { acceptanceRoot, outputDirectory, rootOwned: true, sessionId: 'isolated-session', cleanup,
    host: { output: '[REDACTED] synthetic log\n', async stop() { order.push('stop'); return { absent: true } } },
    async rpc(method, payload) { order.push('cancel'); assert.equal(method, 'session.cancel'); assert.deepEqual(payload, { sessionId: 'isolated-session' }) },
    recordFailure(stage, failure) { failures.push({ stage, code: failure.code, failure }) } }
  t.after(async () => {
    await fs.rm(acceptanceRoot, { recursive: true, force: true })
    await fs.rm(outputDirectory, { recursive: true, force: true })
  })
  return { config, failures, cleanup, order }
}

test('real directory success reads a fresh ledger, retains files, and verifies exact owned root removal', async t => {
  const { config, failures, cleanup, order } = await fixture(t)
  const budget = await finalizeLiveRun(config)
  assert.equal(budget.mode, 'no_model')
  assert.equal(budget.mounted, true)
  assert.deepEqual(order, ['cancel', 'stop'])
  assert.deepEqual(failures, [])
  assert.deepEqual(cleanup, [{ id: 'owned-process-group-released', state: 'pass' }, { id: 'isolated-profile-removed', state: 'pass' }])
  await assert.rejects(fs.lstat(config.acceptanceRoot), { code: 'ENOENT' })
  assert.equal(await fs.readFile(join(config.outputDirectory, 'host.log'), 'utf8'), config.host.output)
  assert.equal(await fs.readFile(join(config.outputDirectory, 'workspace/input.jsonl'), 'utf8'), 'synthetic fixture\n')
  assert.ok((await fs.lstat(join(config.outputDirectory, 'budget/manifest.json'))).isFile())
  assert.ok((await fs.lstat(join(config.outputDirectory, 'tool-policy'))).isDirectory())
})

test('log write EIO/EEXIST cannot skip fresh budget, independent copies or successful host cleanup', async t => {
  for (const code of ['EIO', 'EEXIST']) {
    const { config, failures, cleanup, order } = await fixture(t)
    const fresh = { marker: 'fresh-ledger' }
    const budget = await finalizeLiveRun(config, { readBudget: async () => { order.push('budget'); return fresh }, io: {
      async writeFile() { order.push('log'); throw Object.assign(new Error('synthetic log write failure'), { code }) },
      async cp(...args) { order.push(`copy-${args[0].split('/').at(-1)}`); return fs.cp(...args) },
      async rm(...args) { order.push('remove'); return fs.rm(...args) },
    } })
    assert.equal(budget, fresh)
    assert.deepEqual(order, ['cancel', 'stop', 'log', 'budget', 'copy-workspace', 'copy-budget', 'copy-tool-policy', 'remove'])
    assert.equal(failures[0].stage, 'retain-host-log')
    assert.equal(failures[0].code, code)
    assert.equal(cleanup.at(-1).state, 'pass')
    await assert.rejects(fs.lstat(config.acceptanceRoot), { code: 'ENOENT' })
  }
})

test('final budget read failure returns null/unknown rather than a stale successful snapshot', async t => {
  const { config, failures, cleanup } = await fixture(t)
  let budget = { mounted: true, reservedRequests: 1, stale: true }
  budget = await finalizeLiveRun(config, { readBudget: async () => { throw Object.assign(new Error('synthetic reader failure'), { code: 'EIO' }) } })
  assert.equal(budget, null)
  assert.equal(failures[0].stage, 'final-budget-unknown')
  assert.equal(cleanup.at(-1).state, 'pass')
  await assert.rejects(fs.lstat(config.acceptanceRoot), { code: 'ENOENT' })
})

test('unproven host stop plus log getter failure retains both reasons and never removes owned root', async t => {
  const { config, failures, cleanup } = await fixture(t)
  config.host = { async stop() { throw Object.assign(new Error('synthetic live group'), { code: 'EPERM' }) },
    get output() { throw Object.assign(new Error('synthetic log getter'), { code: 'EIO' }) } }
  let removed = false
  const budget = await finalizeLiveRun(config, { io: { async rm() { removed = true } } })
  assert.equal(budget.mounted, true)
  assert.deepEqual(failures.map(row => row.stage), ['cleanup', 'retain-host-log'])
  assert.deepEqual(failures.map(row => row.code), ['EPERM', 'EIO'])
  assert.equal(removed, false)
  assert.ok((await fs.lstat(config.acceptanceRoot)).isDirectory())
  assert.ok(cleanup.every(row => row.state === 'fail'))
})

test('existing execution failure is preserved when log and one evidence copy fail', async t => {
  const { config, failures, order } = await fixture(t)
  const original = new Error('synthetic execution failure')
  config.recordFailure('execution', original)
  await finalizeLiveRun(config, { io: {
    async writeFile() { throw Object.assign(new Error('synthetic log failure'), { code: 'EIO' }) },
    async cp(source, ...rest) {
      order.push(source.split('/').at(-1))
      if (source.endsWith('/workspace')) throw Object.assign(new Error('synthetic workspace copy failure'), { code: 'EIO' })
      return fs.cp(source, ...rest)
    },
  } })
  assert.equal(failures[0].failure, original)
  assert.deepEqual(failures.map(row => row.stage), ['execution', 'retain-host-log', 'retain-evidence-workspace'])
  assert.ok(order.includes('budget') && order.includes('tool-policy'))
  await assert.rejects(fs.lstat(config.acceptanceRoot), { code: 'ENOENT' })
})

test('recordFailure exceptions are rethrown after the remaining independent cleanup, never swallowed', async t => {
  const { config, cleanup } = await fixture(t)
  const reporterFailure = new Error('synthetic reporter failure')
  config.recordFailure = () => { throw reporterFailure }
  await assert.rejects(finalizeLiveRun(config, { io: {
    async writeFile() { throw Object.assign(new Error('synthetic log failure'), { code: 'EIO' }) },
  } }), failure => failure === reporterFailure)
  assert.equal(cleanup.at(-1).state, 'pass')
  await assert.rejects(fs.lstat(config.acceptanceRoot), { code: 'ENOENT' })
  assert.ok((await fs.lstat(join(config.outputDirectory, 'budget/manifest.json'))).isFile())
})

test('cancel rejection is best effort, while a truthy but non-boolean absence report cannot authorize removal', async t => {
  const { config, failures, order } = await fixture(t)
  config.rpc = () => { order.push('cancel'); throw new Error('synthetic already-exited RPC') }
  config.host.stop = async () => { order.push('stop'); return { absent: 1 } }
  await finalizeLiveRun(config)
  assert.deepEqual(order, ['cancel', 'stop'])
  assert.equal(failures[0].code, 'owned_host_absence_unproven')
  assert.ok((await fs.lstat(config.acceptanceRoot)).isDirectory())
})

test('missing ownership and unsafe broad paths never authorize root inspection or deletion', async t => {
  const { config } = await fixture(t)
  let read = false, removed = false, copied = false
  assert.equal(await finalizeLiveRun({ ...config, rootOwned: false }, { readBudget: async () => { read = true },
    io: { async rm() { removed = true }, async cp() { copied = true } } }), null)
  assert.equal(read || removed || copied, false)
  const broadFailures = [], broadCleanup = []
  await finalizeLiveRun({ ...config, host: null, acceptanceRoot: await fs.realpath(tmpdir()), cleanup: broadCleanup,
    recordFailure: (stage, failure) => broadFailures.push({ stage, code: failure.code }) }, {
    readBudget: async () => { read = true }, io: { async rm() { removed = true }, async cp() { copied = true } },
  })
  assert.equal(read || removed || copied, false)
  assert.equal(broadFailures[0].code, 'unsafe_owned_paths')
  assert.equal(broadCleanup.at(-1).state, 'fail')
})

test('a filesystem rm that returns without removing the root cannot be recorded as cleanup success', async t => {
  const { config, cleanup, failures } = await fixture(t)
  await finalizeLiveRun(config, { io: { async rm() {} } })
  assert.equal(cleanup.at(-1).state, 'fail')
  assert.equal(failures.at(-1).code, 'owned_root_still_present')
})
