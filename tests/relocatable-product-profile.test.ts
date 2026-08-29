import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { PRODUCT_PACKAGES } from '../scripts/lib/relocatable-product-artifacts.mjs'

const execFileAsync = promisify(execFile)

describe('relocatable Product artifacts in a real DSH Profile', () => {
  it('installs and starts after moving the graph and making its source directory unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-relocation-test-'))
    const report = join(directory, 'report.json')
    try {
      await execFileAsync(process.execPath, ['scripts/verify-relocatable-product-artifacts.mjs', '--output', report], {
        cwd: process.cwd(), timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      })
      expect(JSON.parse(await readFile(report, 'utf8'))).toMatchObject({
        status: 'PASS',
        packages: PRODUCT_PACKAGES.length,
        source_directory_made_unavailable: true,
        artifact_source_path_leaks: 0,
        profile_source_path_leaks: 0,
        target_local_override_count: PRODUCT_PACKAGES.length,
        sentinel_unchanged: true,
        endpoints: {
          '/': 200,
          '/plugins/@xiaoshe%2Fnative-shell-legacy-adapted/client.js': 200,
          '/api/xiaoshe/heartbeat': 200,
          '/api/xiaoshe/memory': 200,
          '/api/xiaoshe/plugins/transactions': 200,
          '/api/xiaoshe/legacy-adapted-brand-icon': 200,
          '/api/xiaoshe/legacy-adapted-brand-raster': 200,
          '/xiaoshe/desktop/status': 200,
        },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 190_000)
})
