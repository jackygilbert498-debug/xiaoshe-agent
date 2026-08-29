import { describe, expect, it } from 'vitest'
import { transitionOverlayState } from '../src/client/index.js'

describe('V6 responsive overlay state', () => {
  it('keeps at most one narrow-screen rail open and closes deterministically', () => {
    const closed = { side: false, inspector: false }
    const side = transitionOverlayState(closed, 'toggle-side')
    expect(side).toEqual({ side: true, inspector: false })
    expect(transitionOverlayState(side, 'toggle-inspector')).toEqual({ side: false, inspector: true })
    expect(transitionOverlayState(side, 'toggle-side')).toEqual(closed)
    expect(transitionOverlayState({ side: false, inspector: true }, 'close')).toEqual(closed)
  })
})
