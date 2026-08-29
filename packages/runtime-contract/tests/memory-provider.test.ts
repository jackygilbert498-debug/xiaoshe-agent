import { describe, expect, it } from 'vitest'
import { createMemoryRuntimeSession } from '../src/testing.js'
import { verifyProviderContract } from './provider-contract.js'

describe('memory AgentRuntimeSession provider', () => {
  it('passes the shared lifecycle contract', async () => {
    await verifyProviderContract(createMemoryRuntimeSession({ createId: sequenceId() }))
  })

  it('reports unsupported and ambiguous mutation results explicitly', async () => {
    const unsupported = createMemoryRuntimeSession({ unsupported: ['forkSession'] })
    const created = await unsupported.createSession({})
    if (!created.ok) throw new Error('fixture create failed')
    await expect(unsupported.forkSession({ sessionId: created.value.sessionId }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'unsupported' } })

    const ambiguous = createMemoryRuntimeSession({ ambiguous: ['sendTurn'] })
    const second = await ambiguous.createSession({})
    if (!second.ok) throw new Error('fixture create failed')
    await expect(ambiguous.sendTurn({ sessionId: second.value.sessionId, content: 'x', mode: 'queue' }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'needs_verification' } })
  })

  it('accepts an image-only turn and still rejects an empty turn', async () => {
    const runtime = createMemoryRuntimeSession()
    const created = await runtime.createSession({})
    if (!created.ok) throw new Error('fixture create failed')
    await expect(runtime.sendTurn({
      sessionId: created.value.sessionId,
      content: '',
      images: [{ mediaType: 'image/png', data: 'AQ==', name: 'one.png' }],
      mode: 'steer',
    })).resolves.toEqual({ ok: true, value: { accepted: true } })

    const second = await runtime.createSession({})
    if (!second.ok) throw new Error('fixture create failed')
    await expect(runtime.sendTurn({ sessionId: second.value.sessionId, content: '  ', images: [], mode: 'steer' }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
  })
})

function sequenceId(): () => string {
  let value = 0
  return () => `session-${++value}`
}
