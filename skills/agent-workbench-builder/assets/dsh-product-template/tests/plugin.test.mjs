import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, toolNamesForCapability } from '../src/plugin.mjs'
import { CAPABILITIES, PROJECT, SCENARIOS } from '../src/project.mjs'

function fixture() {
  const definitions = new Map()
  const listeners = []
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(definitions.has(definition.name), false)
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    on(event, listener) {
      assert.equal(event, 'tools/pre-execute')
      listeners.push(listener)
    },
  }
  apply(ctx)
  return { definitions, listeners }
}

test('the Bundle registers a catalog, every capability plan, and only declared write tools', async () => {
  const { definitions, listeners } = fixture()
  const expected = [`${PROJECT.slug.replaceAll('-', '_')}_catalog`]
  for (const capability of CAPABILITIES) {
    const names = toolNamesForCapability(capability)
    expected.push(names.plan)
    if (names.commit !== null) expected.push(names.commit)
  }
  assert.deepEqual([...definitions.keys()].sort(), expected.sort())
  assert.equal(listeners.length, 1)
  for (const capability of CAPABILITIES) {
    const names = toolNamesForCapability(capability)
    const planDecision = await listeners[0]({ name: names.plan }, async () => ({ kind: 'allow' }))
    assert.deepEqual(planDecision, { kind: 'allow' })
    if (names.commit !== null) {
      const writeDecision = await listeners[0]({ name: names.commit }, async () => ({ kind: 'allow' }))
      assert.equal(writeDecision.kind, 'ask')
      assert.match(writeDecision.reason, /.+/u)
    }
  }
})

test('every DSH plan tool executes its declared capability adapter', async () => {
  const { definitions } = fixture()
  for (const capability of CAPABILITIES) {
    const scenario = SCENARIOS.find(item => item.capabilityIds.includes(capability.id))
    const result = await definitions.get(toolNamesForCapability(capability).plan).execute({
      task_id: `tool-${capability.id}`,
      scenario_id: scenario.id,
      content: `Representative input for ${capability.title}`,
    })
    assert.equal(result.capabilityId, capability.id)
    assert.equal(result.scenarioId, scenario.id)
    assert.equal(result.sideEffectWritten, false)
  }
})
