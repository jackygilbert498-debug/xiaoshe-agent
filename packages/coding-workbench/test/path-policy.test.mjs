import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { WorkspacePathPolicy } from '../lib/path-policy.js'

test('workspace path policy rejects absolute, traversal, NUL and symlink escape', async t => {
  const base = await mkdtemp(join(tmpdir(), 'xiaoshe-workspace-')); t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'root'); const outside = join(base, 'outside'); await mkdir(root); await mkdir(outside)
  await writeFile(join(root, 'ok.txt'), 'ok'); await writeFile(join(outside, 'secret.txt'), 'no')
  try { await symlink(outside, join(root, 'escape'), 'junction') } catch { return }
  const policy = new WorkspacePathPolicy({ list: () => [{ id: 'w1', path: root }] })
  assert.equal((await policy.existing('w1', 'ok.txt', 'file')).relativePath, 'ok.txt')
  for (const bad of ['../outside/secret.txt', join(outside, 'secret.txt'), 'bad\0name']) await assert.rejects(() => policy.existing('w1', bad), /path|relative|escape|control/iu)
  await assert.rejects(() => policy.existing('w1', 'escape/secret.txt'), /escape/iu)
})

test('write target canonicalizes its existing parent and stays in workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-write-')); t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'))
  const policy = new WorkspacePathPolicy({ list: () => [{ id: 'w1', path: root }] })
  const target = await policy.forWrite('w1', 'src/new.ts')
  assert.equal(target.relativePath, 'src/new.ts')
  await assert.rejects(() => policy.forWrite('missing', 'x'), /unknown workspace/iu)
})
