import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PRODUCT_PACKAGES,
  portableFileSpec,
  rewriteWorkspaceDependencies,
  renderPortableOverrides,
} from '../scripts/lib/relocatable-product-artifacts.mjs'

describe('relocatable Product artifact graph', () => {
  it('contains the Host bundle, every Product child and the Product bundle in dependency order', () => {
    expect(PRODUCT_PACKAGES.map(row => row.name)).toEqual([
      '@xiaoshe/verification-policy',
      '@xiaoshe/native-shell-legacy-adapted',
      '@xiaoshe/runtime-dsh-provider',
      '@xiaoshe/completion-receipt',
      '@xiaoshe/runtime-contract',
      '@xiaoshe/heartbeat',
      '@xiaoshe/memory',
      '@xiaoshe/plugin-governance',
      '@xiaoshe/task-timeline',
      '@deepseek-ai/dsh-tool-session-query',
      '@xiaoshe/dsh-desktop-control',
      '@xiaoshe/product-bundle',
    ])
  })

  it('rewrites workspace runtime edges to exact declared package versions without changing other specs', () => {
    const manifest = rewriteWorkspaceDependencies({
      name: '@xiaoshe/example',
      version: '0.1.0',
      dependencies: {
        '@xiaoshe/memory': 'workspace:*',
        external: '^2.0.0',
      },
    })

    expect(manifest.dependencies).toEqual({
      '@xiaoshe/memory': '0.1.0',
      external: '^2.0.0',
    })
  })

  it('renders target-local overrides and never embeds a source directory', () => {
    const artifactDirectory = resolve('target with spaces', 'artifacts')
    const sourceDirectory = resolve('source', 'device', 'XS')
    const block = renderPortableOverrides(artifactDirectory, sourceDirectory)

    expect(block).toContain(portableFileSpec(join(artifactDirectory, 'xiaoshe-memory-0.1.0.tgz')))
    expect(block).not.toContain(portableFileSpec(sourceDirectory))
    expect(block).toContain('# >>> Xiaoshe relocatable Product artifacts >>>')
  })

  it('rejects a forbidden source directory after platform path normalization', () => {
    const sourceDirectory = resolve('source', 'device', 'XS')

    expect(() => renderPortableOverrides(sourceDirectory, sourceDirectory))
      .toThrow('portable overrides retained the generating source directory')
  })
})
