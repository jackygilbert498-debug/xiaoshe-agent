import { describe, expect, it } from 'vitest'
import { parseSessionCatalogSnapshot } from '../src/index.js'

describe('SessionCatalog contract', () => {
  it('retains source and extension fields while validating catalog identity', () => {
    expect(parseSessionCatalogSnapshot({
      currentSessionId: 's1',
      sessions: { s1: { sessionId: 's1', title: '中文会话', cwd: 'C:/work', parentId: 'p1', updatedAt: 2, future: true } },
    }).sessions.s1).toMatchObject({ sessionId: 's1', title: '中文会话', future: true })
  })

  it('rejects blank session ids', () => {
    expect(() => parseSessionCatalogSnapshot({ sessions: { bad: { sessionId: ' ', updatedAt: 0 } } })).toThrow(/sessionId/)
  })
})
