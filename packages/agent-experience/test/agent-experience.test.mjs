import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  apply,
  agentExperienceSettingsSchema,
  createAgentExperienceService,
  recoveryObservationsFromSession,
} from '../lib/index.js'

function memoryScope(initial = {}) {
  let value = structuredClone(initial)
  let revision = 0
  return {
    get() { return structuredClone(value) },
    getSnapshot() { return { value: structuredClone(value), revision, status: 'ready' } },
    async update(patch, expectedRevision = revision) {
      if (expectedRevision !== revision) throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
      value = { ...value, ...structuredClone(patch) }
      revision += 1
    },
    async replace(next, expectedRevision = revision) {
      if (expectedRevision !== revision) throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
      value = structuredClone(next)
      revision += 1
    },
    snapshot() { return structuredClone(value) },
  }
}

const digest = '0123456789abcdef'
const failureText = 'web_search 不在当前任务的精简能力面中；当前可见能力来自 xiaoshe_capability_plan'

function verifiedRecoveryEvents({
  now = 1_000,
  includeFailure = true,
  failedTool = 'web_search',
  failureBeforeProof = true,
} = {}) {
  const failureResult = {
    seq: failureBeforeProof ? 3 : 6,
    time: now + (failureBeforeProof ? 20 : 50),
    type: 'tool/result',
    data: {
      turn: 3,
      error: failureText,
      message: {
        source: { kind: 'tool', callId: 'failed' },
        isError: true,
        content: [{ type: 'text', text: failureText }],
      },
    },
  }
  return [
    { seq: 0, time: now, type: 'xiaoshe/task-generation', data: { version: 1, generation: 4, relation: 'new', triggerMessageId: 'user-1' } },
    { seq: 1, time: now + 1, type: 'user/message', data: { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [] } },
    { seq: 2, time: now + 10, type: 'tool/call', data: { turn: 3, callId: 'failed', name: failedTool, arguments: {} } },
    ...(includeFailure ? [failureResult] : []),
    { seq: 4, time: now + 30, type: 'tool/call', data: { turn: 3, callId: 'proof', name: 'browser_open', arguments: {} } },
    { seq: 5, time: now + 40, type: 'tool/result', data: { turn: 3, message: { source: { kind: 'tool', callId: 'proof' }, isError: false, content: [{ type: 'text', text: 'body' }] } } },
    { seq: 7, time: now + 60, type: 'xiaoshe/obligation-state', data: {
      version: 1, generation: 4, turn: 3, kind: 'route-recovery', status: 'satisfied',
      failedFamily: 'web_search', alternativeFamily: 'browser', alternativeTool: 'browser_open',
      toolContractDigest: digest, presetId: 'standard', proofResultSeq: 5,
    } },
    { seq: 8, time: now + 70, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  ].sort((left, right) => left.seq - right.seq)
}

function postAdmissionRecoveryEvents(now = Date.now()) {
  const base = verifiedRecoveryEvents({ now }).slice(2).map(event => ({ ...event, seq: event.seq + 1,
    data: { ...event.data, ...(event.type === 'xiaoshe/obligation-state' ? { proofResultSeq: 6 } : {}) } }))
  return [
    { seq: 0, time: now, type: 'user/message', data: { id: 'user-v2', role: 'user', source: { kind: 'user' }, content: [] } },
    { seq: 1, time: now + 1, type: 'xiaoshe/task-generation', data: { version: 2, generation: 4, relation: 'new', triggerMessageId: 'user-v2', triggerMessageSeq: 0 } },
    ...base,
  ]
}

test('post-admission recovery learns only from a unique direct message before effects', () => {
  const events = postAdmissionRecoveryEvents()
  assert.equal(recoveryObservationsFromSession('one', events, { outcome: 'verified', turn: 3 }).length, 1)
  for (const kind of ['missing', 'duplicate', 'forged-seq', 'non-user', 'wrong-role', 'late', 'replay', 'v1-late', 'padded-id']) {
    let input = structuredClone(events)
    if (kind === 'missing') input.shift()
    if (kind === 'duplicate') input.push({ ...input[0], seq: 2 })
    if (kind === 'forged-seq') input[1].data.triggerMessageSeq = 2
    if (kind === 'non-user') input[0].data.source.kind = 'subagent'
    if (kind === 'wrong-role') input[0].data.role = 'assistant'
    if (kind === 'late') input[1].seq = 5
    if (kind === 'replay') input.splice(2, 0, { ...input[1], seq: 2 })
    if (kind === 'v1-late') { input[1].data.version = 1; delete input[1].data.triggerMessageSeq }
    if (kind === 'padded-id') { input[0].data.id = ' user-v2'; input[1].data.triggerMessageId = ' user-v2' }
    assert.deepEqual(recoveryObservationsFromSession('one', input, { outcome: 'verified', turn: 3 }), [], kind)
  }
})

test('orphan legacy declarations neither poison a fresh v2 generation nor certify old same-turn recovery', () => {
  const orphan = verifiedRecoveryEvents().filter(event => event.type !== 'user/message').map(event => ({ ...event,
    data: { ...event.data, ...(event.type === 'xiaoshe/task-generation' || event.type === 'xiaoshe/obligation-state' ? { generation: 90 } : {}) } }))
  const fresh = postAdmissionRecoveryEvents().map(event => ({ ...event, seq: event.seq + 20,
    data: { ...event.data, ...(event.type === 'xiaoshe/task-generation' ? { triggerMessageSeq: 20 } : {}),
      ...(event.type === 'xiaoshe/obligation-state' ? { proofResultSeq: 26 } : {}),
      ...(event.type === 'tool/call' ? { callId: `fresh-${event.data.callId}` } : {}),
      ...(event.type === 'tool/result' ? { message: { ...event.data.message, source: { ...event.data.message.source, callId: `fresh-${event.data.message.source.callId}` } } } : {}) } }))
  assert.deepEqual(recoveryObservationsFromSession('orphan-only', orphan, { outcome: 'verified', turn: 3 }), [])
  const observations = recoveryObservationsFromSession('recovered', [...orphan, ...fresh], { outcome: 'verified', turn: 3 })
  assert.deepEqual(observations.map(item => item.taskGeneration), [4])
  const continuation = structuredClone(fresh)
  continuation[1].data.relation = 'continuation'
  continuation[1].data.generation = 90
  continuation.find(event => event.type === 'xiaoshe/obligation-state').data.generation = 90
  assert.deepEqual(recoveryObservationsFromSession('no-laundering', [...orphan, ...continuation], { outcome: 'verified', turn: 3 }), [])
})

test('legacy recovery needs a real pre-effect user and allows only an initial pending read before admission', () => {
  const base = verifiedRecoveryEvents().map(event => ({ ...event, seq: event.seq * 10,
    data: { ...event.data, ...(event.type === 'xiaoshe/obligation-state' ? { proofResultSeq: 50 } : {}) } }))
  const initial = { seq: 5, time: 1_005, type: 'xiaoshe/obligation-state', data: {
    version: 1, generation: 4, turn: 3, kind: 'ordered-read', status: 'pending', primary: 'a.txt', fallback: 'b.txt' } }
  assert.equal(recoveryObservationsFromSession('initial-read', [...base, initial], { outcome: 'verified', turn: 3 }).length, 1)
  for (const kind of ['missing', 'duplicate', 'non-user', 'wrong-role', 'late-tool', 'late-answer', 'late-verification', 'late-approval', 'late-end', 'early-satisfied', 'continuation-only']) {
    let events = structuredClone(base)
    if (kind === 'missing') events.splice(1, 1)
    if (kind === 'duplicate') events.push({ ...events[1], seq: 11 })
    if (kind === 'non-user') events[1].data.source.kind = 'subagent'
    if (kind === 'wrong-role') events[1].data.role = 'assistant'
    if (kind === 'continuation-only') events[0].data.relation = 'continuation'
    const type = { 'late-tool': 'tool/call', 'late-answer': 'assistant/message', 'late-verification': 'verification/result', 'late-approval': 'approval/request', 'late-end': 'turn/end' }[kind]
    if (type) events.push({ seq: 5, time: 1_005, type, data: {} })
    if (kind === 'early-satisfied') events.push({ ...initial, data: { ...initial.data, status: 'satisfied' } })
    assert.deepEqual(recoveryObservationsFromSession(kind, events, { outcome: 'verified', turn: 3 }), [], kind)
  }
})

test('a verified same-turn new task cannot promote an earlier valid tasks recovery', () => {
  const events = [...verifiedRecoveryEvents(),
    { seq: 20, time: 2_000, type: 'user/message', data: { id: 'new-task', role: 'user', source: { kind: 'user' }, content: [] } },
    { seq: 21, time: 2_001, type: 'xiaoshe/task-generation', data: { version: 2, generation: 5, relation: 'new', triggerMessageId: 'new-task', triggerMessageSeq: 20 } },
    { seq: 22, time: 2_002, type: 'tool/call', data: { turn: 3, callId: 'new-read', name: 'read', arguments: {} } },
    { seq: 23, time: 2_003, type: 'tool/result', data: { turn: 3, message: { source: { kind: 'tool', callId: 'new-read' }, isError: false, content: [{ type: 'text', text: 'new body' }] } } },
  ]
  assert.deepEqual(recoveryObservationsFromSession('same-turn', events, { outcome: 'verified', turn: 3 }), [])
})

test('a legacy marker cannot bind its delayed user across a fresh v2 task boundary', () => {
  const fresh = postAdmissionRecoveryEvents().map(event => ({ ...event, seq: event.seq + 2,
    data: { ...event.data, ...(event.type === 'xiaoshe/task-generation' ? { triggerMessageSeq: 2 } : {}),
      ...(event.type === 'xiaoshe/obligation-state' ? { proofResultSeq: 8 } : {}) } }))
  const events = [
    { seq: 0, time: 1000, type: 'xiaoshe/task-generation', data: { version: 1, generation: 90, relation: 'new', triggerMessageId: 'delayed' } },
    ...fresh.slice(0, 2),
    { seq: 4, time: 1004, type: 'user/message', data: { id: 'delayed', role: 'user', source: { kind: 'user' }, content: [] } },
    ...fresh.slice(2).map(event => event.type === 'xiaoshe/obligation-state' ? { ...event, data: { ...event.data, generation: 90 } } : event),
  ]
  assert.deepEqual(recoveryObservationsFromSession('boundary', events, { outcome: 'verified', turn: 3 }), [])
  // Before the delayed user arrives, the fresh task is independently valid;
  // that later user cannot retroactively reserve an earlier generation number.
  const withoutDelayed = events.filter(event => event.data?.id !== 'delayed')
    .map(event => event.type === 'xiaoshe/obligation-state' ? { ...event, data: { ...event.data, generation: 4 } } : event)
  assert.deepEqual(recoveryObservationsFromSession('boundary', withoutDelayed, { outcome: 'verified', turn: 3 }).map(item => item.taskGeneration), [4])
})

test('bounded plugin history retains a v2 trigger and never learns a prior task failure as a new task recovery', async () => {
  const scope = memoryScope({ revision: 0, entries: [] })
  let listener
  const service = apply({ sessionProjections: { snapshot: () => ({ values: { completionReceipt: { outcome: 'verified', turn: 3 } } }) },
    settings: { register: () => scope }, on(_event, callback) { listener = callback; return () => {} }, effect: execute => execute(), provide() {} })
  const rows = postAdmissionRecoveryEvents()
  const session = { id: 'bounded-v2', events: [...rows.slice(0, 2),
    ...Array.from({ length: 600 }, (_, index) => ({ seq: index + 2, time: Date.now(), type: 'context/notice', data: {} })),
    ...rows.slice(2).map(row => ({ ...row, seq: row.seq + 600, data: { ...row.data, ...(row.type === 'xiaoshe/obligation-state' ? { proofResultSeq: 606 } : {}) } })),
  ] }
  listener(session, session.events.at(-1))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.rank({ failedFamily: 'web_search', presetId: 'standard', candidates: [{ tool: 'browser_open', family: 'browser', toolContractDigest: digest }] })[0].state, 'candidate')
  // Place the new task boundary after the old failure and before the proof call.
  const moved = rows.map(row => ({ ...row, seq: row.seq * 10, data: { ...row.data, ...(row.type === 'xiaoshe/obligation-state' ? { generation: 5, proofResultSeq: 60 } : {}) } }))
  moved.splice(4, 0, { seq: 41, time: Date.now(), type: 'user/message', data: { id: 'other', role: 'user', source: { kind: 'user' } } },
    { seq: 42, time: Date.now(), type: 'xiaoshe/task-generation', data: { version: 2, generation: 5, relation: 'new', triggerMessageId: 'other', triggerMessageSeq: 41 } })
  assert.deepEqual(recoveryObservationsFromSession('different-task', moved, { outcome: 'verified', turn: 3 }), [])
})

