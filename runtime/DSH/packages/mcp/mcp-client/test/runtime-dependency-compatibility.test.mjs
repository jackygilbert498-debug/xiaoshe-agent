import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

async function importDependencyFrom(packageName, dependencyName) {
  const ownerManifestPath = require.resolve(`${packageName}/package.json`)
  const ownerRequire = createRequire(ownerManifestPath)
  const dependencyManifestPath = ownerRequire.resolve(`${dependencyName}/package.json`)
  const dependencyManifest = ownerRequire(dependencyManifestPath)
  const importEntry = dependencyManifest.exports?.['.']?.import?.default

  assert.equal(typeof importEntry, 'string', `${dependencyName} must expose an ESM entry point`)
  return {
    module: await import(pathToFileURL(join(dirname(dependencyManifestPath), importEntry)).href),
    version: dependencyManifest.version,
  }
}

test('filesystem MCP server glob dependency loads as ESM and expands braces', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-glob-compatibility-'))

  try {
    await Promise.all([
      writeFile(join(fixtureRoot, 'alpha-one.txt'), ''),
      writeFile(join(fixtureRoot, 'alpha-two.txt'), ''),
      writeFile(join(fixtureRoot, 'beta.txt'), ''),
    ])

    const dependency = await importDependencyFrom('@modelcontextprotocol/server-filesystem', 'glob')
    assert.match(dependency.version, /^10\./, 'this gate targets the filesystem server glob@10 chain')

    const { glob } = dependency.module
    const matches = await glob('alpha-{one,two}.txt', { cwd: fixtureRoot })

    assert.deepEqual(matches.sort(), ['alpha-one.txt', 'alpha-two.txt'])
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
