import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MANIFEST = resolve('scripts/handoff-manifest.mjs')

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

function addIndexSymlink(root: string, path: string, target: string) {
  const blob = spawnSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: target, encoding: 'utf8' })
  if (blob.status !== 0) throw new Error(blob.stderr)
  git(root, 'update-index', '--add', '--cacheinfo', `120000,${blob.stdout.trim()},${path}`)
}

async function makeRepo(root: string, relativePath: string, files: Record<string, string>) {
  const repo = join(root, relativePath)
  await mkdir(repo, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  git(repo, 'config', 'user.name', 'Fixture')
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), content)
  }
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'fixture')
}

describe('handoff manifest', () => {
  it('verifies an unchanged three-repository payload and detects tampering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xs-handoff-manifest-'))
    await makeRepo(root, '', { 'package.json': '{}\n', 'README.md': 'xs\n' })
    await makeRepo(root, 'runtime/DSH', { '.gitignore': 'lib/\nnode_modules/\n', 'package.json': '{}\n', 'source.txt': 'dsh\n' })
    await makeRepo(root, 'runtime/xiaoshe-legacy', { 'run.py': 'print("legacy")\n' })
    await mkdir(join(root, 'scripts'), { recursive: true })
    await cp(MANIFEST, join(root, 'scripts/handoff-manifest.mjs'))
    await chmod(join(root, 'scripts/handoff-manifest.mjs'), 0o700)
    addIndexSymlink(join(root, 'runtime/DSH'), 'CLAUDE.md', 'AGENTS.md')
    await writeFile(join(root, 'runtime/DSH/CLAUDE.md'), 'AGENTS.md')
    git(join(root, 'runtime/DSH'), 'update-index', '--chmod=+x', 'source.txt')

    const generated = spawnSync(process.execPath, [join(root, 'scripts/handoff-manifest.mjs'), 'generate'], { encoding: 'utf8' })
    expect(generated.status, generated.stderr).toBe(0)
    const generatedManifest = JSON.parse(await readFile(join(root, '交接工具/完整性清单.json'), 'utf8'))
    expect(generatedManifest.files).toContainEqual(expect.objectContaining({
      path: 'runtime/DSH/CLAUDE.md',
      type: 'symlink',
    }))
    const verified = spawnSync(process.execPath, [join(root, 'scripts/handoff-manifest.mjs'), 'verify'], { encoding: 'utf8' })
    expect(verified.status, verified.stderr).toBe(0)

    await mkdir(join(root, 'runtime/DSH/lib'), { recursive: true })
    await writeFile(join(root, 'runtime/DSH/lib/generated.js'), '// build output\n')
    await mkdir(join(root, 'runtime/DSH/node_modules/example'), { recursive: true })
    await writeFile(join(root, 'runtime/DSH/node_modules/example/index.js'), '// dependency\n')
    await mkdir(join(root, 'packages/native-shell/lib'), { recursive: true })
    await writeFile(join(root, 'packages/native-shell/lib/client.js'), '// generated client\n')
    await writeFile(join(root, '.env.local'), 'SECRET=fixture-only\n')
    await writeFile(join(root, '交接工具/XS-完整交接包-fixture.tar.gz.sha256'), 'fixture  archive.tar.gz\n')
    const verifiedAfterInstall = spawnSync(process.execPath, [join(root, 'scripts/handoff-manifest.mjs'), 'verify'], { encoding: 'utf8' })
    expect(verifiedAfterInstall.status, verifiedAfterInstall.stderr).toBe(0)

    await writeFile(join(root, 'runtime/DSH/source.txt'), 'tampered\n')
    const failed = spawnSync(process.execPath, [join(root, 'scripts/handoff-manifest.mjs'), 'verify'], { encoding: 'utf8' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('变更：runtime/DSH/source.txt')

    const manifest = JSON.parse(await readFile(join(root, '交接工具/完整性清单.json'), 'utf8'))
    expect(manifest.git).toHaveLength(3)
  }, 15_000)
})
