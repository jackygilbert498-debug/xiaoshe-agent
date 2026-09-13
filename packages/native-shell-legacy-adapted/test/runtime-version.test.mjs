import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { clientSourceIdentity } from '../../../scripts/runtime-version-status.mjs'

async function client() {
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

test('UI uses full backend and loaded frontend identities, never just HTTP or version text', async () => {
  const { runtimeVersionPresentation } = await client()
  const hash = 'a'.repeat(64); const changed = 'a'.repeat(63) + 'b'
  const report = { schema: 'xiaoshe-runtime-version/v1', status: 'current', source: 'developer-source', candidate: { identity: hash }, backend: { identity: hash },
    frontend: { source_identity: hash, build_identity: hash, state: 'current', loaded_state: 'current' } }
  assert.equal(runtimeVersionPresentation(report, hash).state, 'current')
  assert.equal(runtimeVersionPresentation(report, changed).state, 'stale', 'same 12-character display prefix is not identity equality')
  assert.equal(runtimeVersionPresentation(report).state, 'unknown', 'unbuilt source marker is not evidence')
  assert.equal(runtimeVersionPresentation({ ...report, backend: {} }, hash).state, 'unknown')
  assert.equal(runtimeVersionPresentation({ version: '99.0', status: 'current' }, hash).state, 'unknown')
  assert.equal(runtimeVersionPresentation({ ...report, status: 'unavailable' }, hash).state, 'unavailable')
  assert.match(runtimeVersionPresentation({ ...report, status: 'stale' }, hash).detail, /不会自动刷新或重启/u)
})

test('build embeds the actual source/CSS fingerprint and writes the matching artifact manifest in isolation', async t => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'xs-version-build-'))
  t.after(() => rm(outputRoot, { recursive: true, force: true }))
  const output = join(outputRoot, 'client.js')
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/build-client.mjs', import.meta.url)), '--output', output])
  const [artifact, manifestText] = await Promise.all([readFile(output, 'utf8'), readFile(join(outputRoot, 'client.version.json'), 'utf8')])
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.source_identity, await clientSourceIdentity(fileURLToPath(new URL('..', import.meta.url))))
  assert.ok(artifact.includes(manifest.source_identity))
  assert.ok(!artifact.includes('__XIAOSHE_CLIENT_SOURCE_IDENTITY__'))
  assert.equal(manifest.artifact_identity, createHash('sha256').update(artifact).digest('hex'))
  const mounts = [], cleanups = []
  let module
  const window = { __ModuleLoader__: { load: value => { module = value.factory(() => { throw new Error('unexpected external dependency') }) } },
    xiaosheDesktop: { version: { mountFrontend: identity => { mounts.push(identity); return () => cleanups.push(identity) } } } }
  vm.runInNewContext(artifact, { window, console })
  assert.deepEqual(mounts, [], 'loading the built module alone is not a committed root observation')
  const slots = []
  const dispose = module.apply({ theme: {
    getTheme: () => ({ preference: 'system', active: { id: 'light', colorScheme: 'light' }, revision: 0, fontSize: 14 }),
    setTheme() {}, overrideTokens: () => () => {},
  }, slots: {
    inject: (_name, install) => install(), register: (definition, component) => { slots.push({ definition, component }); return () => {} },
  } }, { createElement: () => null }, { MarkdownText: () => null })
  assert.ok(slots.some(value => value.definition.id === 'xiaoshe-native-shell-legacy-adapted'))
  assert.deepEqual(mounts, [], 'registering the root seat does not report a rendered frontend')
  const root = slots.find(value => value.definition.id === 'xiaoshe-native-shell-legacy-adapted').component
  assert.match(String(root), /useEffect\(mountLoadedFrontendVersion, \[\]\)/u, 'the actual root commit effect owns mount/disposal')
  const release = module.mountLoadedFrontendVersion('not-an-identity-input')
  assert.deepEqual(mounts, [manifest.source_identity], 'the callable helper only uses its built closure constant, never caller arguments')
  release(); assert.deepEqual(cleanups, [manifest.source_identity])
  dispose()
  delete window.xiaosheDesktop
  assert.doesNotThrow(() => module.mountLoadedFrontendVersion()())
})

test('unbuilt placeholders cannot report a loaded frontend or require a desktop bridge in browser-only mode', async () => {
  const { mountLoadedFrontendVersion } = await client()
  assert.equal(typeof mountLoadedFrontendVersion(), 'function')
  assert.doesNotThrow(() => mountLoadedFrontendVersion()())
})
