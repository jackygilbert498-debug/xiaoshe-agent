import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('real model approval replay acceptance driver', () => {
  it('uses a real session, forces approval, reconnects and verifies durable evidence', async () => {
    const source = await readFile(new URL('../scripts/run-real-model-approval-acceptance.mjs', import.meta.url), 'utf8')

    expect(source).toContain("call('session.create'")
    expect(source).toContain("line: '/permission workspace-write'")
    expect(source).toContain('sandbox_permissions 为 danger-full-access')
    expect(source).toContain("openMux()")
    expect(source).toContain('replayedApproval.rpcId !== firstApproval.rpcId')
    expect(source).toContain('replayedApproval.payload.approvalId !== firstApproval.payload.approvalId')
    expect(source).toContain("outcome: 'allowed-once'")
    expect(source).toContain("event.type === 'approval/asked'")
    expect(source).toContain("event.type === 'approval/decided'")
    expect(source).toContain("output !== expected")
    expect(source).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/)
  })
})
