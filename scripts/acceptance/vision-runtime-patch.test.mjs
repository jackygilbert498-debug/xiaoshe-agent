import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { patchVisionRuntime } from './vision-runtime-patch.mjs'
import { CODEX_VISION_PREFIX } from './vision-engine-runtime.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
// Source-shaped fixture tests the pinned rewrite without requiring an installed
// provider, reading any Profile config, or executing an engine/CLI entry point.
const fixture = `import { Command } from "commander";
function buildVisionPrompt(options) { return "old prompt"; }
function codexCliRoute(visionModel) {
  return { buildInvocation: options => {
      const model = options.model || visionModel;
      const args = [
        "exec",
        "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--json", "-i", options.imageSource
      ];
      if (model && model !== "default") { args.push("-m", model); }
      const prompt = "prompt";
      args.push("--", prompt);
      return {
        command: options.providerBin || "codex",
        args
      };
  } };
}
function opencodeCliRoute(modelId) { return {}; }
async function analyzeImage(options) {
  const resolvedInput = { kind: "local" };
  const config2 = options.config ?? loadConfigFile();
  const chain = options.provider ? [resolveProvider(options.provider)] : options.providerBin ? [resolveProvider("antigravity-cli")] : composeChain(resolvedInput.kind, config2, options.autoOptions);
  if (chain.length === 1) {
      const hint = reuseHint(config2, options.autoOptions);
  }
}
async function runProvider(provider, model, options) {
  const config2 = {};
  const configured = resolveProviderSettings(provider.name, config2);
      const commandResult = await runCommand(
        provider.name,
        invocation,
        backstop,
        provider.describeFailure
      );
}
async function removeWorkdir(workdir) { try {} catch {} }
async function isolateImage(source) { return fs.mkdtempSync(path.join(os.tmpdir(), "modlens-work-")); }
function emptyWorkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "modlens-work-")); }
function runCommand(providerName, invocation, timeoutMs, describeFailure) { throw new Error("old unbounded dispatcher"); }
const HARNESS_BY_BASENAME = {};
const program = new Command();
program.command("doctor");
program.command("config");
program.command("recover-paste");
await program.parseAsync(process.argv, { from: "node" });
`
const config = { runId: 'test-run', sessionId: 'test-session', acceptanceRoot: '/isolated/run', ledgerDirectory: '/isolated/run/engine',
  workDirectory: '/isolated/run/work', isolatedHome: '/isolated/run/home', authHome: '/existing/auth-reference',
  executable: '/pinned/codex', executableSha256: '1'.repeat(64), model: 'vision-model', imageSha256: '2'.repeat(64),
  outputSchemaPath: '/isolated/run/installed-schema.json', outputSchemaSha256: '3'.repeat(64) }
const argumentsFor = source => ({ source, version: '3.22.0', expectedSourceSha256: hash(source),
  engineModuleUrl: new URL('./vision-engine-runtime.mjs', import.meta.url).href, config })

test('pinned transform admits one real Codex route and removes all alternate CLI entry points', async t => {
  const result = patchVisionRuntime(argumentsFor(fixture))
  assert.equal(result.sourceSha256, hash(result.source)); assert.equal(result.upstreamSourceSha256, hash(fixture))
  assert.equal(result.maxEngineLaunches, 1); assert.equal(result.monetaryHardCap, false); assert.equal(result.internalRequestCap, null)
  assert.ok(result.source.includes(JSON.stringify(CODEX_VISION_PREFIX)))
  assert.ok(result.source.includes('const chain = [codexCliRoute(acceptanceVision.config.model)]'))
  assert.ok(result.source.includes('return acceptanceVision.runCommand(providerName, invocation, timeoutMs)'))
  assert.ok(!result.source.includes('old unbounded dispatcher'))
  for (const entry of ['program.command("doctor")', 'program.command("config")', 'program.command("recover-paste")', 'const config2 = options.config ?? loadConfigFile();']) assert.ok(!result.source.includes(entry))
  assert.ok(!result.source.includes('options.providerBin || "codex"'))
  assert.ok(result.source.includes('args.push("--output-schema", xiaosheCodexOutputSchema().path)'))
  assert.ok(result.source.includes('withCodexOutputSchema(provider.name, invocation, xiaosheCodexOutputSchema'))
  assert.ok(!result.source.includes('fs.mkdtempSync(path.join(os.tmpdir(), "modlens-work-"))'))
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xs-vision-patch-test-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'syntax-only.mjs'); await writeFile(path, result.source)
  const syntax = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', timeout: 5000 })
  assert.equal(syntax.status, 0, syntax.stderr)
})
test('version/hash/anchor/entry drift and remote imports fail closed instead of guessing a patch', () => {
  const args = argumentsFor(fixture)
  for (const change of [{ version: '3.23.0' }, { expectedSourceSha256: '0'.repeat(64) },
    { engineModuleUrl: 'https://example.invalid/runtime.mjs' }, { engineModuleUrl: args.engineModuleUrl + '?changed' },
    { config: { ...config, authHome: '/isolated/run/auth' } }]) assert.throws(() => patchVisionRuntime({ ...args, ...change }))
  for (const source of [fixture.replace('const chain =', 'const changed ='), fixture.replace('const program = new Command();', 'const program = new Command2();'),
    fixture.replace('function runCommand(', 'function renamedCommand(')]) assert.throws(() => patchVisionRuntime(argumentsFor(source)))
  const result = patchVisionRuntime(args)
  assert.throws(() => patchVisionRuntime(argumentsFor(result.source)), /untrusted_source/)
})
test('current public ModLens source also matches every pinned anchor and parses; never executes it', async t => {
  let source
  try { source = await readFile('/Users/zfy/.dsh/profiles/web/node_modules/@liustack/modlens/dist/main.js', 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return t.skip('public package is not installed; portable source fixture still runs'); throw error }
  const result = patchVisionRuntime(argumentsFor(source))
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xs-vision-public-patch-test-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'syntax-only.mjs'); await writeFile(path, result.source)
  const syntax = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', timeout: 5000 })
  assert.equal(syntax.status, 0, syntax.stderr)
  assert.ok(result.source.includes('command: acceptanceVision.config.executable'))
})
