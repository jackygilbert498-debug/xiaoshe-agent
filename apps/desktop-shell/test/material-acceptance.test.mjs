import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertMaterialCurrentGuards, materialAcceptanceConfig, materialPrompt } from '../src/material-acceptance.mjs'

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'xs-material-config-')))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const runId = randomUUID(), root = join(parent, `xiaoshe-product-acceptance-${runId}`)
  await mkdir(root, { mode: 0o700 })
  for (const name of ['dsh-home/profiles/web', 'state', 'logs', 'workspace', 'xiaoshe-windows-acceptance-user-data']) await mkdir(join(root, name), { recursive: true })
  const environment = { XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1',
    XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: root, XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: runId,
    XIAOSHE_MATERIAL_SCENARIO: 'normal', XIAOSHE_MATERIAL_FIXTURE_URL: `http://127.0.0.1:49202/${runId}/`,
    DSH_HOME: join(root, 'dsh-home'), XIAOSHE_STATE_ROOT: join(root, 'state'), XIAOSHE_DSH_LOG_DIR: join(root, 'logs'),
    XIAOSHE_ACCEPTANCE_WORKSPACE: join(root, 'workspace'), XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(root, 'xiaoshe-windows-acceptance-user-data'),
    XIAOSHE_DSH_SERVICE_LABEL: `com.xiaoshe.acceptance.${runId}`, XIAOSHE_DSH_PORT: '49201' }
  return { runId, root, environment, options: { temporaryRoot: parent, platform: 'darwin' } }
}

test('ordinary startup never activates a paid acceptance mode and flags require all isolation gates', async t => {
  const f = await fixture(t)
  assert.equal(materialAcceptanceConfig([], {}), undefined)
  assert.equal(materialAcceptanceConfig([], f.environment), undefined)
  assert.throws(() => materialAcceptanceConfig(['--acceptance-material'], {}), /isolated/u)
  const config = materialAcceptanceConfig(['--acceptance-material'], f.environment, f.options)
  assert.equal(config.sessionId, `xiaoshe-material-${f.runId}`)
  assert.equal(config.reportPath, join(f.root, 'material-native.json'))
  assert(Object.isFrozen(config))
  for (const patch of [{ XIAOSHE_DESKTOP_ACCEPTANCE: '0' }, { XIAOSHE_MATERIAL_SCENARIO: 'anything' },
    { XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: randomUUID() }, { XIAOSHE_DSH_PORT: '3080' },
    { XIAOSHE_MATERIAL_FIXTURE_URL: `http://127.0.0.1:49201/${f.runId}/` },
    { XIAOSHE_MATERIAL_FIXTURE_URL: `https://remote.invalid/${f.runId}/` },
    { XIAOSHE_MATERIAL_FIXTURE_URL: `http://user@127.0.0.1:49202/${f.runId}/` },
    { XIAOSHE_MATERIAL_FIXTURE_URL: `http://127.0.0.1:49202/${f.runId}/?other` },
    { XIAOSHE_MATERIAL_FIXTURE_URL: `http://127.0.0.1:49202/${randomUUID()}/` }]) {
    assert.throws(() => materialAcceptanceConfig(['--acceptance-material'], { ...f.environment, ...patch }, f.options))
  }
})

test('task requests actual source values without expected answers, limits scope and handles unknown saves', async t => {
  const f = await fixture(t), config = materialAcceptanceConfig(['--acceptance-material'], f.environment, f.options)
  const prompt = materialPrompt(config)
  assert(prompt.includes(config.fixtureUrl))
  assert(prompt.includes('input.jsonl'))
  assert(prompt.includes('output/result.json'))
  assert(prompt.includes('原资料不得改变'))
  assert(prompt.includes('不盲目重发'))
  assert(!prompt.includes('alpha-'))
  const missing = materialPrompt({ ...config, scenario: 'missing_input' })
  assert(missing.includes('missing.jsonl'))
  assert(!missing.includes('input.jsonl'))
})

test('native preprompt guard binds v2 to the exact current material scenario', () => {
  const config = { runId: randomUUID(), workspaceRoot: '/owned/workspace', sessionId: 'owned-session', scenario: 'normal' }
  const budget = { mounted: true, reservedRequests: 0, runId: config.runId }
  const policy = { schema: 'xiaoshe-live-material-policy/v2', mounted: true, runId: config.runId,
    workspaceRealPath: config.workspaceRoot, sessionIds: [config.sessionId], scenario: 'normal' }
  for (const scenario of ['normal', 'missing_input', 'response_lost', 'takeover']) {
    assert.doesNotThrow(() => assertMaterialCurrentGuards({ budget, policy: { ...policy, scenario }, config: { ...config, scenario } }))
  }
  for (const changed of [{ ...policy, schema: 'xiaoshe-live-material-policy/v1' }, { ...policy, scenario: undefined },
    { ...policy, scenario: 'missing_input' }, { ...policy, scenario: 'other' }, { ...policy, mounted: false },
    { ...policy, runId: randomUUID() }, { ...policy, workspaceRealPath: '/foreign' }, { ...policy, sessionIds: ['foreign'] }]) {
    assert.throws(() => assertMaterialCurrentGuards({ budget, policy: changed, config }), /guards not ready/)
  }
  for (const changed of [{ ...budget, mounted: false }, { ...budget, reservedRequests: 1 }, { ...budget, runId: randomUUID() }]) {
    assert.throws(() => assertMaterialCurrentGuards({ budget: changed, policy, config }), /guards not ready/)
  }
})
