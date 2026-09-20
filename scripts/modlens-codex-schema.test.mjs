import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, readFile, writeFile, rm, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexSchemaArtifact, assertCodexSchemaFile, withCodexOutputSchema } from './modlens-codex-schema.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const schema = { type: 'object', properties: { summary: { type: 'string' },
  ocr: { type: 'object', properties: { full_text: { type: 'string' }, lines: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, language: { type: 'string' } }, required: ['text'] } } }, required: ['full_text', 'lines'] },
  layout: { type: 'object', properties: { regions: { type: 'array', items: { type: 'string' } } }, required: ['regions'] },
  semantics: { type: 'object', properties: { scene: { type: 'string' }, intent: { type: 'string' } }, required: ['scene'] },
  visual: { type: 'object', properties: { style: { type: 'string' } } }, uncertainty: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'ocr', 'layout', 'semantics', 'visual', 'uncertainty'] }
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xs-codex-schema-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'installed-schema.json'), artifact = createCodexSchemaArtifact(schema)
  await writeFile(path, artifact.bytes, { mode: 0o600 })
  return { root, path, artifact, binding: () => assertCodexSchemaFile(path, artifact.sha256), invocation: { args: ['exec', '--output-schema', path, '--', 'offline fixture only'] } }
}
test('static generic ModLens schema makes only optional properties nullable and closes every object', () => {
  const artifact = createCodexSchemaArtifact(schema)
  assert.equal(artifact.sha256, hash(artifact.bytes)); assert.equal(artifact.schema.additionalProperties, false)
  assert.deepEqual(artifact.schema.required, Object.keys(schema.properties))
  const line = artifact.schema.properties.ocr.properties.lines.items
  assert.equal(line.additionalProperties, false); assert.deepEqual(line.required, ['text', 'language'])
  assert.deepEqual(line.properties.language, { anyOf: [{ type: 'string' }, { type: 'null' }] })
  assert.deepEqual(line.properties.text, { type: 'string' })
  assert.throws(() => createCodexSchemaArtifact({ type: 'object', properties: { rows: {} }, required: ['rows'] }), /not_modlens_vision_schema/u)
  assert.equal(Object.hasOwn(schema.properties, 'additionalProperties'), false, 'input schema is not mutated')
})
test('installed artifact is strictly bound to the current ordinary file and exact hash', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.binding(), { path: f.path, sha256: f.artifact.sha256 })
  await writeFile(f.path, '{}'); assert.throws(f.binding, /artifact_changed/u)
  await writeFile(f.path, f.artifact.bytes); await chmod(f.path, 0o666)
  if (process.platform !== 'win32') assert.throws(f.binding, /unsafe_artifact/u)
  else assert.deepEqual(f.binding(), { path: f.path, sha256: f.artifact.sha256 })
  await chmod(f.path, 0o600)
  await t.test('symbolic schema files are rejected', async sub => {
    const link = join(f.root, 'linked.json')
    try { await symlink(f.path, link) } catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') {
        sub.skip('Windows file-symlink privilege unavailable')
        return
      }
      throw error
    }
    assert.throws(() => assertCodexSchemaFile(link, f.artifact.sha256), /unsafe_artifact/u)
  })
  await rm(f.path); assert.throws(f.binding, { code: 'ENOENT' })
})
test('shared daily/isolated wrapper is read-only, preserves args/output and never retries failed or cancelled calls', async t => {
  const f = await fixture(t), originalArgs = f.invocation.args, result = { stdout: 'unmodified offline JSONL' }; let calls = 0
  assert.equal(await withCodexOutputSchema('codex-cli', f.invocation, f.binding, async () => { calls++; return result }), result)
  assert.equal(f.invocation.args, originalArgs); assert.equal(calls, 1)
  for (const code of ['VISION_CANCELLED', 'VISION_TIMEOUT', 'engine_exit_failed']) {
    const error = Object.assign(new Error('offline failure'), { code })
    await assert.rejects(withCodexOutputSchema('codex-cli', f.invocation, f.binding, async () => { calls++; throw error }), cause => cause === error)
  }
  assert.equal(calls, 4); assert.deepEqual(await readFile(f.path), f.artifact.bytes)
  assert.equal(await withCodexOutputSchema('other-provider', null, () => assert.fail('non-Codex must not read artifact'), async () => result), result)
})
test('schema changes during success/error become explicit failures; wrong argument cannot dispatch', async t => {
  for (const originalCode of [null, 'VISION_CANCELLED']) {
    const f = await fixture(t)
    await assert.rejects(withCodexOutputSchema('codex-cli', f.invocation, f.binding, async () => {
      await writeFile(f.path, '{}')
      if (originalCode) throw Object.assign(new Error('cancelled offline'), { code: originalCode })
      return { stdout: '{"rows":[]}' }
    }), error => error.code === 'artifact_changed' && (!originalCode || error.originalCode === originalCode))
  }
  const f = await fixture(t)
  for (const args of [['exec', '--', 'prompt'], ['exec', '--output-schema', '/different', '--', 'prompt'],
    ['exec', '--output-schema', f.path, '--output-schema', f.path, '--', 'prompt']]) {
    await assert.rejects(withCodexOutputSchema('codex-cli', { args }, f.binding, () => assert.fail('no dispatch')), /schema_argument_mismatch/u)
  }
})
