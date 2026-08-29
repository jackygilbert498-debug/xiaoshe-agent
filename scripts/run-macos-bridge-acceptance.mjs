#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BridgeClient, BridgeRpcError, resolveConfig } from '../dist/index.js'

if (process.platform !== 'darwin') throw new Error('macOS bridge acceptance can run only on darwin')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputArg = process.argv.indexOf('--output')
const outputPath = resolve(outputArg >= 0
  ? process.argv[outputArg + 1]
  : 'docs/evidence/native-shell-phase-7/macos-desktop-action-report.json')
const xiaosheRoot = resolve(process.env.XIAOSHE_LEGACY_ROOT ?? resolve(root, 'runtime/xiaoshe-legacy'))
const pythonExecutable = process.env.XIAOSHE_PYTHON
const dialogTitle = '小蛇 Phase 7 安全验收'
const buttonName = 'XIAOSHE_SAFE_BUTTON'
const targetProcessName = `xiaoshe-safe-action-target-${process.pid}`
const actionResultPath = join(root, 'docs', 'evidence', 'native-shell-phase-7', 'macos-desktop-action-result.txt')
const execFileAsync = promisify(execFile)

function config(actionsEnabled) {
  return resolveConfig({ xiaosheRoot, pythonExecutable, actionsEnabled, requestTimeoutMs: 60_000 })
}

function record(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Bridge returned a non-object')
  return value
}

function observation(value) {
  const result = record(value)
  if (typeof result.viewport_id !== 'string' || !Array.isArray(result.elements)) throw new Error('Invalid observation')
  return result
}

function onlyElement(view, name) {
  const matches = view.elements.filter(element => element?.name === name)
  if (matches.length !== 1 || typeof matches[0].id !== 'string') {
    throw new Error(`Expected one isolated ${name} element, received ${matches.length}`)
  }
  return matches[0]
}

