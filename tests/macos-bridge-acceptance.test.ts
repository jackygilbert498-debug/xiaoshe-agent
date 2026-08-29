import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('macOS bridge acceptance driver', () => {
  it('uses an isolated AppKit target, AX-grounded coordinate click, verification and fail-closed policy', async () => {
    const source = await readFile(new URL('../scripts/run-macos-bridge-acceptance.mjs', import.meta.url), 'utf8')
    expect(source).toContain("const dialogTitle = '小蛇 Phase 7 安全验收'")
    expect(source).toContain("const buttonName = 'XIAOSHE_SAFE_BUTTON'")
    expect(source).toContain("'macos-safe-action-target.swift'")
    expect(source).toContain('attempt < 12')
    expect(source).toContain("throw lastError ?? new Error('Safe target could not be activated')")
    expect(source).toContain("error.rpcData?.kind !== 'SCREEN_CAPTURE_FAILED'")
    expect(source).toContain("'click',")
    expect(source).toContain('let target = onlyElement(reviewed, buttonName)')
    expect(source).toContain('target.x - reviewed.origin.x + target.w / 2')
    expect(source).toContain('target.y - reviewed.origin.y + target.h / 2')
    expect(source).toContain('element_id: target.id')
    expect(source).toContain("if (clicked.status !== 'completed')")
    expect(source).toContain("if (actionResult !== 'XS_PHASE7_MACOS_ACTION_OK\\n')")
    expect(source).toContain("new BridgeClient(config(false))")
    expect(source).toContain('actionsDisabledFailClosed')
    expect(source).toContain('reviewedLogicalBounds')
  })
})
