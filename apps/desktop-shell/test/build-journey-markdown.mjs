import { createRequire } from 'node:module'
import { resolve } from 'node:path'

/**
 * Bundle the actual upstream Markdown component for the Chromium journey.
 * React belongs to the renderer; parsers, syntax grammars, CSS modules and
 * KaTeX fonts stay bundled so the fixture requires no asset server or network.
 * outputDirectory only names virtual esbuild outputs: write:false creates no files.
 * @param {string} repositoryRoot Absolute XS checkout path.
 * @param {string} outputDirectory Directory used to name in-memory output files.
 * @returns {Promise<{code: string, css: string}>} CommonJS exports and matching CSS.
 */
export async function buildJourneyMarkdown(repositoryRoot, outputDirectory) {
  for (const [name, value] of Object.entries({ repositoryRoot, outputDirectory })) {
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a nonempty path`)
  }
  const root = resolve(repositoryRoot)
  const { build } = createRequire(resolve(root, 'packages/runtime-dsh-provider/package.json'))('esbuild')
  const external = new Set(['react', 'react/jsx-runtime'])
  const result = await build({
    absWorkingDir: root,
    entryPoints: [resolve(root, 'runtime/DSH/packages/client/ui-primitives/src/markdown/MarkdownText.tsx')],
    outfile: resolve(outputDirectory, 'journey-markdown.cjs'),
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    jsx: 'automatic',
    tsconfig: resolve(root, 'runtime/DSH/tsconfig.base.json'),
    external: [...external],
    loader: { '.module.css': 'local-css', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    logLevel: 'silent',
  })
  // Fail explicitly if an upstream change introduces a new renderer dependency.
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && !external.has(imported.path) && !imported.path.startsWith('data:')) {
        throw new Error(`Markdown journey bundle has an unexpected external dependency: ${imported.path}`)
      }
    }
  }
  const code = result.outputFiles.find(file => file.path.endsWith('.cjs'))?.text
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text
  if (!code || !css) throw new Error('Markdown journey bundle must contain both CommonJS and CSS outputs')
  return { code, css }
}
