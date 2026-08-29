import { readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const packageDefinitions = [
  { relativeDirectory: 'packages/verification-policy' },
  { relativeDirectory: 'packages/native-shell-legacy-adapted' },
  { relativeDirectory: 'packages/runtime-dsh-provider' },
  { relativeDirectory: 'packages/completion-receipt' },
  { relativeDirectory: 'packages/runtime-contract' },
  { relativeDirectory: 'packages/heartbeat' },
  { relativeDirectory: 'packages/memory' },
  { relativeDirectory: 'packages/plugin-governance' },
  { relativeDirectory: 'packages/task-timeline' },
  {
    relativeDirectory: 'runtime/DSH/packages/session-query/tool-session-query',
    licenseRelativePath: 'runtime/DSH/LICENSE',
  },
  { relativeDirectory: '.' },
  { relativeDirectory: 'packages/product-bundle' },
]

// These packages are provided by the locked DSH runtime rather than copied
// into the Product artifact set. Their versions are still needed when the
// staged host plugin's workspace protocols are converted for an offline tarball.
const hostWorkspaceVersionSources = [
  'runtime/DSH/vendor/cordis',
  'runtime/DSH/vendor/schemastery',
  'runtime/DSH/packages/runtime-diagnostics/invariants',
  'runtime/DSH/packages/llm/llm',
  'runtime/DSH/packages/core/session',
  'runtime/DSH/packages/session-query/session-query',
  'runtime/DSH/packages/core/system-prompt',
  'runtime/DSH/packages/util/timeout',
  'runtime/DSH/packages/core/tools',
]

export const PRODUCT_PACKAGES = Object.freeze(packageDefinitions.map(definition => {
  const manifest = packageIdentity(definition.relativeDirectory)
  return Object.freeze({
    name: manifest.name,
    version: manifest.version,
    ...definition,
    filename: tarballFilename(manifest.name, manifest.version),
  })
}))

const versions = new Map(PRODUCT_PACKAGES.map(row => [row.name, row.version]))
for (const relativeDirectory of hostWorkspaceVersionSources) {
  const manifest = packageIdentity(relativeDirectory)
  const existing = versions.get(manifest.name)
  if (existing !== undefined && existing !== manifest.version) {
    throw new Error(`conflicting workspace versions for ${manifest.name}: ${existing} and ${manifest.version}`)
  }
  versions.set(manifest.name, manifest.version)
}

export function rewriteWorkspaceDependencies(input) {
  const output = structuredClone(input)
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (output[field] === undefined) continue
    for (const [name, spec] of Object.entries(output[field])) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue
      const version = versions.get(name)
      if (version === undefined) throw new Error(`unmapped relocatable workspace dependency: ${name}`)
      output[field][name] = version
    }
  }
  return output
}

function packageIdentity(relativeDirectory) {
  const directory = resolve(ROOT, relativeDirectory)
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`invalid package identity at ${directory}`)
  }
  return manifest
}

export function renderPortableOverrides(artifactDirectory, forbiddenSourceDirectory = '') {
  const root = resolve(artifactDirectory)
  const lines = [
    '# >>> Xiaoshe relocatable Product artifacts >>>',
    'overrides:',
  ]
  for (const row of PRODUCT_PACKAGES) {
    lines.push(`  '${row.name}': '${yamlSingleQuote(portableFileSpec(join(root, row.filename)))}'`)
  }
  lines.push('# <<< Xiaoshe relocatable Product artifacts <<<')
  const result = `${lines.join('\n')}\n`
  // Overrides always use forward slashes, including on Windows. Compare the
  // forbidden source with the same representation so a migrated path cannot
  // evade the leak gate solely because the host separator changed.
  if (forbiddenSourceDirectory !== '' && result.includes(portableFileSpec(resolve(forbiddenSourceDirectory)))) {
    throw new Error('portable overrides retained the generating source directory')
  }
  return result
}

export function portableFileSpec(path) {
  return `file:${resolve(path).replaceAll('\\', '/')}`
}

export function tarballFilename(name, version) {
  return `${name.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`
}

export function toPosix(value) {
  return value.split(sep).join('/')
}

function yamlSingleQuote(value) {
  return value.replaceAll("'", "''")
}
