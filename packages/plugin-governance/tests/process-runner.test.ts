import { describe, expect, it } from 'vitest'
import { runBoundedProcess } from '../src/process-runner.js'

describe('bounded process runner', () => {
  it('uses argv directly and records bounded redacted output byte counts', async () => {
    const result = await runBoundedProcess({
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(2048));process.stderr.write('API_TOKEN=super-secret')"],
      cwd: process.cwd(),
      environment: { ...process.env },
      maxOutputBytes: 128,
      timeoutMs: 5_000,
    })
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false, stdoutBytes: 2048 })
    expect(result.stdout).toContain('[truncated; original 2048 bytes]')
    expect(result.stdout.length).toBeLessThan(220)
    expect(result.stderr).toContain('API_TOKEN=[REDACTED]')
    expect(result.stderr).not.toContain('super-secret')
  })

  it('terminates a timed out child and an already-aborted request', async () => {
    const timed = await runBoundedProcess({
      command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: process.cwd(), environment: {}, timeoutMs: 30,
    })
    expect(timed.timedOut).toBe(true)
    const controller = new AbortController(); controller.abort()
    await expect(runBoundedProcess({
      command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(), environment: {}, signal: controller.signal,
    })).resolves.toMatchObject({ aborted: true, exitCode: -1 })
  })

  it('rejects relative executables and control characters before spawning', async () => {
    await expect(runBoundedProcess({ command: 'node', args: [], cwd: process.cwd(), environment: {} })).rejects.toThrow(/absolute executable/iu)
    await expect(runBoundedProcess({ command: process.execPath, args: ['bad\narg'], cwd: process.cwd(), environment: {} })).rejects.toThrow(/control characters/iu)
  })
})
