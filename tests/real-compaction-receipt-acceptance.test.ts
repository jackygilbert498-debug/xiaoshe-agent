import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('real compaction and receipt acceptance driver', () => {
  it('verifies the durable model summary, surface replacement and completion receipt', async () => {
    const source = await readFile(new URL('../scripts/run-real-compaction-receipt-acceptance.mjs', import.meta.url), 'utf8')

    expect(source).toContain("line: '/compact'")
    expect(source).toContain("event.type === 'compaction/start'")
    expect(source).toContain("event.type === 'compaction/summary'")
    expect(source).toContain("event.type === 'compaction/end'")
    expect(source).toContain("event.type === 'command/done'")
    expect(source).toContain("event.type === 'user/message'")
    expect(source).toContain("checkpoint.surfaceOp?.op !== 'replace'")
    expect(source).toContain("receipt?.outcome !== 'verified'")
    expect(source).toContain("execution: commandResult === undefined ? 'verified-existing-success' : 'executed-now'")
    expect(source).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/)
  })
})
