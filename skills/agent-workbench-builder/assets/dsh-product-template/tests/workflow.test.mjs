import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CAPABILITIES, SCENARIOS } from '../src/project.mjs'
import { AgentProjectError } from '../src/domain.mjs'
import { capabilityToolToken } from '../src/capabilities.mjs'
import { commitCapability } from '../src/workflow.mjs'

const WRITE_CAPABILITY = CAPABILITIES.find(item => item.risk === 'approval-required')
const WRITE_SCENARIO = SCENARIOS.find(item => item.capabilityIds.includes(WRITE_CAPABILITY.id))

function task(identifier = 'task-001') {
  return {
    task_id: identifier,
    scenario_id: WRITE_SCENARIO.id,
    content: `Approved task for ${WRITE_CAPABILITY.title}`,
  }
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'agent-workbench-node-test-'))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('denial is auditable and has no business output', () => withRoot(async root => {
  const result = await commitCapability(
    WRITE_CAPABILITY.id,
    task('deny-001'),
    { approved: false, runId: 'deny', workRoot: root },
  )
  assert.equal(result.status, 'denied')
  assert.equal(result.sideEffectWritten, false)
  const output = join(root, `output/deny-001-${capabilityToolToken(WRITE_CAPABILITY.id)}.json`)
  await assert.rejects(readFile(output), error => error.code === 'ENOENT')
  assert.equal(JSON.parse(await readFile(join(root, 'receipts/deny.json'), 'utf8')).status, 'denied')
}))

test('three approved runs produce one side effect and one result hash', () => withRoot(async root => {
  const results = []
  for (let index = 1; index <= 3; index += 1) {
    results.push(await commitCapability(
      WRITE_CAPABILITY.id,
      task('run-001'),
      { approved: true, runId: `run-${index}`, workRoot: root },
    ))
  }
  assert.deepEqual(results.map(item => item.status), ['committed', 'replayed', 'replayed'])
  assert.equal(results.filter(item => item.sideEffectWritten).length, 1)
  assert.equal(new Set(results.map(item => item.outcomeHash)).size, 1)
}))

test('a changed tracked output is never overwritten', () => withRoot(async root => {
  await commitCapability(
    WRITE_CAPABILITY.id,
    task('conflict-001'),
    { approved: true, runId: 'first', workRoot: root },
  )
  const target = join(root, `output/conflict-001-${capabilityToolToken(WRITE_CAPABILITY.id)}.json`)
  await writeFile(target, '{}\n', 'utf8')
  await assert.rejects(
    commitCapability(
      WRITE_CAPABILITY.id,
      task('conflict-001'),
      { approved: true, runId: 'retry', workRoot: root },
    ),
    error => error instanceof AgentProjectError && error.code === 'IDEMPOTENCY_CONFLICT',
  )
  assert.equal(await readFile(target, 'utf8'), '{}\n')
}))
