import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('V6 candidate real DSH Profile verifier', () => {
  it('installs the isolated overlay while preserving Product services and the baseline sentinel', async () => {
    const home = await mkdtemp(join(tmpdir(), 'xiaoshe-candidate-v6-profile-test-'))
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        'scripts/verify-native-shell-candidate-v6-profile.mjs', '--dsh-home', home,
      ], { cwd: process.cwd(), timeout: 240_000, maxBuffer: 4 * 1024 * 1024 })
      const result = JSON.parse(stdout) as Record<string, unknown>
      expect(result).toMatchObject({
        status: 'PASS',
        profile: 'xiaoshe-native-shell-proof',
        root_status: 200,
        candidate_client_status: 200,
        candidate_brand_status: 200,
        heartbeat_status: 200,
        candidate_present: true,
        original_shell_disabled: true,
        product_services_preserved: true,
        baseline_status: 'PASS',
        sentinel_unchanged: true,
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 250_000)
})
