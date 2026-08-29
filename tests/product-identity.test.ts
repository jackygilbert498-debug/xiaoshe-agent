import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Xiaoshe product identity', () => {
  it('owns the deployment persona without exposing Harness as the user-facing identity', async () => {
    const patch = await readFile('cordis.patch.yml', 'utf8')
    const plugin = await readFile('src/plugins/product-identity.ts', 'utf8')

    expect(patch).toContain('- id: system-prompt')
    expect(patch).toContain('includeHarnessIdentity: false')
    expect(patch).toContain("name: '@xiaoshe/dsh-desktop-control/desktop-capability'")
    expect(patch).toContain("name: '@xiaoshe/dsh-desktop-control/product-identity'")
    expect(patch).toContain("name: '@xiaoshe/dsh-desktop-control/runtime-routes'")
    expect(patch).not.toContain("name: '@xiaoshe/dsh-desktop-control'\n")
    expect(plugin).toContain('你对用户的身份始终是“小蛇”')
    expect(plugin).toContain('只有用户明确询问当前模型、提供者或内部架构时')
    expect(plugin).toContain('只陈述当前会话确实注册、启用并获授权的能力')
    expect(plugin).toContain('不得声称所有操作都会先征求同意')
    expect(`${patch}\n${plugin}`).not.toContain('sk-')
  })
})
