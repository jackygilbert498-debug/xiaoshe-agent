import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBatchCurrentGuards, batchAcceptanceConfig, batchPrompt } from '../src/batch-acceptance.mjs'

async function fixture(t, runId = randomUUID()) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'xs-batch-config-')))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, `xiaoshe-product-acceptance-${runId}`)
  await mkdir(root, { mode: 0o700 })
  for (const name of ['dsh-home/profiles/web', 'state', 'logs', 'workspace', 'xiaoshe-windows-acceptance-user-data']) await mkdir(join(root, name), { recursive: true })
  return { runId, root, options: { temporaryRoot: parent, platform: 'darwin' }, environment: {
    XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: root,
    XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: runId, XIAOSHE_BATCH_PHASE: 'seed', XIAOSHE_BATCH_CANDIDATE_ID: 'a'.repeat(64),
    XIAOSHE_BATCH_FIXTURE_URL: `http://127.0.0.1:49202/${runId}/`,
    DSH_HOME: join(root, 'dsh-home'), XIAOSHE_STATE_ROOT: join(root, 'state'), XIAOSHE_DSH_LOG_DIR: join(root, 'logs'),
    XIAOSHE_ACCEPTANCE_WORKSPACE: join(root, 'workspace'), XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(root, 'xiaoshe-windows-acceptance-user-data'),
    XIAOSHE_DSH_SERVICE_LABEL: `com.xiaoshe.acceptance.${runId}`, XIAOSHE_DSH_PORT: '49201' } }
}

test('batch seed/resume requires explicit fixed identity and distinct loopback application', async t => {
  const f = await fixture(t)
  assert.equal(batchAcceptanceConfig([], {}), undefined)
  assert.throws(() => batchAcceptanceConfig(['--acceptance-batch'], {}), /isolated/u)
  for (const phase of ['seed', 'resume']) {
    const config = batchAcceptanceConfig(['--acceptance-batch'], { ...f.environment, XIAOSHE_BATCH_PHASE: phase }, f.options)
    assert.equal(config.sessionId, `xiaoshe-batch-${f.runId}`)
    assert.equal(config.reportPath, join(f.root, `batch-${phase}-native.json`))
    assert.equal(config.candidateId, 'a'.repeat(64))
    assert.equal(config.backendPort, 49201)
    assert(Object.isFrozen(config))
  }
  for (const patch of [{ XIAOSHE_DESKTOP_ACCEPTANCE: '0' }, { XIAOSHE_BATCH_PHASE: 'new-session' },
    { XIAOSHE_BATCH_CANDIDATE_ID: '' }, { XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: randomUUID() }, { XIAOSHE_DSH_PORT: '3080' },
    { XIAOSHE_BATCH_FIXTURE_URL: `http://127.0.0.1:49201/${f.runId}/` }, { XIAOSHE_BATCH_FIXTURE_URL: 'https://outside.invalid/' },
    { XIAOSHE_BATCH_FIXTURE_URL: `http://127.0.0.1:49202/${f.runId}/?unexpected` }]) {
    assert.throws(() => batchAcceptanceConfig(['--acceptance-batch'], { ...f.environment, ...patch }, f.options))
  }
})

function assertNoExpectedBatchOutcome(prompt, config) {
  // Opaque locations can coincidentally contain "2/3" (port ...2 + UUID 3...).
  // Remove only the exact supplied locations, never arbitrary numeric prose.
  const instructions = prompt.replaceAll(config.workspaceRoot, '<workspace>').replaceAll(config.fixtureUrl, '<record-url>')
  assert(!instructions.includes('2/3'), 'the output format must not provide the expected result')
  assert(!instructions.includes('第三份第2行'))
  assert(!instructions.includes('原资料已损坏'))
}