test('one verified episode stays a candidate and two independent episodes become an active tie-break', async () => {
  const scope = memoryScope({ revision: 0, entries: [] })
  const service = createAgentExperienceService(scope, { now: () => new Date('2026-09-06T00:00:00.000Z') })
  const episode = {
    failedFamily: 'web_search', alternativeFamily: 'browser', alternativeTool: 'browser_open',
    toolContractDigest: digest, presetId: 'standard', outcome: 'verified-recovery',
  }

  await service.observe({ ...episode, sessionId: 'session-a', taskGeneration: 1 })
  assert.equal(service.rank({ candidates: [{ tool: 'browser_open', family: 'browser', toolContractDigest: digest }], presetId: 'standard' })[0].state, 'candidate')

  await service.observe({ ...episode, sessionId: 'session-b', taskGeneration: 4 })
  const [score] = service.rank({ candidates: [{ tool: 'browser_open', family: 'browser', toolContractDigest: digest }], presetId: 'standard' })
  assert.equal(score.state, 'active')
  assert.equal(score.verifiedRecoveries, 2)
  assert.ok(score.score > 0)
})

test('repeated observations from one task are idempotent and failures never promote a route', async () => {
  const scope = memoryScope({ revision: 0, entries: [] })
  const service = createAgentExperienceService(scope)
  const base = {
    sessionId: 'same', taskGeneration: 2, failedFamily: 'web_search', alternativeFamily: 'browser',
    alternativeTool: 'browser_open', toolContractDigest: digest, presetId: 'standard',
  }
  await Promise.all([
    service.observe({ ...base, outcome: 'verified-recovery' }),
    service.observe({ ...base, outcome: 'verified-recovery' }),
    service.observe({ ...base, outcome: 'failure' }),
  ])
  const [score] = service.rank({ candidates: [{ tool: 'browser_open', family: 'browser', toolContractDigest: digest }], presetId: 'standard' })
  assert.equal(score.verifiedRecoveries, 1)
  assert.equal(score.failures, 1)
  assert.equal(score.state, 'candidate')
})

