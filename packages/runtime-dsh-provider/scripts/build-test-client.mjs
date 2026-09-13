import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(packageRoot, 'src/client/index.ts')
const contractSource = resolve(packageRoot, '../runtime-contract/src/index.ts')
const outputPath = resolve(packageRoot, 'test/.generated/client.mjs')

/** Build a Node ESM test face without changing the browser registration artifact. */
const result = await build({
  entryPoints: [sourcePath],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  logLevel: 'silent',
  plugins: [{
    name: 'xiaoshe-runtime-contract-source',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@xiaoshe\/runtime-contract$/ }, () => ({ path: contractSource }))
    },
  }],
})
const body = result.outputFiles[0]?.text
if (body === undefined) throw new Error('runtime DSH provider test build produced no artifact')
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, body, 'utf8')
