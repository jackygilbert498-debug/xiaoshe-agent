import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('governed plugin lifecycle in a real temporary DSH_HOME', () => {
  it('bootstraps, installs, uninstalls, restores and rolls back controlled local Bundles', async () => {
    const home = await mkdtemp(join(tmpdir(), 'xiaoshe-plugin-governance-profile-'))
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        'scripts/verify-plugin-governance-profile.mjs', '--dsh-home', home,
      ], { cwd: process.cwd(), timeout: 420_000, maxBuffer: 8 * 1024 * 1024 })
      const result = JSON.parse(stdout) as Record<string, unknown>
      expect(result).toMatchObject({
        status: 'PASS',
        confirmation: {
          no_profile_before_bootstrap_confirmation: true,
          healthy_absent_before_install_confirmation: true,
          raw_tokens_persisted: false,
          token_hash_public: false,
        },
        candidate_contract: {
          human_identity: true,
          provenance_disclosed: true,
          challenge_facts_bound: true,
          source_path_public: false,
        },
        bootstrap: { state: 'healthy', staging_created: true },
        healthy: {
          install_state: 'healthy', present_after_install: true,
          remove_state: 'healthy', absent_after_remove: true,
          restore_state: 'healthy', present_after_restore: true,
        },
        partial: { install_state: 'partial-health', cleanup_state: 'healthy' },
        failing: { install_state: 'rolled-back', absent_after_rollback: true, rollback_succeeded: true },
        os_sandbox_enforced: false,
        real_third_party_installed: false,
      })
      expect(await readFile(join(home, 'session-sentinel.json'), 'utf8')).toContain('must-survive')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 430_000)
})