test('a later failure records its own clock without reviving expired success experience', async () => {
  let current = new Date('2026-01-01T00:00:00.000Z')
  const scope = memoryScope({ revision: 0, entries: [] })
  const service = createAgentExperienceService(scope, { now: () => current, ttlMs: 1_000 })
  const route = {
    failedFamily: 'web_search', alternativeFamily: 'browser', alternativeTool: 'browser_open',
    toolContractDigest: digest, presetId: 'standard',
  }
  await service.observe({ ...route, sessionId: 'success-a', taskGeneration: 1, outcome: 'verified-recovery' })
  await service.observe({ ...route, sessionId: 'success-b', taskGeneration: 2, outcome: 'verified-recovery' })

  current = new Date('2026-01-01T00:00:02.000Z')
  await service.observe({ ...route, sessionId: 'failure-c', taskGeneration: 3, outcome: 'failure' })

  const [entry] = scope.snapshot().entries
  assert.equal(entry.lastSuccessAt, '2026-01-01T00:00:00.000Z')
  assert.equal(entry.lastFailureAt, '2026-01-01T00:00:02.000Z')
  assert.equal('lastObservedAt' in entry, false)
  assert.deepEqual(service.rank({
    failedFamily: 'web_search', presetId: 'standard',
    candidates: [{ tool: 'browser_open', family: 'browser', toolContractDigest: digest }],
  })[0], {
    tool: 'browser_open', family: 'browser', score: 0, state: 'stale', verifiedRecoveries: 2, failures: 1,
  })
})

