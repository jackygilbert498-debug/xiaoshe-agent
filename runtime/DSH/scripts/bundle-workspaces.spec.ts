import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it.each(['host', 'client'])('only bundles manifest-owned workspaces for the %s face', face => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bundle-discovery-')); roots.push(root)
  const valid = ['vendor/library', 'packages/core/real', 'packages/client/browser', 'apps/cli', 'apps/desktop', 'apps/desktop-host']
  for (const path of valid) {
    mkdirSync(join(root, path), { recursive: true })
    writeFileSync(join(root, path, 'package.json'), '{}')
  }
  for (const path of ['packages/session/session-persistence-sqlite', 'packages/host/apiproxy', 'vendor/retired']) {
    mkdirSync(join(root, path, 'lib/types'), { recursive: true })
    writeFileSync(join(root, path, 'lib/types/index.js'), 'export const legacy = true')
  }
  // Execute the actual config in a separate process: no global chdir in Vitest,
  // no bundler execution, and no dependency on the real checkout being clean.
  const configUrl = new URL('../tsdown.config.ts', import.meta.url).href
  const code = `import config from ${JSON.stringify(configUrl)};
    import { globSync } from 'node:fs';
    process.chdir(${JSON.stringify(root)});
    const value = await config({ env: { DSH_BUILD_FACE: ${JSON.stringify(face)} } });
    const selected = value.workspace.filter(p => !p.startsWith('!'));
    const excluded = new Set(value.workspace.filter(p => p.startsWith('!')).map(p => p.slice(1)));
    console.log(JSON.stringify({ paths: [...globSync(selected)].map(p => p.replaceAll('\\\\', '/')).filter(p => !excluded.has(p)).sort(), entry: value.entry, clean: value.clean, plugins: value.plugins.length }));`
  const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: dirname(fileURLToPath(new URL('../package.json', import.meta.url))), encoding: 'utf8',
  }))
  expect(result.paths).toEqual(valid.filter(path => face === 'host' || !['apps/desktop', 'apps/desktop-host'].includes(path)).sort())
  expect(result.entry).toEqual(face === 'host' ? ['lib/types/{index,invariant,startup}.js'] : '')
  expect(result.plugins).toBe(face === 'host' ? 1 : 0)
  expect(result.clean).toBe(false)
})
