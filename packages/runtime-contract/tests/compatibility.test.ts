import { describe, expect, it } from 'vitest'
import { parseRuntimeSessionProjection } from '../src/index.js'

describe('runtime projection compatibility', () => {
  it('preserves extensions and a future state while degrading safely', () => {
    expect(parseRuntimeSessionProjection({
      schemaVersion: 1,
      sessionId: 'session-1',
      state: 'waiting-for-robot',
      sourceSeq: 42,
      futureFlag: { enabled: true },
    })).toEqual({
      schemaVersion: 1,
      sessionId: 'session-1',
      state: 'unknown',
      rawState: 'waiting-for-robot',
      sourceSeq: 42,
      futureFlag: { enabled: true },
    })
  })

  it.each([
    [{ schemaVersion: 2, sessionId: 's', state: 'idle' }, 'schemaVersion'],
    [{ schemaVersion: 1, state: 'idle' }, 'sessionId'],
    [{ schemaVersion: 1, sessionId: '', state: 'idle' }, 'sessionId'],
    [{ schemaVersion: 1, sessionId: 's', state: 'idle', sourceSeq: -1 }, 'sourceSeq'],
  ])('rejects an invalid identity or version: %j', (value, message) => {
    expect(() => parseRuntimeSessionProjection(value)).toThrow(message)
  })
})