test('legacy observation clocks migrate without treating an ambiguous late failure as fresh success', () => {
  const legacySuccessAt = '2026-01-01T00:00:00.000Z'
  const legacyFailureAt = '2026-02-01T00:00:00.000Z'
  const base = {
    key: 'a'.repeat(32), failedFamily: 'web_search', alternativeFamily: 'browser',
    alternativeTool: 'browser_open', toolContractDigest: digest, presetId: 'standard',
  }
  const migrated = agentExperienceSettingsSchema({ schemaVersion: 1, entries: [
    { ...base, verifiedEpisodes: ['b'.repeat(24)], failureEpisodes: [], lastObservedAt: legacySuccessAt },
    { ...base, key: 'c'.repeat(32), verifiedEpisodes: ['d'.repeat(24)], failureEpisodes: ['e'.repeat(24)], lastObservedAt: legacyFailureAt },
  ] })
  const [successOnly, ambiguous] = migrated.entries
  assert.equal(successOnly.lastSuccessAt, legacySuccessAt)
  assert.equal(successOnly.lastFailureAt, undefined)
  assert.equal(ambiguous.lastSuccessAt, new Date(0).toISOString())
  assert.equal(ambiguous.lastFailureAt, legacyFailureAt)
  assert.equal('lastObservedAt' in successOnly, false)
  assert.equal('lastObservedAt' in ambiguous, false)
})

