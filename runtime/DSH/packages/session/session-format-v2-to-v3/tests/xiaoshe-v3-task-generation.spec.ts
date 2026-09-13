import { expect, it } from 'vitest'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV3SessionFormatCodec } from '../src/index.ts'
import { assertEvent } from '../src/payload.ts'

const direct: SessionFormatEvent = { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: {
  id: 'accepted-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello.' }],
} }
const identity: SessionFormatEvent = { type: 'xiaoshe/task-generation', seq: 1, time: 2, data: {
  version: 2, generation: 1, relation: 'new', triggerMessageId: 'accepted-input', triggerMessageSeq: 0,
} }

it('round-trips the committed-input identity in the current V3 codec without extending frozen V2 migration', () => {
  const header = releasedV3SessionFormatCodec.encodeHeader({
    version: 3, id: 'v3-task-input', createdAt: 1, isSeeded: false, delegationDepth: 0,
  }, 0)
  const decoded: SessionFormatEvent[] = []
  const context = { emitEvent: (event: SessionFormatEvent) => decoded.push(event), emitRun: () => { throw new Error('unexpected compressed run') } }
  const decoder = releasedV3SessionFormatCodec.createDecoder(header, 'strict')
  for (const event of [direct, identity]) decoder.decodeRow(releasedV3SessionFormatCodec.encodeEvent(event), context)
  decoder.finish(context)
  expect(decoded).toEqual([direct, identity])
  expect(() => assertEvent(identity, 2)).toThrow(/version must be 1/u)
})

it.each([
  { version: 3 }, { triggerMessageSeq: undefined }, { triggerMessageSeq: -1 },
  { triggerMessageSeq: 1 }, { triggerMessageSeq: '0' }, { generation: -1 },
  { triggerMessageId: '' }, { triggerMessageId: ' accepted-input' }, { triggerMessageId: 'x'.repeat(513) },
  { relation: 'followup' }, { injected: true },
])('rejects malformed V2 identity payload in the current V3 codec: %j', changes => {
  const malformed = { ...identity, data: { ...identity.data as Record<string, unknown>, ...changes } } as SessionFormatEvent
  expect(() => releasedV3SessionFormatCodec.encodeEvent(malformed)).toThrow()
})

it('keeps historical V1 identity payloads round-trippable but does not reinterpret them as V2', () => {
  const legacy = { ...identity, data: { version: 1, generation: 1, relation: 'new', triggerMessageId: 'accepted-input' } }
  expect(releasedV3SessionFormatCodec.encodeEvent(legacy).data).toEqual(legacy.data)
  expect(() => releasedV3SessionFormatCodec.encodeEvent({ ...legacy, data: { ...legacy.data, triggerMessageSeq: 0 } })).toThrow()
})
