import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { readTextFile, scanWorkspaceTree } from '../lib/read-model.js'
import { parseGitStatusPorcelainV2, parseNameStatus } from '../lib/git.js'

test('tree and read are bounded, stable, binary-aware and ignore heavy internals', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-tree-')); t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src')); await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'src', 'a.ts'), 'a\n'.repeat(20)); await writeFile(join(root, 'node_modules', 'x'), 'x')
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]))
  const tree = await scanWorkspaceTree(root, { maxEntries: 20, maxDepth: 4 })
  assert.deepEqual(tree.entries.map(row => row.path), ['binary.bin', 'src', 'src/a.ts'])
  assert.equal((await readTextFile(join(root, 'src', 'a.ts'), { maxBytes: 10 })).truncated, true)
  await assert.rejects(() => readTextFile(join(root, 'binary.bin')), /binary/iu)
})

test('git parsers preserve rename facts and deterministic changed paths', () => {
  const status = parseGitStatusPorcelainV2('1 .M N... 100644 100644 100644 a a src/a.ts\0' +
    '2 R. N... 100644 100644 100644 a a R100 src/new.ts\0src/old.ts\0')
  assert.equal(status[1].kind, 'renamed'); assert.equal(status[1].originalPath, 'src/old.ts')
  assert.deepEqual(parseNameStatus('M\tsrc/a.ts\nR100\tsrc/old.ts\tsrc/new.ts\n'), [
    { kind: 'modified', path: 'src/a.ts' }, { kind: 'renamed', path: 'src/new.ts', originalPath: 'src/old.ts' },
  ])
})