test('contract changes and unrelated families cannot inherit old experience', async () => {
  const scope = memoryScope({ revision: 0, entries: [] })
  const service = createAgentExperienceService(scope)
  for (const sessionId of ['a', 'b']) {
    await service.observe({
      sessionId, taskGeneration: 1, failedFamily: 'web_search', alternativeFamily: 'browser',
      alternativeTool: 'browser_open', toolContractDigest: digest, presetId: 'standard', outcome: 'verified-recovery',
    })
  }
  const results = service.rank({
    candidates: [
      { tool: 'browser_open', family: 'browser', toolContractDigest: 'fedcba9876543210' },
      { tool: 'read_file', family: 'filesystem_read', toolContractDigest: digest },
    ],
    presetId: 'standard',
  })
  assert.deepEqual(results.map(item => [item.state, item.score]), [['unknown', 0], ['unknown', 0]])
})

test('a recovery learned after one failed family is not promoted for another failure route', async () => {
  const scope = memoryScope({ revision: 0, entries: [] })
  const service = createAgentExperienceService(scope)
  for (const sessionId of ['a', 'b']) {
    await service.observe({
      sessionId, taskGeneration: 1, failedFamily: 'web_search', alternativeFamily: 'browser',
      alternativeTool: 'browser_open', toolContractDigest: digest, presetId: 'standard', outcome: 'verified-recovery',
    })
  }
  const [score] = service.rank({
    failedFamily: 'vision',
    candidates: [{ tool: 'browser_open', family: 'browser', toolContractDigest: digest }],
    presetId: 'standard',
  })
  assert.equal(score.state, 'unknown')
})

