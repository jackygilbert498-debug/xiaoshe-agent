#!/usr/bin/env node
/** Bind macOS acceptance outputs to one fail-closed run without broad cleanup. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu
const FAILURE_CHECKS = Object.freeze({
  actions: Object.freeze(['screen-recording-permission', 'accessibility-permission']),
  signing: Object.freeze(['macos-signing-and-notarization']),
  source: Object.freeze(['release-source-identity']),
  lifecycle: Object.freeze(['macos-app-lifecycle', 'real-desktop-action-loop']),
  install: Object.freeze(['macos-install-uninstall']),
})
export const MACOS_ACCEPTANCE_IMPLEMENTATION_FILES = Object.freeze([
  'scripts/acceptance/macos-desktop.sh',
  'scripts/acceptance/macos-desktop-actions.py',
  'scripts/acceptance/macos-app-lifecycle.mjs',
  'scripts/acceptance/macos-install-uninstall.mjs',
  'scripts/acceptance/macos-signing-gate.mjs',
  'scripts/acceptance/macos-acceptance-run.mjs',
  'scripts/acceptance/generate-macos-report.mjs',
  'scripts/acceptance/verify-report.mjs',
  'scripts/release/macos-source-identity.mjs',
  'scripts/release/sign-notarize-macos.sh',
  'apps/desktop-shell/scripts/verify-artifact.mjs',
  'apps/desktop-shell/src/acceptance-isolation.mjs',
  'apps/desktop-shell/src/browser-page-scripts.mjs',
  'apps/desktop-shell/src/browser-policy.mjs',
  'apps/desktop-shell/src/browser-workspace.mjs',
  'apps/desktop-shell/src/icon-layout.mjs',
  'apps/desktop-shell/src/interaction-acceptance.mjs',
  'apps/desktop-shell/src/lifecycle.mjs',
  'apps/desktop-shell/src/main.mjs',
  'apps/desktop-shell/src/preload.cjs',
  'apps/desktop-shell/src/security-policy.mjs',
  'python/xiaoshe_desktop_bridge.py',
  'runtime/xiaoshe-legacy/harness/imaging.py',
  'runtime/xiaoshe-legacy/harness/observe.py',
  'runtime/xiaoshe-legacy/harness/platform_caps.py',
  'runtime/xiaoshe-legacy/harness/viewport.py',
  'scripts/acceptance/fixtures/XiaosheDesktopActionFixture.swift',
])

/** Content identity for the local acceptance implementation; this is not a signature or remote attestation. */
export async function macosAcceptanceImplementationSha256(root) {
  const digest = createHash('sha256')
  for (const path of MACOS_ACCEPTANCE_IMPLEMENTATION_FILES) {
    digest.update(path).update('\0').update(await readFile(resolve(root, path))).update('\0')
  }
  return digest.digest('hex')
}

function canonicalTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`)
  return date.toISOString()
}

function normalizedContext(runId, runStartedAt) {
  if (!UUID_PATTERN.test(runId ?? '')) throw new Error('macOS acceptance run identity is invalid')
  const started = canonicalTimestamp(runStartedAt, 'macOS acceptance run start')
  return Object.freeze({ runId, runStartedAt: started })
}

export function validateMacosAcceptanceRunContext(context) {
  return normalizedContext(context?.runId, context?.runStartedAt)
}

/** Remove only explicitly named report files, rejecting directories before deletion. */
export async function beginMacosAcceptanceRun(paths, options = {}) {
  const outputs = [...new Set(paths.map(path => resolve(path)))]
  for (const output of outputs) {
    try {
      const info = await lstat(output)
      if (info.isDirectory() && !info.isSymbolicLink()) {
        throw new Error(`refusing to invalidate report directory: ${output}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  for (const output of outputs) await rm(output, { force: true })
  const now = (options.now ?? (() => new Date()))()
  const runStartedAt = new Date(Math.floor(now.getTime() / 1_000) * 1_000).toISOString()
  return normalizedContext((options.uuid ?? randomUUID)(), runStartedAt)
}

/** Add current-run metadata to independently written component reports. */
export function acceptanceRunMetadataFromEnvironment(environment = process.env) {
  const runId = environment.XIAOSHE_ACCEPTANCE_RUN_ID?.trim()
  const runStartedAt = environment.XIAOSHE_ACCEPTANCE_RUN_STARTED_AT?.trim()
  if (!runId && !runStartedAt) return Object.freeze({})
  if (!runId || !runStartedAt) throw new Error('macOS acceptance run metadata is incomplete')
  return normalizedContext(runId, runStartedAt)
}

/** Reject a component from another run or one generated before this run began. */
export function assertCurrentMacosAcceptanceReport(report, context, label, now = new Date()) {
  const expected = normalizedContext(context.runId, context.runStartedAt)
  if (report?.runId !== expected.runId || report?.runStartedAt !== expected.runStartedAt) {
    throw new Error(`${label} report run identity does not match the current acceptance run`)
  }
  const generatedAt = canonicalTimestamp(report.generatedAt, `${label} report generation time`)
  const generatedMs = Date.parse(generatedAt)
  const startedMs = Date.parse(expected.runStartedAt)
  if (generatedMs < startedMs || generatedMs > now.getTime() + 5 * 60_000) {
    throw new Error(`${label} report is not fresh for the current acceptance run`)
  }
}

/**
 * Ensure a failed subprocess still leaves an honest current-run component
 * report. Existing complete reports are preserved; missing or malformed
 * output is replaced only with content-free failure facts.
 */
export async function ensureMacosComponentFailureReport(output, component, context, options = {}) {
  const expectedIds = FAILURE_CHECKS[component]
  if (expectedIds === undefined) throw new Error('unknown macOS acceptance component')
  const runContext = validateMacosAcceptanceRunContext(context)
  const now = (options.now ?? (() => new Date()))()
  try {
    const current = JSON.parse(await readFile(resolve(output), 'utf8'))
    assertCurrentMacosAcceptanceReport(current, runContext, component, now)
    const ids = new Set(Array.isArray(current?.checks) ? current.checks.map(check => check?.id) : [])
    if (current?.schemaVersion === 1 && current.platform === 'macos'
        && expectedIds.every(id => ids.has(id))
        && current.checks.some(check => check?.state === 'fail')) return false
  } catch {
    // A failed component cannot trust partial or malformed output as evidence.
  }
  const report = {
    schemaVersion: 1,
    platform: 'macos',
    generatedAt: now.toISOString(),
    ...runContext,
    checks: expectedIds.map(id => ({
      id,
      state: 'fail',
      detail: '验收组件未生成可验证的当前运行报告。',
      evidence: { componentReport: 'missing-or-invalid', component },
    })),
  }
  const destination = resolve(output)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return true
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...values] = process.argv.slice(2)
  if (command === 'begin' && values.length > 0) {
    const context = await beginMacosAcceptanceRun(values)
    process.stdout.write(`${context.runId}|${context.runStartedAt}\n`)
  } else if (command === 'ensure-failure' && values.length === 2) {
    await ensureMacosComponentFailureReport(values[1], values[0], acceptanceRunMetadataFromEnvironment())
  } else {
    throw new Error('usage: macos-acceptance-run.mjs begin <report-path>... | ensure-failure <component> <report-path>')
  }
}
