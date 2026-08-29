import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PRODUCT_PACKAGES,
  rewriteWorkspaceDependencies,
} from '../../../scripts/lib/relocatable-product-artifacts.mjs'
import {
  HOST_RUNTIME_LINKS,
  REQUIRED_PRODUCT_ROWS,
  renderHostRuntimeOverrides,
} from '../../../scripts/relocatable-product-install-contract.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Xiaoshe session continuity composition', () => {
  it('mounts the authorized model tools over a lazy, durable derived index', async () => {
    const patch = await readFile(resolve(packageRoot, 'cordis.patch.yml'), 'utf8')

    expect(patch).toMatch(
      /- id: session-query-sqlite\r?\n\s+config:\r?\n\s+path: !!js dshHomePath\('session-query\.sqlite'\)\r?\n\s+openAt: first-search/u,
    )
    expect(patch).toMatch(
      /- id: xiaoshe-session-continuity\r?\n\s+name: '@deepseek-ai\/dsh-tool-session-query'\r?\n\s+config:\r?\n\s+maxSearchResults: 20\r?\n\s+searchTimeoutMs: 30000/u,
    )
    expect(patch).not.toContain("path: ':memory:'")
  })

  it('ships the tool plugin as a relocatable artifact with its MIT license source', () => {
    const row = PRODUCT_PACKAGES.find(candidate => candidate.name === '@deepseek-ai/dsh-tool-session-query')

    expect(row).toMatchObject({
      relativeDirectory: 'runtime/DSH/packages/session-query/tool-session-query',
      licenseRelativePath: 'runtime/DSH/LICENSE',
    })
  })

  it('locks Product and host workspace dependencies while rejecting unknown ones', () => {
    expect(rewriteWorkspaceDependencies({
      dependencies: {
        '@deepseek-ai/dsh-tool-session-query': 'workspace:^',
        '@deepseek-ai/schemastery': 'workspace:^',
      },
      peerDependencies: {
        '@deepseek-ai/cordis': 'workspace:^',
        '@deepseek-ai/dsh-session-query': 'workspace:^',
      },
    })).toMatchObject({
      dependencies: {
      '@deepseek-ai/dsh-tool-session-query': '0.1.0-rc.8',
      '@deepseek-ai/schemastery': '3.18.1',
      },
      peerDependencies: {
        '@deepseek-ai/cordis': '4.0.1',
        '@deepseek-ai/dsh-session-query': '0.1.0-rc.8',
      },
    })

    expect(() => rewriteWorkspaceDependencies({
      dependencies: { '@deepseek-ai/unknown-host-package': 'workspace:^' },
    })).toThrow(/unmapped .* workspace dependency/u)
  })

  it('rebinds host-only dependencies to the target DSH and requires the continuity row', () => {
    const dshRoot = resolve(packageRoot, '..', '..', 'runtime', 'DSH')

    expect(HOST_RUNTIME_LINKS).toContainEqual({
      name: '@deepseek-ai/schemastery',
      relativeDirectory: 'vendor/schemastery',
    })
    expect(renderHostRuntimeOverrides(dshRoot)).toEqual({
      '@deepseek-ai/schemastery': `link:${resolve(dshRoot, 'vendor', 'schemastery').replaceAll('\\', '/')}`,
    })
    expect(REQUIRED_PRODUCT_ROWS).toContain('xiaoshe-session-continuity')
  })
})
