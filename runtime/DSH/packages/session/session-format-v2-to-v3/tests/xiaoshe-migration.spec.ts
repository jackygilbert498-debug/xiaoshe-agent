import { expect, it } from 'vitest'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { releasedV3SessionFormatCodec, restoreReleasedV3Artifact } from '../src/index.ts'

const header = { type: 'session', version: 2, id: 'isolated-xiaoshe', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const row = (type: string, data: SessionFormatEvent['data'], fields = {}) => ({ type, seq: 0, time: 42, data, ...fields })
const result = (callId: string) => ({ turn: 1, step: 1, meta: { source: 'local-product', seq: 4, verified: false }, message: { id: `result:${callId}`, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'unchanged content' }], isError: false }] } })
const opening = [
  row('turn/start', { turn: 1 }), row('step/start', { turn: 1, step: 1 }),
  row('request/header', { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' }, system: 'unchanged system' } }),
  row('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'advertised', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'tool-call', id: 'mutation', name: 'write', arguments: '{}' }, { type: 'tool-call', id: 'verifier', name: 'read', arguments: '{}' }] } }, { surfaceOp: 'append' }),
  row('tool/call', { turn: 1, step: 1, callId: 'mutation', name: 'write', arguments: '{}' }),
  row('tool/result', result('mutation'), { surfaceOp: 'append' }),
  row('tool/call', { turn: 1, step: 1, callId: 'verifier', name: 'read', arguments: '{}' }),
  row('tool/result', result('verifier'), { surfaceOp: 'append' }),
]
const owned = [
  row('verification/result', { turn: 1, mutationCallId: 'mutation', verifierCallId: 'verifier', gate: 'functional-probe', status: 'passed', evidence: 'source seq 4 is text, not a coordinate' }),
  row('xiaoshe/task-generation', { version: 1, generation: 1, relation: 'new', triggerMessageId: 'user-4' }),
  row('xiaoshe/research-evidence', { version: 1, generation: 1, turn: 1, kind: 'body', callId: 'verifier', url: 'https://example.test/4' }),
  row('xiaoshe/obligation-state', { version: 1, generation: 1, turn: 1, kind: 'research', status: 'satisfied', sourceResultSeqs: [5], bodyResultSeqs: [7], citedBodyResultSeqs: [7] }),
  row('xiaoshe/obligation-state', { version: 1, generation: 1, turn: 1, kind: 'ordered-read', status: 'blocked', primary: 'primary', fallback: 'fallback', reason: '4' }),
  row('xiaoshe/obligation-state', { version: 1, generation: 1, turn: 1, kind: 'route-recovery', status: 'satisfied', failedFamily: 'write', alternativeFamily: 'read', alternativeTool: 'read', toolContractDigest: '4', presetId: 'code', proofResultSeq: 7 }),
]
function migrate(rows: readonly SessionFormatEvent[]) {
  const reader = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  rows.forEach((event, seq) => reader.decodeRow({ ...event, seq }))
  return reader.finish()
}

it('migrates all four explicit Xiaoshe event families and reopens a complete V3 log without changing payload text', () => {
  const source = [...opening, ...owned, row('step/end', { turn: 1, step: 1 }), row('turn/end', { turn: 1, reason: { kind: 'completed' } })]
  const before = structuredClone(source)
  const target = migrate(source)
  expect(target.events).toHaveLength(source.length + 2)
  const actual = target.events.filter(event => event.type.startsWith('xiaoshe/') || event.type === 'verification/result')
  expect(actual.map(event => event.data)).toEqual(owned.map(event => {
    const data = event.data as SessionFormatJsonObject
    return data['kind'] === 'research' ? { ...data, sourceResultSeqs: [7], bodyResultSeqs: [9], citedBodyResultSeqs: [9] } : data['kind'] === 'route-recovery' ? { ...data, proofResultSeq: 9 } : data
  }))
  // Every original event remains in chronological order; only audited header
  // promotion and obligation coordinates differ from the source payload.
  const retained = target.events.filter(event => event.type !== 'system/message')
  expect(retained.map(event => event.type)).toEqual(source.map(event => event.type))
  source.forEach((event, index) => {
    const data = event.data as SessionFormatJsonObject
    if (event.type !== 'request/header' && !(event.type === 'xiaoshe/obligation-state' && (data['kind'] === 'research' || data['kind'] === 'route-recovery'))) {
      expect(retained[index]?.data).toEqual(event.data)
    }
  })
  expect(source).toEqual(before)
  expect(restoreReleasedV3Artifact(target, new Set())).toBe(target)
  const reopened = sessionFormatCatalog.createRestore(releasedV3SessionFormatCodec.encodeHeader(target.header, target.inheritedEventCount), { recovery: 'strict', validation: 'current' })
  for (const event of target.events) reopened.decodeRow(releasedV3SessionFormatCodec.encodeEvent(event))
  expect(reopened.finish()).toEqual(target)
})

it('retains local nested-tool meta byte-for-byte while renaming PTC event types', () => {
  const dispatch = { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read', arguments: { seq: 4 } }
  const meta = { text: { path: 'source.txt', content: 'unaltered' }, diagnostic: { seq: 4, access: 'read-only' } }
  const target = migrate([...opening.slice(0, 3), row('tool/code-dispatch-start', dispatch), row('tool/code-dispatch', { ...dispatch, isError: false, content: [{ type: 'text', text: '4' }], meta })])
  expect((target.events.find(event => event.type === 'tool/ptc-dispatch')?.data as SessionFormatJsonObject)['meta']).toEqual(meta)
})

it.each([
  row('xiaoshe/unknown', {}),
  { ...owned[0]!, data: { ...owned[0]!.data as SessionFormatJsonObject, status: 'approved' } },
  { ...owned[1]!, data: { ...owned[1]!.data as SessionFormatJsonObject, version: 2 } },
  { ...owned[2]!, data: { ...owned[2]!.data as SessionFormatJsonObject, injected: true } },
  { ...owned[3]!, data: { ...owned[3]!.data as SessionFormatJsonObject, sourceResultSeqs: [100] } },
  { ...owned[5]!, data: { ...owned[5]!.data as SessionFormatJsonObject, proofResultSeq: -1 } },
])('rejects malformed/unknown migration payload %# without an allow-all fallback', event => {
  expect(() => migrate([...opening, event])).toThrow()
})
