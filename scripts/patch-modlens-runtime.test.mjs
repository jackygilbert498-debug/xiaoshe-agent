import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { patchSource, patchCliSource } from './patch-modlens-runtime.mjs'

const fixture = `import { spawnHidden } from './spawnHidden.js'
const CLI_TIMEOUT_MS = 180_000
const description = 'Requires a configured modlens engine (run \`npx @liustack/modlens doctor\` in a terminal to check).'
export function apply(ctx, config = {}) {
  const tool = {
    timeoutMs: CLI_TIMEOUT_MS + 20_000,
    async execute(args, exec) {
      const cliArgs = [CLI_PATH, '-i', args.path, '--timeout', String(CLI_TIMEOUT_MS)]
      if (args.prompt) {
        cliArgs.push('--prompt', args.prompt)
      }
      return await run(process.execPath, cliArgs, exec.signal)
    }
  }
}
async function readImageBlock(ctx, block, signal) {
  try {
    const { stdout, stderr, code } = await run(
      process.execPath,
      [cli, '-i', file, '--timeout', String(CLI_TIMEOUT_MS)],
      signal,
    )
    if (code !== 0) throw new Error(stderr)
    const parsed = JSON.parse(stdout)
    return { ok: true, block: Object.freeze({ type: 'text', text: renderEvidence(parsed.result) }) }
  } catch (error) { return { ok: false } }
}
const wrapperFixture = {
        stream(options) {
  const self = this
  return (async function* () {
            const converted = await convertImagesToEvidence(ctx, options.messages, options.signal, self)
    const messages = restoreUpstreamSource(converted, providerId, upstream)
    yield* ctx.llm.stream({ ...options, provider: upstream, messages })
  })()
        },
}
function registerDirectoryFixture() {
      registrations.set(upstream, { providerId, registration, state })
}
function dropDirectoryFixture() {
    if (typeof current.registration === 'function') current.registration()
}
function refreshDirectoryFixture() {
    if (!current || typeof current.registration?.replace !== 'function') return
}
function run(command, args, signal) {
  return spawnHidden(command, args, { signal })
}
function renderEvidence(value) { return value.summary }
function openConfig() { spawnHidden('open', ['settings']) }
function cachedEvidence(ctx, adapter, block, walk) {
  const key = evidenceKey(block.attachment ?? block)
  if (hit) {
    return cooling ? Promise.resolve(hit.block) : hit
  }
  const pending = readImageBlock(ctx, block, undefined).then(fulfilled, rejected)
  trimEvidenceCache(adapter.evidenceCache)
  return pending
}
async function convertImagesToEvidence(ctx, messages, signal, adapter) {
  const out = []
    for (const message of messages) {
      if (!contentHasImage(message.content)) {
        continue
      }
      await abortableWait(cachedEvidence(ctx, adapter, block, walk), signal)
    }
}
function autoRead() {
    const messages = []
    // One walk per pre-step
      for (const message of decision.messages) {
        abortableWait(cachedEvidence(ctx, { evidenceCache }, block, walk), payload.signal)
      }
}
`
const oldFailureGuidance = 'Xiaoshe task-focused vision: focus the prompt on the user question instead of requesting unrelated transcription. Registration does not prove the engine is healthy. After failure use xiaoshe_runtime_info; do not install packages, change global configuration or invoke npx to diagnose an ordinary reading task.'
const currentFailureGuidance = 'Xiaoshe task-focused vision: focus the prompt on the user question instead of requesting unrelated transcription. Registration does not prove the engine is healthy. Only when the cause of a failure is unclear, query xiaoshe_runtime_info once. If the failure explicitly reports that no provider is configured or the selected model does not support image input, try at most one independent visual route, then state the boundary and continue without looping. Do not install packages, change global configuration or invoke npx to diagnose an ordinary reading task.'
const unsafeFailureGuidance = currentFailureGuidance.replace('the cause of a failure', "a failure's cause")
const cliFixture = prompt => `import { Command } from "commander";
function codexCliRoute(visionModel) { return { buildInvocation: options => {
      const model = options.model || visionModel;
      const args = [
        "exec", "--ephemeral"
      ];
      const prompt = "fixture prompt";
      args.push("--", prompt);
      return { args };
} }; }
function opencodeCliRoute(modelId) { return {}; }
async function runProvider(provider, invocation, backstop) {
      const commandResult = await runCommand(
        provider.name,
        invocation,
        backstop,
        provider.describeFailure
      );
}
function buildVisionPrompt(options) { return ${JSON.stringify(prompt)}; }`
test('patch covers both native and pasted routes and preserves settings opener', () => {
  const next = patchSource(fixture)
  assert.match(next, /exec.signal, cliTimeoutMs/)
  assert.match(next, /return runVisionWithRecovery\(command, args, signal, timeoutMs\)/)
  assert.match(next, /timeoutMs: Math.min\(cliTimeoutMs \* 2, 120_000\) \+ 10_000/)
  assert.match(next, /signal,\n      visionTimeout\(ctx\)/)
  assert.doesNotMatch(next, /\bCLI_TIMEOUT_MS\b/)
  assert.match(next, /import \{ spawnHidden \}/)
  assert.match(next, /cachedEvidence\(ctx, adapter, block, walk, signal, focus, imageScope\)/)
  assert.match(next, /latestVisionQuestion\(exec.agent/)
  assert.match(next, /focus: focus \|\| ""/)
  assert.equal(patchSource(next), next)
  assert.match(next, /createVisionEvidenceScope\(options\)/)
  assert.match(next, /visionEvidenceRequest\(options, messages, visionScope\)/)
  assert.match(next, /createVisionEvidenceBlock\(\{ original: block, stored, run: visionRun/)
  assert.match(next, /scope: visionEvidenceScopeKey\(visionScope\)/)
})
test('migrates partial v1 patch without leaving dangling variables', () => {
  const v1 = fixture.replace('const CLI_TIMEOUT_MS = 180_000', `const DEFAULT_CLI_TIMEOUT_MS = 25000
const MIN_CLI_TIMEOUT_MS = 5000
const MAX_CLI_TIMEOUT_MS = 45000
function resolveCliTimeoutMs(value) {
 return Number(value)
}`)
    .replace('export function apply(ctx, config = {}) {', 'export function apply(ctx, config = {}) {\n  const cliTimeoutMs = resolveCliTimeoutMs(config.timeoutMs)')
    .replace('timeoutMs: CLI_TIMEOUT_MS + 20_000,', 'timeoutMs: cliTimeoutMs + 5_000,')
    .replace('String(CLI_TIMEOUT_MS)', 'String(cliTimeoutMs)')
  assert.equal(patchSource(v1), patchSource(fixture))
})
test('refuses unknown source rather than guessing anchors', () => {
  assert.throws(() => patchSource(fixture.replace('function run(command, args, signal)', 'function changedRunner()')))
  assert.throws(() => patchSource(fixture + '\nconst CLI_TIMEOUT_MS = 180_000'))
  assert.throws(() => patchSource(fixture.replace('yield* ctx.llm.stream({ ...options, provider: upstream, messages })', 'yield* unsafeFallback()')))
  assert.throws(() => patchSource(fixture.replace('        stream(options) {', '        unknownStream(options) {')))
  assert.throws(() => patchSource(fixture + '\n        stream(options) {'))
})

test('upgrades the previously patched adapter and preserves prepared calls idempotently', () => {
  const current = patchSource(fixture)
  const old = current
    .replace(/        \/\/ xiaoshe-prepared-vision-v1[\s\S]*?        stream\(options\) \{/, '        stream(options) {')
    .replace(/            options.signal\?\.throwIfAborted\(\)\n[\s\S]*?            const visionScope/, '            const visionScope')
    .replace('options.signal?.throwIfAborted()\n            yield* prepared.stream({ ...visionEvidenceRequest(options, messages, visionScope), ...prepared.config })',
      'yield* ctx.llm.stream({ ...visionEvidenceRequest(options, messages, visionScope), provider: upstream })')
  assert.equal(patchSource(old), current)
  assert.equal(patchSource(current), current)
  assert.throws(() => patchSource(current.replace('yield* prepared.stream(', 'yield* ctx.llm.stream(')))
  assert.throws(() => patchSource(current + '\n// xiaoshe-prepared-vision-v1'))
  assert.match(current, /imageRequestPricing\(\) \{ return undefined \}/)
  assert(current.indexOf('ctx.llm.prepareCall') < current.indexOf('const converted = await convertImagesToEvidence'))
})
test('Codex bridge override is per invocation and retains the selected model', () => {
  const source = cliFixture('default whole page prompt')
  const patched = patchCliSource(source)
  assert.match(patched, /const model = options.model \|\| visionModel/)
  assert.match(patched, /model_reasoning_effort=/)
  assert.match(patched, /human request defines scope/)
  assert.match(patched, /options.imageSource/)
  assert.match(patched, /return "default whole page prompt"/)
  assert.doesNotMatch(patched, /ignore-user-config|ignore-rules|bypass|writeFile/)
  assert.equal(patchCliSource(patched), patched)
})
test('focused prompt preserves image location and leaves non-Xiaoshe callers unchanged', () => {
  const source = cliFixture('original prompt')
  const patched = patchCliSource(source)
  const promptSource = patched.slice(patched.indexOf('function buildVisionPrompt(options) {'))
  const prompt = (env, input) => runInNewContext(`${promptSource}; buildVisionPrompt(input)`, { process: { env }, input })
  assert.equal(prompt({}, {}), 'original prompt')
  const focused = prompt({ XIAOSHE_VISION_TASK_FOCUS: '1' }, { imageKind: 'local', imageSource: '/test.png', extraPrompt: 'only the selected label' })
  assert.match(focused, /\/test.png/)
  assert.match(focused, /only the selected label/)
  assert.match(focused, /Full-page transcription is needed ONLY/)
  assert.match(prompt({ XIAOSHE_VISION_TASK_FOCUS: '1' }, { imageKind: 'remote', imageSource: 'https://example.test/image.png' }), /https:\/\/example.test\/image.png/)
})
test('an already patched tool no longer promises exhaustive transcription by default', () => {
  const exhaustive = 'Returns structured evidence with every word transcribed (ocr.full_text), layout regions in reading order, semantics, and an uncertainty list; quote the evidence instead of guessing.'
  const next = patchSource(patchSource(fixture) + `\nconst oldText = ${JSON.stringify(exhaustive)}`)
  assert.doesNotMatch(next, /every word transcribed/)
  assert.match(next, /omit unrelated text unless the user requests full transcription/)
})
test('upgrades unconditional failure guidance and remains idempotent', () => {
  const legacyPatched = patchSource(fixture).replace(currentFailureGuidance, oldFailureGuidance)
  assert.match(legacyPatched, /After failure use xiaoshe_runtime_info/)

  const upgraded = patchSource(legacyPatched)
  assert.doesNotMatch(upgraded, /After failure use xiaoshe_runtime_info/)
  assert.match(upgraded, /Only when the cause of a failure is unclear, query xiaoshe_runtime_info once/)
  assert.match(upgraded, /no provider is configured or the selected model does not support image input/)
  assert.match(upgraded, /try at most one independent visual route, then state the boundary and continue without looping/)
  assert.equal(patchSource(upgraded), upgraded)

  const unsafePatched = patchSource(fixture).replace(currentFailureGuidance, unsafeFailureGuidance)
  const repaired = patchSource(unsafePatched)
  assert.doesNotMatch(repaired, /a failure's cause/)
  assert.match(repaired, /Only when the cause of a failure is unclear/)
  assert.equal(patchSource(repaired), repaired)
})

test('patched ModLens source remains valid JavaScript', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-modlens-patch-'))
  const target = join(directory, 'index.mjs')
  try {
    await writeFile(target, patchSource(fixture), 'utf8')
    const checked = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
    assert.equal(checked.status, 0, checked.stderr || checked.stdout)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
