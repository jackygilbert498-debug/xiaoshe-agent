import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('an existing SettingsScope implementation without getSnapshot remains source-compatible', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-settings-public-compat-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const dshRoot = resolve(import.meta.dirname, '../../../..')
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'ES2024',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      ignoreDeprecations: '6.0',
      baseUrl: dshRoot,
      paths: {
        '@deepseek-ai/dsh-settings': ['packages/settings/settings/lib/types/index.d.ts'],
      },
    },
    files: ['./fixture.ts'],
  }), 'utf8')
  await writeFile(join(directory, 'fixture.ts'), `
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
const legacyScope: SettingsScope<{ enabled: boolean }> = {
  get: () => ({ enabled: true }),
  watch: () => () => {},
  update: async () => {},
  replace: async () => {},
}
void legacyScope
`, 'utf8')

  const tsc = resolve(dshRoot, 'node_modules/typescript/bin/tsc')
  const result = await run(process.execPath, [tsc, '-p', join(directory, 'tsconfig.json')], dshRoot)
  assert.equal(result.code, 0, result.stderr || result.stdout)
})

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => resolvePromise({ code, stdout, stderr }))
  })
}
