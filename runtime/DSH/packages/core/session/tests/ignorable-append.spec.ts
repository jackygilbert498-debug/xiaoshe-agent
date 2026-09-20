import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

describe('optional log-only append envelope', () => {
  it('preserves an explicitly ignorable plugin event through a cold seed', () => {
    const session = Session.create(SessionId('plugin-envelope'))
    const event = (session.append as Function)('fixture/optional', { version: 1 }, { ignorable: true })
    expect(event.ignorable).toBe(true)
    expect(Session.create(SessionId('replay'), [event]).snapshotEvents()[0]?.ignorable).toBe(true)
    expect(session.deriveMessages()).toHaveLength(0)
  })

  it('rejects invalid optional markers and surface events without publishing', () => {
    const session = Session.create(SessionId('invalid-optional-envelope'))
    expect(() => (session.append as Function)('fixture/optional', {}, { ignorable: false })).toThrow()
    expect(() => (session.append as Function)('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'request' }],
    }), { surfaceOp: 'append', ignorable: true })).toThrow()
    expect(session.snapshotEvents()).toHaveLength(0)
  })
})
