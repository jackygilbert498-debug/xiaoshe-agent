/** Pure acceptance-only transform of a caller-pinned ModLens 3.22.0 public CLI.
 * Does not install, copy credentials, launch a CLI or modify a daily Profile. */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { patchCliSource } from '../patch-modlens-runtime.mjs'
import { CODEX_VISION_PREFIX, validateVisionEngineConfig } from './vision-engine-runtime.mjs'

const fail = code => new Error(`vision-runtime-patch: ${code}`)
const hash = value => createHash('sha256').update(value).digest('hex')
function once(source, from, to) {
  if (source.split(from).length !== 2) throw fail('pinned_anchor_changed')
  return source.replace(from, to)
}
function section(source, start, end, replacement) {
  if (source.split(start).length !== 2 || source.split(end).length !== 2) throw fail('pinned_section_changed')
  const from = source.indexOf(start), to = source.indexOf(end, from)
  if (to < from) throw fail('pinned_section_changed')
  return source.slice(0, from) + replacement + source.slice(to)
}

export function patchVisionRuntime({ source, version, expectedSourceSha256, engineModuleUrl, config }) {
  validateVisionEngineConfig(config)
  if (version !== '3.22.0' || typeof source !== 'string' || hash(source) !== expectedSourceSha256
    || source.includes('xiaoshe-pinned-vision-acceptance-v1')) throw fail('untrusted_source')
  let url
  try { url = new URL(engineModuleUrl); fileURLToPath(url) } catch { throw fail('invalid_engine_module') }
  if (url.protocol !== 'file:' || url.host || url.search || url.hash) throw fail('invalid_engine_module')
  let result = patchCliSource(source)
  result = once(result, 'import { Command } from "commander";', `import { Command } from "commander";
import { createVisionEngineRuntime } from ${JSON.stringify(url.href)};
// xiaoshe-pinned-vision-acceptance-v1: no discovery, provider fallback or config commands.
const acceptanceVision = createVisionEngineRuntime(${JSON.stringify(config)});`)
  result = once(result, '  const config2 = options.config ?? loadConfigFile();', '  const config2 = {};')
  result = once(result,
    '  const chain = options.provider ? [resolveProvider(options.provider)] : options.providerBin ? [resolveProvider("antigravity-cli")] : composeChain(resolvedInput.kind, config2, options.autoOptions);',
    `  if (resolvedInput.kind !== "local" || options.provider || options.providerBin || options.workdir || options.extraBody || options.autoOptions
      || options.model && options.model !== acceptanceVision.config.model) throw new Error("acceptance_vision_route_not_allowed");
  options = { ...options, model: acceptanceVision.config.model };
  const chain = [codexCliRoute(acceptanceVision.config.model)];`)
  result = once(result, '      const hint = reuseHint(config2, options.autoOptions);', '      const hint = ""; // No auth/config discovery after engine failure.')
  result = once(result, '  const configured = resolveProviderSettings(provider.name, config2);', '  const configured = {};')
  result = once(result, '        command: options.providerBin || "codex",', '        command: acceptanceVision.config.executable,')
  const codexStart = result.indexOf('function codexCliRoute(visionModel) {'), codexEnd = result.indexOf('function opencodeCliRoute(modelId) {', codexStart)
  if (codexStart < 0 || codexEnd < codexStart) throw fail('pinned_codex_route_changed')
  const codexRoute = result.slice(codexStart, codexEnd)
  const pinnedRoute = section(codexRoute, '      const effort = process.env.XIAOSHE_MODLENS_CODEX_EFFORT;', '      if (model && model !== "default") {',
    `      const args = [...${JSON.stringify(CODEX_VISION_PREFIX)}, options.imageSource];\n`)
  result = once(result, codexRoute, pinnedRoute)
  const temporaryRoot = 'fs.mkdtempSync(path.join(os.tmpdir(), "modlens-work-"))'
  if (result.split(temporaryRoot).length !== 3) throw fail('pinned_temp_roots_changed')
  result = result.replaceAll(temporaryRoot, 'fs.mkdtempSync(path.join(acceptanceVision.config.workDirectory, "modlens-work-"))')
  result = section(result, 'async function removeWorkdir(workdir) {', 'async function isolateImage(source) {',
    `async function removeWorkdir(workdir) {
  const rel = path.relative(acceptanceVision.config.workDirectory, workdir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || fs.realpathSync(workdir) !== workdir) throw new Error("acceptance_workdir_identity_changed");
  await fs.promises.rm(workdir, { recursive: true, force: false });
}
`)
  result = section(result, 'function runCommand(providerName, invocation, timeoutMs, describeFailure) {', 'const HARNESS_BY_BASENAME = {',
    `function runCommand(providerName, invocation, timeoutMs, describeFailure) {
  return acceptanceVision.runCommand(providerName, invocation, timeoutMs);
}
`)
  const tail = 'const program = new Command();'
  if (result.split(tail).length !== 2 || !result.endsWith('await program.parseAsync(process.argv, { from: "node" });\n')) throw fail('pinned_entry_changed')
  // Only the real DSH image-tool argv is admitted. No doctor/config/recover-paste
  // entry survives; neither credentials nor local session files are inspected.
  result = result.slice(0, result.indexOf(tail)) + `${tail}
program.name("modlens-acceptance").requiredOption("-i, --input <path>", "Synthetic local image")
  .option("--prompt <text>", "Task focus").option("--timeout <ms>", "Bounded deadline", "60000")
  .action(async options => {
    try {
      await acceptanceVision.ready;
      if (!/^\\d+$/.test(options.timeout)) throw new Error("invalid_timeout");
      const timeoutMs = Number(options.timeout);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("invalid_timeout");
      const result = await analyzeImage({ input: options.input, prompt: options.prompt, timeoutMs });
      process.stdout.write(JSON.stringify(result) + "\\n");
    } catch (error) {
      // Avoid forwarding CLI/provider diagnostics that might contain credentials.
      process.stderr.write("Error: acceptance_vision_failed\\n");
      process.exitCode = 1;
    }
  });
await program.parseAsync(process.argv, { from: "node" });
`
  return { source: result, sourceSha256: hash(result), upstreamSourceSha256: expectedSourceSha256,
    version, provider: 'codex-cli', model: config.model, maxEngineLaunches: 1, monetaryHardCap: false, internalRequestCap: null }
}
