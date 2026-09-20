import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLIC_MODLENS_ROOT, captureVisionEnvelope, installIsolatedVision, snapshotVisionPublicFiles } from './vision-install.mjs'
import { readVisionEngineLedger } from './vision-engine-runtime.mjs'
import { runVision } from '../modlens-vision-runtime.mjs'
import { createVisionFixture } from './vision-fixture.mjs'
import { CODEX_SCHEMA_FILE, createCodexSchemaArtifact } from '../modlens-codex-schema.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const productRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/u, '')
async function fixture(t) {
  const runId = randomUUID(), acceptanceRoot = join(await fs.realpath(tmpdir()), `xiaoshe-product-acceptance-${runId}`)
  await fs.mkdir(acceptanceRoot, { mode: 0o700 })
  t.after(() => fs.rm(acceptanceRoot, { recursive: true, force: true }))
  const profileRoot = join(acceptanceRoot, 'dsh-home/profiles/web')
  await fs.mkdir(profileRoot, { recursive: true, mode: 0o700 })
  await fs.mkdir(join(acceptanceRoot, 'workspace'), { mode: 0o700 })
  const imagePath = join(acceptanceRoot, 'workspace/input.png'), image = Buffer.from('offline image fixture; no engine reads it')
  await fs.writeFile(imagePath, image)
  const config = { productRoot, acceptanceRoot, profileRoot, runId, sessionId: `xiaoshe-vision-${runId}`, imageSha256: hash(image),
    model: 'offline-vision-model', executable: await fs.realpath(process.execPath), authHome: join(dirname(acceptanceRoot), `nonexistent-auth-${runId}`) }
  return { config, imagePath, image }
}
function fakeRunner(binding, imagePath, overrides = {}) {
  // A unit-only return value, never used as real process/visual proof.
  return async () => ({ code: 0, stdout: JSON.stringify({ image: imagePath, provider: 'codex-cli', result: { summary: 'synthetic answer' },
    meta: { model: binding.model, conversationId: 'offline-conversation' } }), stderr: 'private diagnostic sentinel',
    cleanup: { status: 'confirmed', method: 'posix-process-group', groupId: 9999999, confirmedBy: 'ESRCH' }, ...overrides })
}
const invokeArgs = (installed, imagePath) => [installed.outerBinding.cli.path, '-i', imagePath, '--timeout', '3000', '--prompt', 'offline unit only']

test('copies only pinned public package code and records both source and isolated hashes without auth or CLI execution', async t => {
  const { config } = await fixture(t)
  const before = hash(await fs.readFile(join(PUBLIC_MODLENS_ROOT, 'dist/main.js')))
  const installed = await installIsolatedVision(config)
  assert.equal(installed.schema, 'xiaoshe-vision-install/v1')
  assert.equal(installed.pluginEntry, new URL(`file://${config.profileRoot}/node_modules/@liustack/modlens/dsh/index.js`).href)
  assert.deepEqual(installed.config, { upstream: 'deepseek-official', autoRead: false, timeoutMs: 120000 })
  assert.deepEqual(installed.publicSourceManifest.packages.map(row => [row.name, row.version]), [['@liustack/modlens', '3.22.0'], ['commander', '13.1.0'], ['undici', '8.10.0']])
  assert.equal(installed.publicSourceSha256, hash(JSON.stringify(installed.publicSourceManifest)))
  assert.equal(installed.isolatedSha256, hash(JSON.stringify(installed.isolatedManifest)))
  for (const row of installed.isolatedManifest.files) assert.equal(hash(await fs.readFile(join(config.profileRoot, row.path))), row.sha256)
  assert.equal(hash(await fs.readFile(join(PUBLIC_MODLENS_ROOT, 'dist/main.js'))), before, 'daily public package stays unchanged')
  const schema = createCodexSchemaArtifact(JSON.parse(await fs.readFile(join(PUBLIC_MODLENS_ROOT, 'dsh/vision-schema.json'))))
  assert.equal(installed.engineConfig.outputSchemaPath, join(config.profileRoot, 'node_modules/@liustack/modlens/dist', CODEX_SCHEMA_FILE))
  assert.equal(installed.engineConfig.outputSchemaSha256, schema.sha256)
  assert.deepEqual(await fs.readFile(installed.engineConfig.outputSchemaPath), schema.bytes)
  assert.ok(installed.isolatedManifest.files.some(row => row.path.endsWith('/dsh/xiaoshe-codex-schema.mjs')))
  await assert.rejects(fs.lstat(config.authHome), { code: 'ENOENT' })
  assert.deepEqual((await readVisionEngineLedger(installed.engineConfig.ledgerDirectory)).usage, { status: 'no_model', value: null })
  const plugin = await import(installed.pluginEntry)
  assert.equal(typeof plugin.apply, 'function', 'import only; no apply or provider dispatch')
  const wrapper = await fs.readFile(join(config.profileRoot, 'node_modules/@liustack/modlens/dsh/xiaoshe-vision-runtime.mjs'), 'utf8')
  assert.ok(wrapper.includes('captureVisionEnvelope')); assert.ok(!wrapper.includes('authHome'))
  const index = await fs.readFile(fileURLToPath(installed.pluginEntry), 'utf8')
  assert.ok(index.includes(join(config.acceptanceRoot, 'vision-paste-work')))
  await assert.rejects(installIsolatedVision(config), /target_already_exists/)
})