function startDialog(executable) {
  const child = spawn(executable, [actionResultPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const settled = new Promise((resolveChild, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveChild({ code, signal, stdout, stderr }))
  })
  return { child, settled }
}

async function activateTarget() {
  const frontQuery = 'tell application "System Events" to get name of first application process whose frontmost is true'
  const source = `tell application "System Events" to set frontmost of application process "${targetProcessName}" to true`
  let lastError
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const current = await execFileAsync('/usr/bin/osascript', ['-e', frontQuery])
      if (current.stdout.trim() === targetProcessName) return
      await execFileAsync('/usr/bin/osascript', ['-e', source])
      const after = await execFileAsync('/usr/bin/osascript', ['-e', frontQuery])
      if (after.stdout.trim() === targetProcessName) return
      lastError = new Error(`Safe target did not become frontmost on attempt ${attempt + 1}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw lastError ?? new Error('Safe target could not be activated')
}

async function observeDialog(client) {
  let last
  let priorStableCandidate
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await activateTarget()
    try {
      last = observation(await client.request('observe', { include_elements: true, max_elements: 60 }, new AbortController().signal))
    } catch (error) {
      if (!(error instanceof BridgeRpcError) || error.rpcData?.kind !== 'SCREEN_CAPTURE_FAILED') throw error
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
      continue
    }
    const hasTarget = last.elements.some(element => element?.name === buttonName)
    const fingerprint = hasTarget ? `${last.sha256}:${JSON.stringify(last.elements)}` : undefined
    if (fingerprint !== undefined && fingerprint === priorStableCandidate?.fingerprint) return last
    priorStableCandidate = fingerprint === undefined ? undefined : { fingerprint }
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw new Error(`Safe dialog did not become stable and observable; last elements: ${JSON.stringify(last?.elements ?? [])}`)
}

function summarizeObservation(view) {
  return {
    viewportId: view.viewport_id,
    sha256: view.sha256,
    pixelSize: view.pixel_size,
    logicalSize: view.logical_size,
    scale: view.scale,
    elementCount: view.elements.length,
    warningCount: Array.isArray(view.warnings) ? view.warnings.length : -1,
  }
}

function summarizeAction(result) {
  return {
    status: result.status,
    action: result.action,
    changed: result.changed,
    target: result.target,
    message: result.message,
    beforeViewportId: result.before_viewport_id,
    afterViewportId: result.after?.viewport_id,
  }
}

await rm(actionResultPath, { force: true })
const targetBuildDir = await mkdtemp(join(tmpdir(), 'xiaoshe-macos-target-'))
const targetExecutable = join(targetBuildDir, targetProcessName)
await execFileAsync('/usr/bin/swiftc', ['-suppress-warnings', join(root, 'scripts', 'macos-safe-action-target.swift'), '-o', targetExecutable])
const dialog = startDialog(targetExecutable)
const enabled = new BridgeClient(config(true))
let report
try {
  await new Promise(resolveWait => setTimeout(resolveWait, 500))
  const health = record(await enabled.request('health', {}, new AbortController().signal))
  const before = await observeDialog(enabled)
  let reviewed = before
  let target = onlyElement(reviewed, buttonName)
  let imageX
  let imageY
  let clicked
  for (let attempt = 0; attempt < 8; attempt += 1) {
    imageX = Math.round((target.x - reviewed.origin.x + target.w / 2) * reviewed.scale)
    imageY = Math.round((target.y - reviewed.origin.y + target.h / 2) * reviewed.scale)
    clicked = record(await enabled.request(
      'click',
      { viewport_id: reviewed.viewport_id, element_id: target.id },
      new AbortController().signal,
    ))
    if (clicked.status !== 'stale') break
    if (!clicked.after.elements.some(element => element?.name === buttonName)) {
      await activateTarget()
      reviewed = await observeDialog(enabled)
    } else {
      reviewed = observation(clicked.after)
    }
    target = onlyElement(reviewed, buttonName)
  }
  if (clicked.status !== 'completed') throw new Error(`Safe click failed: ${JSON.stringify(clicked)}`)
  let actionResult
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      actionResult = await readFile(actionResultPath, 'utf8')
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
  }
  if (actionResult !== 'XS_PHASE7_MACOS_ACTION_OK\n') throw new Error('safe target result did not match')
  report = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    platform: process.platform,
    isolatedTarget: {
      title: dialogTitle,
      processName: targetProcessName,
      elementName: buttonName,
      elementId: target.id,
      reviewedLogicalBounds: { x: target.x, y: target.y, width: target.w, height: target.h },
      derivedImagePoint: { x: imageX, y: imageY },
    },
    bridgeHealth: health,
    observation: summarizeObservation(reviewed),
    action: summarizeAction(clicked),
    targetResult: { bytes: Buffer.byteLength(actionResult), exactMatch: true },
    assertions: {
      realScreenshotCaptured: typeof before.image_path === 'string',
      accessibilityElementResolved: true,
      safeCoordinateClickCompleted: true,
      postActionVerificationCaptured: typeof clicked.after?.viewport_id === 'string',
      targetBusinessStateWitnessed: true,
    },
  }
} finally {
  await enabled.dispose()
  if (dialog.child.exitCode === null) {
    dialog.child.kill('SIGTERM')
    await Promise.race([dialog.settled, new Promise(resolveWait => setTimeout(resolveWait, 2_000))])
  }
  await rm(targetBuildDir, { recursive: true, force: true })
}

const disabled = new BridgeClient(config(false))
try {
  let rpcData
  try {
    await disabled.request('click', { viewport_id: 'must-not-execute', image_x: 0, image_y: 0 }, new AbortController().signal)
    throw new Error('Disabled Bridge accepted an action')
  } catch (error) {
    if (!(error instanceof BridgeRpcError)) throw error
    rpcData = error.rpcData
  }
  report.actionsDisabled = { rejected: true, rpcData }
  report.assertions.actionsDisabledFailClosed = true
} finally {
  await disabled.dispose()
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
