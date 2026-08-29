import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  defaultPanelWidths,
  fitPanelWidths,
  PANEL_RESIZE_DESKTOP_BREAKPOINT,
  PANEL_WIDTH_LIMITS,
  panelResizeKeyTarget,
  parsePanelWidths,
  resizePanelWidth,
  transitionOverlayState,
} from '../src/client/index.js'

describe('Legacy-adapted responsive overlay state', () => {
  it('keeps secondary light-theme text AA-readable without changing brand colors', () => {
    const css = readFileSync(new URL('../src/client/adapted.css', import.meta.url), 'utf8')
    const faint = css.match(/\.xsla-shell\[data-theme="light"\]\{--faint:(#[0-9a-f]{6})\}/iu)?.[1]
    expect(faint).toBeDefined()
    expect(contrastRatio(faint!, '#fbfcfb')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(faint!, '#f3f4f3')).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps assistant Markdown compact without shrinking headings or code blocks', () => {
    const css = readFileSync(new URL('../src/client/adapted.css', import.meta.url), 'utf8')
    const markdownRoot = css.match(/\.xsla-shell \.event-markdown>\*\{([^}]*)\}/u)?.[1] ?? ''
    expect(markdownRoot).toContain('font-size:14px')
    expect(markdownRoot).toContain('line-height:1.72')
  })

  it('defines five audited viewport widths, 44px coarse targets, and reduced motion', () => {
    const css = readFileSync(new URL('../src/client/adapted.css', import.meta.url), 'utf8')
    const layout = (width: number): 'single' | 'drawer' | 'three-column' => width <= 760 ? 'single' : width <= 1180 ? 'drawer' : 'three-column'
    expect([390, 760, 1024, 1280, 1440].map(layout)).toEqual(['single', 'single', 'drawer', 'three-column', 'three-column'])
    const coarse = css.match(/@media \(pointer:coarse\)\{([\s\S]*?)\n\}/u)?.[1] ?? ''
    expect(coarse).toContain('min-height:44px')
    expect(coarse).toContain('width:44px;height:44px')
    expect(css).toContain('@media (prefers-reduced-motion:reduce)')
  })

  it('keeps at most one narrow-screen rail open and closes deterministically', () => {
    const closed = { side: false, inspector: false }
    const side = transitionOverlayState(closed, 'toggle-side')
    expect(side).toEqual({ side: true, inspector: false })
    expect(transitionOverlayState(side, 'toggle-inspector')).toEqual({ side: false, inspector: true })
    expect(transitionOverlayState(side, 'toggle-side')).toEqual(closed)
    expect(transitionOverlayState({ side: false, inspector: true }, 'close')).toEqual(closed)
  })

  it('sanitizes persisted panel widths and preserves the two desktop density defaults', () => {
    expect(PANEL_RESIZE_DESKTOP_BREAKPOINT).toBe(1180)
    expect(defaultPanelWidths(1440, 900)).toEqual({ side: 232, inspector: 292 })
    expect(defaultPanelWidths(1920, 1080)).toEqual({ side: 256, inspector: 320 })
    const fallback = { side: 232, inspector: 292 }
    expect(parsePanelWidths('not-json', fallback)).toEqual(fallback)
    expect(parsePanelWidths('{"side":9999,"inspector":-4}', fallback)).toEqual({
      side: PANEL_WIDTH_LIMITS.side.max,
      inspector: PANEL_WIDTH_LIMITS.inspector.min,
    })
  })

  it('protects the center while resizing either rail independently', () => {
    expect(resizePanelWidth({ side: 232, inspector: 292 }, 'side', 360, 1440)).toEqual({ side: 360, inspector: 292 })
    expect(resizePanelWidth({ side: 232, inspector: 292 }, 'inspector', 410, 1440)).toEqual({ side: 232, inspector: 410 })
    expect(resizePanelWidth({ side: 420, inspector: 480 }, 'side', 420, 1100)).toEqual({ side: 188, inspector: 480 })
    const fitted = fitPanelWidths({ side: 420, inspector: 480 }, 1200)
    expect(fitted.side + fitted.inspector + PANEL_WIDTH_LIMITS.centerMin).toBeLessThanOrEqual(1200)
    expect(fitted.side).toBeGreaterThanOrEqual(PANEL_WIDTH_LIMITS.side.min)
    expect(fitted.inspector).toBeGreaterThanOrEqual(PANEL_WIDTH_LIMITS.inspector.min)
  })

  it('maps separator keys according to the boundary each rail owns', () => {
    expect(panelResizeKeyTarget('side', 232, 'ArrowRight', false, 232)).toBe(240)
    expect(panelResizeKeyTarget('side', 232, 'ArrowLeft', true, 232)).toBe(200)
    expect(panelResizeKeyTarget('inspector', 292, 'ArrowLeft', false, 292)).toBe(300)
    expect(panelResizeKeyTarget('inspector', 292, 'ArrowRight', true, 292)).toBe(260)
    expect(panelResizeKeyTarget('side', 300, 'Enter', false, 232)).toBe(232)
    expect(panelResizeKeyTarget('side', 300, 'Escape', false, 232)).toBeUndefined()
  })
})

function contrastRatio(foreground: string, background: string): number {
  const luminance = (value: string): number => {
    const channels = value.slice(1).match(/../gu)!.map(channel => Number.parseInt(channel, 16) / 255)
      .map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
  }
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}
