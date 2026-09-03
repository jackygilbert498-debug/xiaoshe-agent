import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contractSource = resolve(packageRoot, '../runtime-contract/src/index.ts')
const result = await build({
  entryPoints: [resolve(packageRoot, 'src/client/index.ts')], bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'node22', sourcemap: 'inline', logLevel: 'silent',
  plugins: [{ name: 'xiaoshe-runtime-contract-source', setup(api) {
    api.onResolve({ filter: /^@xiaoshe\/runtime-contract$/ }, () => ({ path: contractSource }))
  } }],
})
const body = result.outputFiles[0]?.text
if (body === undefined) throw new Error('provider readiness test build produced no artifact')
const output = resolve(packageRoot, 'test/.generated/client.mjs')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, body, 'utf8')