test('seed explicitly pauses after first item; continuation requests fresh proof and does not leak answers', async t => {
  const f = await fixture(t, '30000000-0000-4000-8000-000000000001')
  const config = batchAcceptanceConfig(['--acceptance-batch'], f.environment, f.options)
  const seed = batchPrompt(config), resume = batchPrompt({ ...config, phase: 'resume' })
  assert(config.fixtureUrl.includes('2/3'), 'exercise the previously random URL collision deterministically')
  assert(seed.includes('本阶段只执行第一项'))
  assert(seed.includes('本阶段只读取第一项资料与其生成结果'))
  assert(seed.includes('不读取第二、第三项资料或它们的结果'))
  assert(seed.includes('不打开后两项网页'))
  assert(seed.includes('先停止'))
  assert(!resume.includes('不读取第二、第三项资料'))
  assert(resume.includes('重新读取 output/item-1.json'))
  assert(resume.includes('不要改写或再次提交第一项'))
  for (const prompt of [seed, resume]) {
    for (let index = 1; index <= 3; index++) assert(prompt.includes(`读取 "input-${index}.jsonl" → 只能新增 "output/item-${index}.json"`))
    assert(prompt.includes('具体行号和错误原因'))
    assert(prompt.includes('不猜测'))
    assert(prompt.includes('实际完成数量/总数量'))
    assert(prompt.includes('未完成或待验证项不得计作完成'))
    assertNoExpectedBatchOutcome(prompt, config)
    for (const leaked of ['实际完成 2/3。', '第三份第2行有问题。', '原资料已损坏。']) {
      assert.throws(() => assertNoExpectedBatchOutcome(`${prompt}\n${leaked}`, config), assert.AssertionError)
    }
  }
})

test('paid seed/resume requires host and same-session agent guards in the newest budget process', async t => {
  const f = await fixture(t), base = batchAcceptanceConfig(['--acceptance-batch'], f.environment, f.options)
  const at = offset => new Date(1700000000000 + offset).toISOString()
  const policyDigest = 'b'.repeat(64)
  const budgetMount = (pid, offset) => ({ pid, at: at(offset), runId: f.runId })
  const policyMounts = (pid, offset) => ['host', 'agent'].map((kind, i) => ({ pid, runId: f.runId, policyDigest,
    kind, sessionId: kind === 'host' ? null : base.sessionId, at: at(offset + i + 1) }))
  for (const phase of ['seed', 'resume']) {
    const config = { ...base, phase }, resume = phase === 'resume'
    const budget = { mounted: true, runId: f.runId, mountCount: resume ? 2 : 1, reservedRequests: resume ? 12 : 0,
      mounts: resume ? [budgetMount(101, 0), budgetMount(202, 100)] : [budgetMount(202, 100)] }
    const policy = { mounted: true, runId: f.runId, policyDigest, workspaceRealPath: config.workspaceRoot,
      sessionIds: [config.sessionId], mounts: [...(resume ? policyMounts(101, 0) : []), ...policyMounts(202, 100)] }
    assert.equal(assertBatchCurrentGuards({ config, budget, policy }), 202)
    const asyncBudget = structuredClone({ config, budget, policy })
    asyncBudget.budget.mounts.at(-1).at = at(150)
    assert.equal(assertBatchCurrentGuards(asyncBudget), 202, 'budget publication may follow synchronous policy mounting')
    for (const mutate of [
      value => { value.policy.mounts = value.policy.mounts.filter(row => row.pid !== 202) },
      value => { value.policy.mounts = value.policy.mounts.filter(row => !(row.pid === 202 && row.kind === 'agent')) },
      value => { value.policy.mounts = value.policy.mounts.filter(row => !(row.pid === 202 && row.kind === 'host')) },
      value => { value.policy.mounts.find(row => row.pid === 202 && row.kind === 'agent').sessionId = 'foreign' },
      value => { value.policy.mounts.find(row => row.pid === 202 && row.kind === 'agent').at = at(0) },
      value => { value.policy.mounts.find(row => row.pid === 202).policyDigest = 'c'.repeat(64) },
      value => { value.budget.mounts.push(budgetMount(303, 200)) },
    ]) {
      const bad = structuredClone({ config, budget, policy }); mutate(bad)
      assert.throws(() => assertBatchCurrentGuards(bad), /current-process guards/u)
    }
  }
})
