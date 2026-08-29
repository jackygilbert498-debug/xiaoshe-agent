import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Xiaoshe product bundle boundary', () => {
  it('publishes one DSH bundle patch and owns the provider/consumer pair', async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
      files?: string[]
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }

    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.peerDependencies).toEqual({
      '@deepseek-ai/dsh-tool-session-query': '0.1.0-rc.8',
    })
    expect(manifest.peerDependenciesMeta).toEqual({
      '@deepseek-ai/dsh-tool-session-query': { optional: true },
    })
    expect(manifest.dependencies).toEqual({
      '@xiaoshe/completion-receipt': 'workspace:*',
      '@xiaoshe/heartbeat': 'workspace:*',
      '@xiaoshe/memory': 'workspace:*',
      '@xiaoshe/native-shell-legacy-adapted': 'workspace:*',
      '@xiaoshe/plugin-governance': 'workspace:*',
      '@xiaoshe/runtime-dsh-provider': 'workspace:*',
      '@xiaoshe/task-timeline': 'workspace:*',
      '@xiaoshe/verification-policy': 'workspace:*',
    })
  })

  it('does not nest the DSH web bundle or Windows capability bundle', async () => {
    const patch = await readFile(resolve(packageRoot, 'cordis.patch.yml'), 'utf8')

    expect(patch).toContain("name: '@xiaoshe/native-shell-legacy-adapted'")
    expect(patch).not.toContain("name: '@xiaoshe/native-shell'")
    expect(patch).toContain("name: '@xiaoshe/runtime-dsh-provider'")
    expect(patch).toContain("name: '@xiaoshe/completion-receipt'")
    expect(patch).toContain("name: '@xiaoshe/heartbeat'")
    expect(patch).toContain("name: '@xiaoshe/memory'")
    expect(patch).toContain("name: '@xiaoshe/plugin-governance'")
    expect(patch).toContain("name: '@xiaoshe/task-timeline'")
    expect(patch).toContain("name: '@xiaoshe/verification-policy'")
    expect(patch.indexOf('xiaoshe-verification-policy')).toBeLessThan(patch.indexOf('xiaoshe-heartbeat'))
    expect(patch.indexOf('xiaoshe-verification-policy')).toBeLessThan(patch.indexOf('xiaoshe-completion-receipt'))
    expect(patch.indexOf('xiaoshe-heartbeat')).toBeLessThan(patch.indexOf('xiaoshe-native-shell-legacy-adapted'))
    expect(patch.indexOf('xiaoshe-plugin-governance')).toBeLessThan(patch.indexOf('xiaoshe-native-shell-legacy-adapted'))
    expect(patch.indexOf('xiaoshe-completion-receipt')).toBeLessThan(patch.indexOf('xiaoshe-runtime-dsh-provider'))
    expect(patch.indexOf('xiaoshe-memory')).toBeLessThan(patch.indexOf('xiaoshe-runtime-dsh-provider'))
    expect(patch.indexOf('xiaoshe-runtime-dsh-provider')).toBeLessThan(patch.indexOf('xiaoshe-native-shell-legacy-adapted'))
    expect(patch).not.toContain('@deepseek-ai/dsh-web-app')
    expect(patch).not.toContain('@xiaoshe/dsh-desktop-control')
    expect(patch).not.toContain('runtime/DSH')
    expect(patch).not.toContain('runtime\\DSH')
  })

  it('keeps the settings shell and feature-owned settings contributors enabled', async () => {
    const patch = await readFile(resolve(packageRoot, 'cordis.patch.yml'), 'utf8')

    for (const id of [
      'ui-settings-general',
      'ui-settings-models',
      'ui-settings-plugin-inventory',
      'ui-settings-plugins',
      'ui-agent-preset',
    ]) {
      expect(patch).not.toMatch(new RegExp(`- id: ${id}\\r?\\n\\s+disabled: true`, 'u'))
    }
    expect(patch).toMatch(/- id: ui-conversation\r?\n\s+disabled: true/u)
    expect(patch).toMatch(/- id: ui-permission\r?\n\s+disabled: true/u)
    expect(patch).toContain('contributes its own real composer preference')
    expect(patch).toContain('settings-only adapter')
  })
})
