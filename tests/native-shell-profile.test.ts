import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('native shell real DSH profile verifier', () => {
  it('adds, serves, removes and restarts without changing the session sentinel', async () => {
    const home = await mkdtemp(join(tmpdir(), 'xiaoshe-native-profile-test-'))
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        'scripts/verify-native-shell-profile.mjs', '--dsh-home', home,
      ], { cwd: process.cwd(), timeout: 170_000, maxBuffer: 4 * 1024 * 1024 })
      const result = JSON.parse(stdout) as Record<string, unknown>
      expect(result).toMatchObject({
        status: 'PASS',
        installed: {
          root_status: 200, client_status: 200, provider_status: 200, governance_status: 200, heartbeat_status: 200, brand_status: 200, raster_status: 200,
          memory_client_status: 200, memory_api_status: 200,
          roster_contains_adapted: true, roster_contains_provider: true,
          roster_contains_completion_receipt: true,
          roster_contains_verification_policy: true,
          roster_contains_heartbeat: true, roster_contains_plugin_governance: true,
          roster_contains_task_timeline: true, roster_contains_memory: true,
          dsh_product_surfaces_disabled: true,
          heartbeat_transitions: ['idle', 'running', 'healthy'],
          heartbeat_restart_status: 'healthy',
          heartbeat_recovered_without_active_lease: true,
        },
        removed: {
          root_status: 200, client_status: 404, provider_status: 404, governance_status: 404, heartbeat_status: 404, brand_status: 404, raster_status: 404,
          memory_client_status: 404, memory_api_status: 404,
          roster_contains_adapted: false, roster_contains_provider: false,
          roster_contains_completion_receipt: false,
          roster_contains_verification_policy: false,
          roster_contains_heartbeat: false, roster_contains_plugin_governance: false,
          roster_contains_task_timeline: false, roster_contains_memory: false,
        },
        sentinel_unchanged: true,
      })
      expect(await readFile(join(home, 'session-sentinel.json'), 'utf8')).toContain('must-survive')
      await expect(access(join(home, 'settings.yaml.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 180_000)
})
