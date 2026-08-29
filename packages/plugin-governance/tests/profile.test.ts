import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshProfileManager } from '../src/dsh-profile.js'
import type { ProcessRunOptions, ProcessResult } from '../src/process-runner.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('official DSH Profile manager', () => {
  it('uses exact Node/CLI argv, the configured DSH_HOME and no secret environment inheritance', async () => {
    const root = await fixtureHome()
    const exactRoot = await realpath(root)
    const calls: ProcessRunOptions[] = []
    const manager = new DshProfileManager({
      dshHome: root, cliPath: join(root, 'cli.ts'), cwd: root,
      run: async options => { calls.push(options); return success('dump') },
      environment: { PATH: process.env.PATH, OPENAI_API_KEY: 'must-not-cross-boundary' },
    })
    const candidate = join(root, 'candidate.tgz'); await writeFile(candidate, 'candidate')
    const exactCandidate = await realpath(candidate)
    await manager.add('xiaoshe-managed-proof', candidate, new AbortController().signal)
    await manager.remove('xiaoshe-managed-proof', '@xiaoshe/fixture', new AbortController().signal)
    await manager.dump('xiaoshe-managed-proof', new AbortController().signal)

    expect(calls.map(call => call.args)).toEqual([
      ['--import', 'tsx/esm', join(exactRoot, 'cli.ts'), 'plugin', '--profile', 'xiaoshe-managed-proof', 'add', '--offline', exactCandidate],
      ['--import', 'tsx/esm', join(exactRoot, 'cli.ts'), 'plugin', '--profile', 'xiaoshe-managed-proof', 'remove', '@xiaoshe/fixture'],
      ['--import', 'tsx/esm', join(exactRoot, 'cli.ts'), '--profile', 'xiaoshe-managed-proof', '--dump-config'],
    ])
    expect(calls.every(call => call.command === process.execPath && call.environment.DSH_HOME === exactRoot)).toBe(true)
    expect(calls[0]?.environment.OPENAI_API_KEY).toBeUndefined()
  })

  it('bootstraps an inactive managed Profile by replaying locked dependency specs in order', async () => {
    const root = await fixtureHome({
      '@deepseek-ai/dsh-web-app': 'link:C:/runtime/web-app',
      '@xiaoshe/product-bundle': 'file:C:/artifacts/product.tgz',
    })
    const calls: readonly string[][] = []
    const mutableCalls = calls as string[][]
    const manager = new DshProfileManager({
      dshHome: root, cliPath: join(root, 'cli.ts'), cwd: root,
      run: async options => { mutableCalls.push([...options.args]); return success() },
    })
    const receipt = await manager.bootstrap('xiaoshe-managed-staging', 'source', new AbortController().signal)
    expect(receipt.steps?.map(step => step.argv)).toEqual([[
      'plugin', '--profile', 'xiaoshe-managed-staging', 'add', '--offline',
      'link:C:/runtime/web-app', 'file:C:/artifacts/product.tgz',
    ]])
    expect(mutableCalls).toHaveLength(1)
  })

  it('rejects unmanaged Profile names and non-installed removals at the boundary', async () => {
    const root = await fixtureHome()
    const manager = new DshProfileManager({ dshHome: root, cliPath: join(root, 'cli.ts'), cwd: root, run: async () => success() })
    await expect(manager.remove('../active', 'fixture', new AbortController().signal)).rejects.toThrow(/managed profile/iu)
    await expect(manager.remove('xiaoshe-managed-proof', 'bad name', new AbortController().signal)).rejects.toThrow(/package name/iu)
  })
})

async function fixtureHome(dependencies: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-dsh-profile-')); roots.push(root)
  await mkdir(join(root, 'profiles', 'source'), { recursive: true })
  await writeFile(join(root, 'profiles', 'source', 'package.json'), JSON.stringify({ dependencies, dsh: { profile: { bundles: Object.keys(dependencies) } } }))
  await writeFile(join(root, 'cli.ts'), '// fixture')
  return root
}
function success(stdout = ''): ProcessResult { return { exitCode: 0, stdout, stderr: '', timedOut: false, aborted: false, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0 } }
