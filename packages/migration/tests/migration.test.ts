import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backupFiles, inspectLegacyRoot, restoreBackup } from '../src/index.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('migration safety', () => {
  it('inspects legacy data without returning memory or session content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xs-migration-')); roots.push(root)
    await mkdir(join(root, '.state', 'sessions'), { recursive: true })
    await writeFile(join(root, 'memory.json'), JSON.stringify([{ text: 'secret-memory' }]))
    await writeFile(join(root, '.state', 'sessions', 's1.json'), JSON.stringify({ secret: 'private-payload' }))
    const report = await inspectLegacyRoot(root)
    expect(report).toMatchObject({ memory: { present: true, jsonKind: 'array' }, sessions: { count: 1, disposition: 'reference-only' } })
    expect(JSON.stringify(report)).not.toContain('secret-memory')
    expect(JSON.stringify(report)).not.toContain('private-payload')
  })

  it('backs up exact bytes, preserves unknown fields and restores only declared files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xs-migration-')); roots.push(root)
    const source = join(root, 'settings.json'); const backup = await mkdtemp(join(tmpdir(), 'xs-backup-')); roots.push(backup); await rm(backup, { recursive: true }); const restored = join(root, 'restored')
    await writeFile(source, '{"known":1,"future":{"x":2}}')
    const manifest = await backupFiles(root, ['settings.json'], backup)
    await mkdir(restored)
    await restoreBackup(backup, manifest, restored)
    expect(await readFile(join(restored, 'settings.json'), 'utf8')).toBe('{"known":1,"future":{"x":2}}')
  })

  it('rejects a backup path whose parent directory is a link outside the source root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xs-migration-')); roots.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'xs-outside-')); roots.push(outside)
    const backup = join(outside, 'backup')
    await writeFile(join(outside, 'secret.json'), '{"secret":true}')
    const { symlink } = await import('node:fs/promises')
    const linked = join(root, 'linked')
    try { await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir') } catch { return }
    await expect(backupFiles(root, ['linked/secret.json'], backup)).rejects.toThrow(/linked directory outside source root/)
  })
})