test('actual pinned ModLens passes the shared static schema to a real local Node substitute; bad shape stays an outer failure without retry', async t => {
  for (const shape of ['generic-schema', 'wrong-rows']) {
    const { config, imagePath } = await fixture(t), image = createVisionFixture({ nonce: '0'.repeat(32) }).png
    await fs.writeFile(imagePath, image); config.imageSha256 = hash(image)
    const executable = join(config.acceptanceRoot, 'OFFLINE-node-engine.mjs')
    const result = shape === 'generic-schema' ? { summary: 'OFFLINE local fixture, not an actual visual model result.',
      ocr: { full_text: '', lines: [] }, layout: { regions: [] }, semantics: { scene: 'offline fixture', intent: null, entities: [] },
      visual: { dominant_colors: null, style: null, notes: null }, uncertainty: [] } : { rows: [[{ color: 'fixture-only' }]] }
    await fs.writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';
const i=process.argv.indexOf('--output-schema');
if(i<0 || process.argv.lastIndexOf('--output-schema')!==i) process.exit(41);
const schema=JSON.parse(fs.readFileSync(process.argv[i+1],'utf8'));
if(schema.additionalProperties!==false || schema.required.join(',')!=='summary,ocr,layout,semantics,visual,uncertainty' || schema.properties.rows) process.exit(42);
for(const event of [{type:'thread.started',thread_id:'offline-local-engine'}, {type:'turn.started'},
{type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(result))}}},
{type:'turn.completed',usage:{input_tokens:7,output_tokens:3}}]) console.log(JSON.stringify(event));\n`, { mode: 0o700 })
    config.executable = executable
    const installed = await installIsolatedVision(config), binding = installed.outerBinding
    const call = () => captureVisionEnvelope(binding, runVision, binding.executable.path, invokeArgs(installed, imagePath), undefined, 3000)
    if (shape === 'generic-schema') {
      const outer = await call(), parsed = JSON.parse(outer.stdout)
      assert.equal(parsed.result.summary, result.summary)
      assert.equal(Object.hasOwn(parsed.result.semantics, 'intent'), false, 'only public optional-null normalization occurs')
    } else await assert.rejects(call(), { code: 'MODLENS_EXIT_FAILED' })
    const ledger = await readVisionEngineLedger(installed.engineConfig.ledgerDirectory)
    assert.equal(ledger.reservedLaunches, 1); assert.equal(ledger.receipt.exitCode, 0)
    assert.deepEqual(ledger.receipt.result, result, 'raw model object is never hand-wrapped as a valid ModLens result')
    assert.deepEqual(ledger.receipt.outputSchema, { path: installed.engineConfig.outputSchemaPath, sha256: installed.engineConfig.outputSchemaSha256 })
    const outer = JSON.parse(await fs.readFile(join(binding.envelopeDirectory, 'receipt-1.json')))
    assert.equal(outer.exitCode, shape === 'generic-schema' ? 0 : 1)
    for (const pid of [ledger.receipt.pid, outer.pid]) for (const target of [pid, -pid]) assert.throws(() => process.kill(target, 0), { code: 'ESRCH' })
    await assert.rejects(call(), { code: 'EEXIST' })
    await assert.rejects(fs.lstat(config.authHome), { code: 'ENOENT' })
    assert.deepEqual(await fs.readdir(join(config.acceptanceRoot, 'workspace')), ['input.png'], 'no schema is written beside the user image')
  }
})
test('source snapshot refuses symlinks, credential-shaped files and traversal', async t => {
  const { config } = await fixture(t), root = join(config.acceptanceRoot, 'public-source-fixture')
  await fs.mkdir(root); await fs.writeFile(join(root, 'safe.js'), 'export const value=1')
  await fs.symlink(join(root, 'safe.js'), join(root, 'link.js'))
  await assert.rejects(snapshotVisionPublicFiles(root, ['link.js']), /public_symlink/)
  await assert.rejects(snapshotVisionPublicFiles(root, ['../workspace/input.png']), /unsafe_public_path/)
  await fs.writeFile(join(root, 'auth.json'), 'do not read this fixture')
  await assert.rejects(snapshotVisionPublicFiles(root, ['auth.json']), /nonpublic_file/)
  const rows = await snapshotVisionPublicFiles(root, ['safe.js'])
  assert.equal(rows[0].sha256, hash('export const value=1'))
})
test('wrong run/profile paths, private-root permissions and symlinked modules fail closed', async t => {
  const { config } = await fixture(t)
  for (const changed of [{ runId: randomUUID() }, { profileRoot: '/Users/zfy/.dsh/profiles/web' },
    { executable: join(config.authHome, 'auth.json') }, { unexpected: true }]) await assert.rejects(installIsolatedVision({ ...config, ...changed }))
  await fs.chmod(config.acceptanceRoot, 0o755)
  await assert.rejects(installIsolatedVision(config), /unsafe_directory/)
  await fs.chmod(config.acceptanceRoot, 0o700)
  const redirected = join(config.acceptanceRoot, 'redirected'); await fs.mkdir(redirected)
  await fs.symlink(redirected, join(config.profileRoot, 'node_modules'))
  await assert.rejects(installIsolatedVision(config), /unsafe_directory/)
  assert.deepEqual(await fs.readdir(redirected), [])
})
test('outer capture persists a distinct Node envelope before returning and denies a second dispatch', async t => {
  const { config, imagePath } = await fixture(t), installed = await installIsolatedVision(config), binding = installed.outerBinding
  let calls = 0
  const runner = async (...args) => { calls++; return fakeRunner(binding, imagePath)(...args) }
  const result = await captureVisionEnvelope(binding, runner, binding.executable.path, invokeArgs(installed, imagePath), undefined, 3000)
  const receipt = JSON.parse(await fs.readFile(join(binding.envelopeDirectory, 'receipt-1.json')))
  assert.equal(receipt.schema, 'xiaoshe-vision-envelope/v1'); assert.equal(receipt.pid, 9999999)
  assert.equal(receipt.executable.path, await fs.realpath(process.execPath)); assert.equal(receipt.cli.path, binding.cli.path)
  assert.equal(receipt.inputSha256, config.imageSha256); assert.equal(receipt.rawStdoutSha256, hash(result.stdout))
  assert.deepEqual(receipt.output, JSON.parse(result.stdout)); assert.equal(receipt.errorCode, null)
  assert.ok(!JSON.stringify(receipt).includes('private diagnostic sentinel'))
  assert.equal(await fs.readFile(join(binding.envelopeDirectory, 'stdout-1.json'), 'utf8'), result.stdout)
  await assert.rejects(captureVisionEnvelope(binding, runner, binding.executable.path, invokeArgs(installed, imagePath), undefined, 3000), { code: 'EEXIST' })
  assert.equal(calls, 1)
  assert.equal((await readVisionEngineLedger(installed.engineConfig.ledgerDirectory)).reservedLaunches, 0, 'a unit envelope never masquerades as an engine launch')
})
test('tampered image, CLI override or aborted input cannot reach the product runner', async t => {
  const { config, imagePath } = await fixture(t), installed = await installIsolatedVision(config), binding = installed.outerBinding
  const runner = () => assert.fail('must not dispatch')
  const wrong = invokeArgs(installed, imagePath); wrong[0] = '/not/the/pinned/cli'
  await assert.rejects(captureVisionEnvelope(binding, runner, binding.executable.path, wrong, undefined, 3000), /outer_invocation_not_allowed/)
  await fs.appendFile(imagePath, 'changed')
  await assert.rejects(captureVisionEnvelope(binding, runner, binding.executable.path, invokeArgs(installed, imagePath), undefined, 3000), /outer_identity_changed/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(captureVisionEnvelope(binding, runner, binding.executable.path, invokeArgs(installed, imagePath), controller.signal, 3000), /VISION_CANCELLED/)
  assert.deepEqual(await fs.readdir(binding.envelopeDirectory), [])
})
test('receipt persistence failure consumes the outer slot, returns no success and never retries execution', async t => {
  const { config, imagePath } = await fixture(t), installed = await installIsolatedVision(config), binding = installed.outerBinding
  await fs.mkdir(join(binding.envelopeDirectory, 'receipt-1.json'))
  let calls = 0
  const runner = async () => { calls++; return fakeRunner(binding, imagePath)() }
  await assert.rejects(captureVisionEnvelope(binding, runner, binding.executable.path, invokeArgs(installed, imagePath), undefined, 3000), { code: 'EEXIST' })
  await assert.rejects(captureVisionEnvelope(binding, runner, binding.executable.path, invokeArgs(installed, imagePath), undefined, 3000), { code: 'EEXIST' })
  assert.equal(calls, 1); assert.ok((await fs.stat(join(binding.envelopeDirectory, 'reserved-1.json'))).isFile())
})
test('nonzero and unconfirmed cleanup are durable failures, never successful envelope receipts', async t => {
  for (const overrides of [{ code: 7 }, { cleanup: { status: 'unconfirmed', groupId: 9999999, probeErrorCode: 'EPERM' } }]) {
    const { config, imagePath } = await fixture(t), installed = await installIsolatedVision(config), binding = installed.outerBinding
    await assert.rejects(captureVisionEnvelope(binding, fakeRunner(binding, imagePath, overrides), binding.executable.path, invokeArgs(installed, imagePath), undefined, 3000))
    const receipt = JSON.parse(await fs.readFile(join(binding.envelopeDirectory, 'receipt-1.json')))
    assert.ok(receipt.errorCode); assert.ok(!JSON.stringify(receipt).includes('private diagnostic sentinel'))
  }
})
