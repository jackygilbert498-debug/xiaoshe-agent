import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('legacy-adapted Profile overlay boundary', () => {
  it('disables only the old product shell and inserts only the adapted copy', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')

    expect(manifest.dependencies).toEqual({ '@xiaoshe/native-shell-legacy-adapted': 'workspace:*' })
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(patch).toContain('- id: xiaoshe-native-shell\n  disabled: true')
    expect(patch).toContain("id: xiaoshe-native-shell-legacy-adapted\n      name: '@xiaoshe/native-shell-legacy-adapted'")
    expect(patch).not.toContain('@xiaoshe/native-shell-candidate')
    expect(patch).not.toContain('@xiaoshe/runtime-dsh-provider')
    expect(patch).not.toContain('ui-conversation')
  })
})
