#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BridgeClient, BridgeRpcError, resolveConfig } from '../dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidenceDir = join(root, 'docs', 'evidence', 'native-shell-phase-7')
const reportPath = join(evidenceDir, 'macos-multidisplay-safety-report.json')
const resultPath = join(evidenceDir, 'macos-secondary-display-must-not-click.txt')
const targetName = `xiaoshe-secondary-target-${process.pid}`
const buttonName = 'XIAOSHE_SAFE_BUTTON'
const execFileAsync = promisify(execFile)
const xiaosheRoot = resolve(process.env.XIAOSHE_LEGACY_ROOT ?? join(root, 'runtime/xiaoshe-legacy'))

async function activateTarget() {
  const frontQuery = 'tell application "System Events" to get name of first application process whose frontmost is true'
  const activate = `tell application "System Events" to set frontmost of application process "${targetName}" to true`
  let lastError
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const current = await execFileAsync('/usr/bin/osascript', ['-e', frontQuery])
      if (current.stdout.trim() === targetName) return
      await execFileAsync('/usr/bin/osascript', ['-e', activate])
      const after = await execFileAsync('/usr/bin/osascript', ['-e', frontQuery])
      if (after.stdout.trim() === targetName) return
      lastError = new Error(`secondary target did not become frontmost on attempt ${attempt + 1}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw lastError ?? new Error('secondary target could not be activated')
}

const screenProbe = await execFileAsync('/usr/bin/swift', ['-e', 'import AppKit; print(NSScreen.screens.count)'])
const screenCount = Number(screenProbe.stdout.trim())
if (!Number.isSafeInteger(screenCount) || screenCount < 2) throw new Error(`multi-display acceptance requires at least two screens; received ${screenCount}`)

await rm(resultPath, { force: true })
const buildDir = await mkdtemp(join(tmpdir(), 'xiaoshe-secondary-target-'))
const executable = join(buildDir, targetName)
await execFileAsync('/usr/bin/swiftc', ['-suppress-warnings', join(root, 'scripts', 'macos-safe-action-target.swift'), '-o', executable])
const target = spawn(executable, [resultPath, '1'], { stdio: ['ignore', 'pipe', 'pipe'] })
const settled = new Promise((resolveChild, reject) => {
  target.once('error', reject)
  target.once('exit', (code, signal) => resolveChild({ code, signal }))
})
const bridge = new BridgeClient(resolveConfig({ xiaosheRoot, actionsEnabled: true, requestTimeoutMs: 60_000 }))
let report
try {
  await new Promise(resolveWait => setTimeout(resolveWait, 700))
  let observed
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await activateTarget()
    try {
      observed = await bridge.request('observe', { include_elements: true, max_elements: 60 }, new AbortController().signal)
    } catch (error) {
      if (!(error instanceof BridgeRpcError) || error.rpcData?.kind !== 'SCREEN_CAPTURE_FAILED') throw error
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
      continue
    }
    if (observed.elements.every(element => element?.name !== buttonName)
      && observed.warnings.some(message => message.includes('outside the captured primary screen'))) break
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  if (observed === undefined || observed.elements.some(element => element?.name === buttonName)) {
    throw new Error('secondary-display target leaked into the executable primary-screen element table')
  }
  if (!observed.warnings.some(message => message.includes('outside the captured primary screen'))) {
    throw new Error(`secondary-display filtering warning is missing: ${JSON.stringify(observed.warnings)}`)
  }

  const missingElement = await bridge.request('click', {
    viewport_id: observed.viewport_id,
    element_id: 'secondary-display-target-must-not-resolve',
  }, new AbortController().signal)
  if (missingElement.status !== 'stale') throw new Error(`unknown filtered element did not fail closed: ${JSON.stringify(missingElement)}`)

  let coordinateKind
  try {
    await bridge.request('click', {
      viewport_id: observed.viewport_id,
      image_x: observed.pixel_size.width,
      image_y: 0,
    }, new AbortController().signal)
    throw new Error('out-of-primary coordinate was accepted')
  } catch (error) {
    if (!(error instanceof BridgeRpcError)) throw error
    coordinateKind = error.rpcData?.kind
    if (coordinateKind !== 'INVALID_PARAMS') throw error
  }
  let resultCreated = true
  try { await access(resultPath) } catch { resultCreated = false }
  if (resultCreated) throw new Error(`secondary-display target was unexpectedly clicked: ${await readFile(resultPath, 'utf8')}`)

  report = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    platform: process.platform,
    screenCount,
    capturedPrimary: { pixelSize: observed.pixel_size, logicalSize: observed.logical_size, origin: observed.origin },
    secondaryTarget: { screenIndex: 1, elementName: buttonName, visibleInPrimaryElementTable: false },
    warningCount: observed.warnings.length,
    warnings: observed.warnings,
    filteredElementAction: { status: missingElement.status, noActionSent: true },
    outOfPrimaryCoordinate: { rejected: true, kind: coordinateKind },
    targetBusinessStateWitnessed: false,
    assertions: {
      twoRealScreensPresent: true,
      secondaryElementsFiltered: true,
      filteredElementFailsClosed: true,
      outOfPrimaryCoordinateRejected: true,
      noSecondaryBusinessAction: true,
    },
  }
} finally {
  await bridge.dispose()
  if (target.exitCode === null) {
    target.kill('SIGTERM')
    await Promise.race([settled, new Promise(resolveWait => setTimeout(resolveWait, 2_000))])
  }
  await rm(buildDir, { recursive: true, force: true })
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
