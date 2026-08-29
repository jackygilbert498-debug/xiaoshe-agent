import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const HELPER = resolve('scripts/ensure-handoff-profile-patch.mjs')

function merge(target: string, template: string) {
  return spawnSync(process.execPath, [HELPER, '--target', target, '--template', template], { encoding: 'utf8' })
}

describe('handoff profile patch merge', () => {
  it('replaces an initialized empty array and remains idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xs-profile-patch-'))
    const target = join(root, 'cordis.patch.yml')
    const template = join(root, 'template.yml')
    await writeFile(target, '# generated\n[]\n')
    await writeFile(template, '# template\n- id: modlens\n  config:\n    upstream: deepseek-official\n')

    const first = merge(target, template)
    expect(first.status, first.stderr).toBe(0)
    const afterFirst = await readFile(target, 'utf8')
    expect(afterFirst).not.toContain('[]')
    expect(afterFirst.match(/id: modlens/gu)).toHaveLength(1)

    const second = merge(target, template)
    expect(second.status, second.stderr).toBe(0)
    expect(await readFile(target, 'utf8')).toBe(afterFirst)
  })

  it('appends to a non-empty list without replacing existing entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xs-profile-patch-'))
    const target = join(root, 'cordis.patch.yml')
    const template = join(root, 'template.yml')
    await writeFile(target, '- id: existing\n  config: {}\n')
    await writeFile(template, '- id: modlens\n  config:\n    upstream: deepseek-official\n')

    const result = merge(target, template)
    expect(result.status, result.stderr).toBe(0)
    const merged = await readFile(target, 'utf8')
    expect(merged).toContain('id: existing')
    expect(merged).toContain('id: modlens')
  })
})
