import { access, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const dshPackageJson = JSON.parse(await readFile(new URL('../runtime/DSH/package.json', import.meta.url), 'utf8'))

test('Windows installer ships its Profile backup helper and standard tests exercise it', async () => {
  assert(packageJson.files.includes('scripts/backup-dsh-profile.ps1'))
  assert(packageJson.scripts['test:agent'].includes('scripts/backup-dsh-profile.test.mjs'))
  await access(new URL('./backup-dsh-profile.ps1', import.meta.url))
  await access(new URL('./backup-dsh-profile.test.mjs', import.meta.url))
})

async function readPackage(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'))
}

test('agent test entry points build the current root before loading dist', () => {
  for (const name of ['test:agent', 'test:agent:integration']) {
    const command = packageJson.scripts?.[name]
    assert.equal(typeof command, 'string', `${name} must exist`)
    assert.match(
      command,
      /^npm run build\s*&&\s*/u,
      `${name} must run the cross-platform root build before its test command`,
    )
  }
})

test('agent integration builds every library-backed dependency before loading tests', () => {
  const command = packageJson.scripts?.['test:agent:integration']
  assert.equal(typeof command, 'string', 'test:agent:integration must exist')

  const testStart = command.indexOf('node --test')
  assert.notEqual(testStart, -1, 'test:agent:integration must invoke node --test')
  const buildPrefix = command.slice(0, testStart)
  const requiredBuilds = [
    'npm run build:lib:host --prefix runtime/DSH',
    'npm run build:lib:client --prefix runtime/DSH',
    'npm run build --prefix packages/verification-policy',
    'npm run build --prefix packages/completion-receipt',
  ]
  for (const build of requiredBuilds) {
    assert.ok(buildPrefix.includes(build), `${build} must run before integration tests load lib output`)
  }
  assert.ok(
    buildPrefix.indexOf(requiredBuilds[2]) < buildPrefix.indexOf(requiredBuilds[3]),
    'verification-policy must build before its completion-receipt consumer',
  )
})

test('complex live acceptance connects to the existing service without launching or restarting it', () => {
  assert.equal(
    packageJson.scripts?.['test:agent:complex-live'],
    'node scripts/acceptance/harness-performance-complex-smoke.mjs',
  )
})

test('the retired weak complex-task acceptance entry cannot be invoked accidentally', async () => {
  await assert.rejects(
    access(new URL('./acceptance/agent-complex-task-smoke.mjs', import.meta.url)),
    error => error?.code === 'ENOENT',
  )
})

test('DSH persistence seams are covered by package and root standard test entries', async () => {
  const packages = await Promise.all([
    readPackage('../runtime/DSH/packages/settings/settings/package.json'),
    readPackage('../runtime/DSH/packages/settings/settings-file/package.json'),
    readPackage('../runtime/DSH/packages/util/atomic-write/package.json'),
  ])
  for (const manifest of packages) {
    assert.match(manifest.scripts?.test ?? '', /(?:node|tsx).*(?:--test|test\/)/u, `${manifest.name} must expose a standard test entry`)
    assert.ok(dshPackageJson.scripts?.test?.includes(`--prefix ${manifest.repository.directory}`), `DSH root test must invoke ${manifest.name}`)
  }
})

test('DSH standard gates retain settings status, MCP dependencies and upstream native/Vitest coverage', async () => {
  const ui = await readPackage('../runtime/DSH/packages/client/ui-settings/package.json')
  const mcp = await readPackage('../runtime/DSH/packages/mcp/mcp-client/package.json')
  assert.match(ui.scripts?.test ?? '', /tsx.*--test test\/\*\.test\.mjs/u)
  assert.equal(mcp.scripts?.['test:runtime-dependencies'], 'node --test test/*.test.mjs')
  assert.equal(dshPackageJson.scripts?.['test:runtime-dependencies'], 'npm run test:runtime-dependencies --prefix packages/mcp/mcp-client')
  assert.match(dshPackageJson.scripts?.test ?? '', /--prefix packages\/client\/ui-settings/u)
  assert.match(dshPackageJson.scripts?.test ?? '', /npm run test:runtime-dependencies/u)
  assert.match(dshPackageJson.scripts?.test ?? '', /pnpm run build:native-system\s*&&\s*vitest run/u)
  assert.match(dshPackageJson.scripts?.typecheck ?? '', /npm run test:runtime-dependencies/u)
})

test('fresh-output package tests prepare or source-load only their minimal DSH prerequisites', async () => {
  const [agent, migration, agentCas] = await Promise.all([
    readPackage('../packages/agent-experience/package.json'),
    readPackage('../packages/migration-recovery/package.json'),
    readFile(new URL('../packages/agent-experience/test/cas-persistence.test.mjs', import.meta.url), 'utf8'),
  ])
  assert.match(agent.scripts?.test ?? '', /tsx.*--tsconfig .*runtime\/DSH\/tsconfig\.base\.json/u)
  assert.doesNotMatch(agentCas, /runtime\/DSH\/.+\/lib\/index\.js/u)

  const migrationTest = migration.scripts?.test ?? ''
  const compile = migrationTest.indexOf('tsc -p tsconfig.build.json')
  assert.notEqual(compile, -1, 'migration-recovery test must compile its own output')
  assert.match(migrationTest.slice(0, compile), /tsc.*-b .*runtime\/DSH\/packages\/util\/atomic-write/u)
  assert.match(migrationTest.slice(compile), /tsx.*--tsconfig .*runtime\/DSH\/tsconfig\.base\.json/u)
})

test('desktop standard tests discover the portable macOS actions cleanup bridge', async () => {
  const desktop = await readPackage('../apps/desktop-shell/package.json')
  assert.match(desktop.scripts?.test ?? '', /test\/\*\.test\.mjs/u)
  await access(new URL('../apps/desktop-shell/test/macos-desktop-actions-python.test.mjs', import.meta.url))
})

test('the installed ModLens patch ships its schema helper and exercises it in the normal agent entry', async () => {
  // The patch imports this helper outside dist; repository-only tests must not
  // hide a missing file in the published desktop-control package.
  for (const path of ['scripts/patch-modlens-runtime.mjs', 'scripts/modlens-vision-runtime.mjs', 'scripts/modlens-codex-schema.mjs', 'scripts/modlens-provider-directory.mjs']) {
    assert(packageJson.files.includes(path), `package files must include ${path}`)
    await access(new URL(`../${path}`, import.meta.url))
  }
  assert(packageJson.scripts['test:agent'].includes('scripts/modlens-codex-schema.test.mjs'))
})

test('private file-proof cold recovery runs after its real JSONL and filesystem libraries are built', async () => {
  const command = packageJson.scripts['test:agent:integration'], testName = 'scripts/verification-file-proofs.test.mjs'
  assert(command.includes(testName))
  assert(command.indexOf('npm run build:lib:host --prefix runtime/DSH') < command.indexOf(testName))
  assert(command.indexOf('npm run build --prefix packages/verification-policy') < command.indexOf(testName))
  assert(!packageJson.scripts['test:agent'].includes(testName), 'the unit-only entry must not load unbuilt host libraries')
  await access(new URL(`../${testName}`, import.meta.url))
})

test('JSONL mutation regression is an independent integration entry, not a child-process stdout import', () => {
  assert(packageJson.scripts['test:agent:integration'].includes('scripts/verification-jsonl.integration.test.mjs'))
})

test('real-user failure regressions stay in the standard integration gate', async () => {
  for (const file of ['schedule.integration.test.mjs', 'schedule-verification.integration.test.mjs', 'research-queue-boundary.integration.test.mjs', 'bridge-client.test.mjs', 'windows-detached-logging.test.mjs']) {
    assert(packageJson.scripts['test:agent:integration'].includes(`scripts/${file}`), `${file} must remain discoverable`)
    await access(new URL(`./${file}`, import.meta.url))
  }
  assert(packageJson.scripts['test:agent'].includes('scripts/document-preparation.test.mjs'))
})

test('Graph regression entry builds real host dependencies and remains in the standard integration gate', () => {
  const command = packageJson.scripts['test:graph']
  assert.equal(typeof command, 'string', 'Graph must have a repeatable standard test command')
  assert.match(command, /^npm run build\s*&&/u)
  const hostBuild = command.indexOf('npm run build:lib:host --prefix runtime/DSH')
  assert.ok(hostBuild >= 0 && hostBuild < command.indexOf('node --test'))
  for (const file of ['task-graph.test.mjs', 'task-graph.integration.test.mjs', 'task-graph.loop.test.mjs']) {
    assert.ok(command.includes(`scripts/${file}`), `${file} must be covered by test:graph`)
    assert.ok(packageJson.scripts['test:agent:integration'].includes(`scripts/${file}`), `${file} must not be an optional-only regression`)
  }
})