test('stored state is bounded, decays after ttl, and contains no raw task material', async () => {
  let current = new Date('2026-01-01T00:00:00.000Z')
  const scope = memoryScope({ revision: 0, entries: [] })
  const service = createAgentExperienceService(scope, { now: () => current, maxEntries: 3, ttlMs: 1_000 })
  for (let index = 0; index < 7; index += 1) {
    current = new Date(`2026-01-01T00:00:00.${String(index).padStart(3, '0')}Z`)
    await service.observe({
      sessionId: `secret-session-${index}`, taskGeneration: index, failedFamily: 'shell',
      alternativeFamily: `family-${index}`, alternativeTool: `tool_${index}`,
      toolContractDigest: digest, presetId: 'standard', outcome: 'failure',
    })
  }
  const persisted = JSON.stringify(scope.snapshot())
  assert.equal(scope.snapshot().entries.length, 3)
  assert.doesNotMatch(persisted, /secret-session|goal|arguments|output|password|token/i)

  current = new Date('2026-01-01T00:00:02.000Z')
  assert.equal(service.rank({ candidates: [{ tool: 'tool_6', family: 'family-6', toolContractDigest: digest }], presetId: 'standard' })[0].state, 'stale')
})

test('invalid persisted data degrades to neutral and strict schema rejects secret-shaped extras', () => {
  const scope = memoryScope({ revision: 'corrupt', entries: [{ password: 'should-never-load' }] })
  const service = createAgentExperienceService(scope)
  assert.deepEqual(service.rank({ candidates: [{ tool: 'browser_open', family: 'browser', toolContractDigest: digest }] }), [{
    tool: 'browser_open', family: 'browser', score: 0, state: 'unknown', verifiedRecoveries: 0, failures: 0,
  }])
  assert.throws(() => agentExperienceSettingsSchema(null), /must be an object/u)
  assert.throws(() => agentExperienceSettingsSchema({ revision: 0, entries: [], token: 'x' }), /Unknown/)
})

test('a degraded Settings scope fails closed instead of serving its last-good route', async () => {
  const backing = memoryScope({ revision: 0, entries: [] })
  const writer = createAgentExperienceService(backing, { now: () => new Date('2026-01-01T00:00:00.000Z') })
  for (const sessionId of ['a', 'b']) {
    await writer.observe({
      sessionId, taskGeneration: 1, failedFamily: 'web_search', alternativeFamily: 'browser',
      alternativeTool: 'browser_open', toolContractDigest: digest, presetId: 'standard', outcome: 'verified-recovery',
    })
  }
  const lastGood = backing.snapshot()
  const degraded = {
    get() { return structuredClone(lastGood) },
    getSnapshot() { return { value: structuredClone(lastGood), revision: 2, status: 'degraded' } },
    async replace() {},
  }
  const service = createAgentExperienceService(degraded, { now: () => new Date('2026-01-01T00:00:00.500Z') })
  assert.deepEqual(service.rank({
    failedFamily: 'web_search', presetId: 'standard',
    candidates: [{ tool: 'browser_open', family: 'browser', toolContractDigest: digest }],
  })[0], {
    tool: 'browser_open', family: 'browser', score: 0, state: 'unknown', verifiedRecoveries: 0, failures: 0,
  })
})

test('plugin owns an isolated settings namespace and provides only its read-model service', () => {
  const registered = []
  const provided = new Map()
  const unrelatedMemory = { revision: 9, entries: [{ id: 'user-memory' }] }
  const service = apply({
    sessionProjections: { snapshot() { return { asOfSeq: -1, values: {} } } },
    settings: {
      register(namespace, schema, options) {
        registered.push({ namespace, schema, options })
        return memoryScope(options.base)
      },
    },
    on() { return () => {} },
    effect(execute) { return execute() },
    provide(name, value) { provided.set(name, value) },
  })
  assert.equal(registered[0].namespace, 'xiaoshe-agent-experience')
  assert.deepEqual(registered[0].options.base, { schemaVersion: 1, entries: [] })
  assert.equal(registered[0].options.recoverInvalidStored, true)
  assert.throws(
    () => registered[0].schema({ schemaVersion: 1, entries: [{ password: 'must-not-load' }] }),
    /experience entry must be an object|Unknown|invalid/u,
  )
  assert.equal(provided.get('xiaosheAgentExperience'), service)
  assert.deepEqual(unrelatedMemory, { revision: 9, entries: [{ id: 'user-memory' }] })
})

