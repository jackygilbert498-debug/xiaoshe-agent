import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { repositoryCommitHash } from '../../../runtime/DSH/scripts/client-build-environment.ts'

test('a source distribution without .git receives a deterministic content revision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-no-git-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"name":"distributed-dsh"}\n')
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(root, 'scripts', 'entry.ts'), 'export const value = 1\n')

  const first = repositoryCommitHash(root, {})
  assert.match(first, /^[0-9a-f]{7}$/u)
  assert.equal(repositoryCommitHash(root, {}), first)
  await writeFile(join(root, 'scripts', 'entry.ts'), 'export const value = 2\n')
  assert.notEqual(repositoryCommitHash(root, {}), first)
})
