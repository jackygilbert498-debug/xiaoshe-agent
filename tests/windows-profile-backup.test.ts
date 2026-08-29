import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const windowsIt = process.platform === 'win32' ? it : it.skip

describe('Windows DSH Profile backup', () => {
  windowsIt('backs up durable Profile files without traversing node_modules junctions', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'xiaoshe-profile-backup-'))
    const profileRoot = join(fixtureRoot, 'profile')
    const backupRoot = join(fixtureRoot, 'backup')
    const junctionTarget = join(fixtureRoot, 'junction-target')

    try {
      await mkdir(join(profileRoot, 'node_modules'), { recursive: true })
      await mkdir(junctionTarget, { recursive: true })
      await writeFile(join(profileRoot, 'cordis.yml'), 'name: web\n', 'utf8')
      await writeFile(join(profileRoot, 'package.json'), '{"private":true}\n', 'utf8')
      await writeFile(join(junctionTarget, 'must-not-be-copied.txt'), 'outside profile\n', 'utf8')
      await symlink(junctionTarget, join(profileRoot, 'node_modules', 'workspace-link'), 'junction')

      const result = spawnSync('pwsh', [
        '-NoLogo',
        '-NoProfile',
        '-File',
        resolve('scripts/backup-dsh-profile.ps1'),
        '-SourceRoot',
        profileRoot,
        '-BackupRoot',
        backupRoot,
      ], { encoding: 'utf8' })

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(await readFile(join(backupRoot, 'cordis.yml'), 'utf8')).toBe('name: web\n')
      expect(await readFile(join(backupRoot, 'package.json'), 'utf8')).toBe('{"private":true}\n')
      await expect(access(join(backupRoot, 'node_modules'))).rejects.toThrow()
      expect(await readFile(join(junctionTarget, 'must-not-be-copied.txt'), 'utf8')).toBe('outside profile\n')
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })
})