test('plugin records a verified route recovery from the authoritative session projection at turn end', async () => {
  const scope = memoryScope({ revision: 0, entries: [] })
  const now = Date.now()
  let listener
  const service = apply({
    sessionProjections: {
      snapshot() { return { asOfSeq: 7, values: { completionReceipt: { outcome: 'verified', turn: 3 } } } },
    },
    settings: { register() { return scope } },
    on(event, callback) {
      assert.equal(event, 'session/event')
      listener = callback
      return () => {}
    },
    effect(execute) { return execute() },
    provide() {},
  })
  const events = verifiedRecoveryEvents({ now })
  listener({ id: 'session-a', snapshotEvents: () => [...events] }, events.at(-1))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.rank({
    failedFamily: 'web_search', presetId: 'standard',
    candidates: [{ tool: 'browser_open', family: 'browser', toolContractDigest: digest }],
  })[0].state, 'candidate')
})

test('plugin learns a verified recovery across turns only inside the same task generation', async () => {
  const scope = memoryScope({ revision: 0, entries: [] })
  const now = Date.now()
  let receipt = { outcome: 'partial', turn: 1 }
  let listener
  const service = apply({
    sessionProjections: { snapshot() { return { values: { completionReceipt: receipt } } } },
    settings: { register() { return scope } },
    on(_event, callback) { listener = callback; return () => {} },
    effect(execute) { return execute() },
    provide() {},
  })
  const session = { id: 'cross-turn', events: [
    { seq: 0, time: now, type: 'xiaoshe/task-generation', data: { version: 1, generation: 7, relation: 'new', triggerMessageId: 'user-1' } },
    { seq: 1, time: now + 1, type: 'user/message', data: { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [] } },
    { seq: 2, time: now + 10, type: 'tool/call', data: { turn: 1, callId: 'failed', name: 'web_search', arguments: {} } },
    { seq: 3, time: now + 20, type: 'tool/result', data: { turn: 1, error: failureText, message: { source: { kind: 'tool', callId: 'failed' }, isError: true, content: [{ type: 'text', text: failureText }] } } },
    { seq: 4, time: now + 30, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ] }
  listener(session, session.events.at(-1))
  await new Promise(resolve => setImmediate(resolve))

  session.events.push(
    { seq: 5, time: now + 40, type: 'xiaoshe/task-generation', data: { version: 1, generation: 7, relation: 'continuation', triggerMessageId: 'user-2' } },
    { seq: 6, time: now + 41, type: 'user/message', data: { id: 'user-2', role: 'user', source: { kind: 'user' }, content: [] } },
    { seq: 7, time: now + 50, type: 'tool/call', data: { turn: 2, callId: 'proof', name: 'browser_open', arguments: {} } },
    { seq: 8, time: now + 60, type: 'tool/result', data: { turn: 2, message: { source: { kind: 'tool', callId: 'proof' }, isError: false, content: [{ type: 'text', text: 'body' }] } } },
    { seq: 9, time: now + 70, type: 'xiaoshe/obligation-state', data: {
      version: 1, generation: 7, turn: 2, kind: 'route-recovery', status: 'satisfied',
      failedFamily: 'web_search', alternativeFamily: 'browser', alternativeTool: 'browser_open',
      toolContractDigest: digest, presetId: 'standard', proofResultSeq: 8,
    } },
    { seq: 10, time: now + 80, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  )
  receipt = { outcome: 'verified', turn: 2 }
  listener(session, session.events.at(-1))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(service.rank({
    failedFamily: 'web_search', presetId: 'standard',
    candidates: [{ tool: 'browser_open', family: 'browser', toolContractDigest: digest }],
  })[0].state, 'candidate')

  const crossGeneration = [
    ...session.events.slice(0, 5),
    { seq: 5, time: 2_040, type: 'xiaoshe/task-generation', data: { version: 1, generation: 8, relation: 'new', triggerMessageId: 'user-3' } },
    { seq: 6, time: 2_041, type: 'user/message', data: { id: 'user-3', role: 'user', source: { kind: 'user' }, content: [] } },
    ...session.events.slice(7).map(event => ({ ...event, data: { ...event.data, ...(event.data?.generation === 7 ? { generation: 8 } : {}) } })),
  ]
  assert.deepEqual(recoveryObservationsFromSession('cross-generation', crossGeneration, receipt), [])
})

test('only a verified receipt with a real proof result promotes a satisfied recovery event', () => {
  const events = verifiedRecoveryEvents()
  assert.deepEqual(recoveryObservationsFromSession('session-secret', events, { outcome: 'verified', turn: 3 }), [{
    sessionId: 'session-secret', taskGeneration: 4, failedFamily: 'web_search', alternativeFamily: 'browser',
    alternativeTool: 'browser_open', toolContractDigest: digest, presetId: 'standard',
    outcome: 'verified-recovery', at: new Date(1_060).toISOString(),
  }])
  assert.deepEqual(recoveryObservationsFromSession('session-secret', events, { outcome: 'partial', turn: 3 }), [])
  assert.deepEqual(recoveryObservationsFromSession('session-secret', events.filter(event => event.seq !== 5), { outcome: 'verified', turn: 3 }), [])
  assert.deepEqual(recoveryObservationsFromSession('session-secret', verifiedRecoveryEvents({ includeFailure: false }), { outcome: 'verified', turn: 3 }), [])
  assert.deepEqual(recoveryObservationsFromSession('session-secret', verifiedRecoveryEvents({ failedTool: 'read_image' }), { outcome: 'verified', turn: 3 }), [])
  assert.deepEqual(recoveryObservationsFromSession('session-secret', verifiedRecoveryEvents({ failureBeforeProof: false }), { outcome: 'verified', turn: 3 }), [])
})

test('str_replace_editor view is correlated as filesystem_read experience', () => {
  const events = verifiedRecoveryEvents().map(event => {
    if (event.type === 'tool/call' && event.data.callId === 'proof') {
      return { ...event, data: { ...event.data, name: 'str_replace_editor', arguments: { command: 'view', path: 'src/main.ts' } } }
    }
    if (event.type === 'xiaoshe/obligation-state') {
      return { ...event, data: { ...event.data, alternativeTool: 'str_replace_editor', alternativeFamily: 'filesystem_read' } }
    }
    return event
  })
  assert.equal(
    recoveryObservationsFromSession('editor-view', events, { outcome: 'verified', turn: 3 })[0]?.alternativeFamily,
    'filesystem_read',
  )
})

test('a bounded recovery failure is retained as failure experience without promoting success', () => {
  const events = [
    { seq: 0, time: 1_990, type: 'xiaoshe/task-generation', data: { version: 1, generation: 2, relation: 'new', triggerMessageId: 'user-1' } },
    { seq: 1, time: 1_991, type: 'user/message', data: { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [] } },
    { seq: 4, time: 2_000, type: 'xiaoshe/obligation-state', data: {
    version: 1, generation: 2, turn: 1, kind: 'route-recovery', status: 'blocked',
    failedFamily: 'web_search', alternativeFamily: 'browser', alternativeTool: 'browser_open',
    toolContractDigest: digest,
  } }]
  assert.deepEqual(recoveryObservationsFromSession('s', events, { outcome: 'partial', turn: 1 })[0].outcome, 'failure')
})
