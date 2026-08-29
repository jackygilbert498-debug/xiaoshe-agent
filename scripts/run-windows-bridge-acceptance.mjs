import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BridgeClient, BridgeRpcError, resolveConfig } from '../dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputArg = process.argv.indexOf('--output')
const outputPath = resolve(outputArg >= 0 ? process.argv[outputArg + 1] : 'docs/evidence/2026-08-22-windows-screen-validation.json')
const windowPidArg = process.argv.indexOf('--window-pid')
const windowPid = Number(windowPidArg >= 0 ? process.argv[windowPidArg + 1] : Number.NaN)
if (!Number.isSafeInteger(windowPid) || windowPid <= 0) throw new Error('--window-pid must identify the isolated acceptance process')
const xiaosheRoot = resolve(process.env.XIAOSHE_LEGACY_ROOT ?? resolve(root, 'runtime/xiaoshe-legacy'))
const pythonExecutable = process.env.XIAOSHE_PYTHON
const execFileAsync = promisify(execFile)

async function focusAcceptanceWindow() {
  const script = `Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes; Add-Type @'\nusing System; using System.Runtime.InteropServices; public static class F { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }\n'@; $p=Get-Process -Id ${windowPid} -ErrorAction Stop; if($p.MainWindowTitle -ne 'Xiaoshe Windows Acceptance'){throw 'Unexpected acceptance title'}; $shell=New-Object -ComObject WScript.Shell; $shell.AppActivate($p.Id) | Out-Null; [F]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; $pc=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,${windowPid}); $w=[System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,$pc); $ac=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'XIAOSHE_SAFE_BUTTON'); $b=$w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$ac); $b.SetFocus(); Start-Sleep -Milliseconds 200; if([System.Windows.Automation.AutomationElement]::FocusedElement.Current.ProcessId -ne ${windowPid}){throw 'Acceptance control is not focused'}`
  await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true })
}

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

function action(value, expectedStatus = 'completed') {
  const result = record(value)
  if (result.status !== expectedStatus) {
    throw new Error(`Expected action status ${expectedStatus}, received ${String(result.status)}: ${String(result.message)}`)
  }
  return result
}

function onlyElement(view, name) {
  const matches = view.elements.filter(element => element?.name === name)
  if (matches.length !== 1 || typeof matches[0].id !== 'string') {
    throw new Error(`Expected one isolated ${name} element, received ${matches.length}`)
  }
  return matches[0]
}

function summary(view) {
  return {
    viewportId: view.viewport_id,
    sha256: view.sha256,
    pixelSize: view.pixel_size,
    logicalSize: view.logical_size,
    scale: view.scale,
    warningCount: Array.isArray(view.warnings) ? view.warnings.length : -1,
  }
}

function actionSummary(result) {
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

const enabled = new BridgeClient(config(true))
let evidence
try {
  await focusAcceptanceWindow()
  const health = record(await enabled.request('health', {}, new AbortController().signal))
  const first = observation(await enabled.request(
    'observe',
    { include_elements: true, max_elements: 60 },
    new AbortController().signal,
  ))
  const windowMarker = onlyElement(first, 'Xiaoshe Windows Safe Acceptance')
  const clickTarget = onlyElement(first, 'XIAOSHE_SAFE_BUTTON')
  onlyElement(first, 'XIAOSHE_FOCUS_INPUT')
  onlyElement(first, 'XIAOSHE_SAFE_INPUT')
  onlyElement(first, 'XIAOSHE_SAFE_STATUS')

  const clicked = action(await enabled.request(
    'click',
    { viewport_id: first.viewport_id, element_id: clickTarget.id },
    new AbortController().signal,
  ))

  const stale = action(await enabled.request(
    'press',
    { viewport_id: first.viewport_id, keys: '{ESC}' },
    new AbortController().signal,
  ), 'stale')

  const afterClick = observation(clicked.after)
  const currentFocusTarget = onlyElement(afterClick, 'XIAOSHE_FOCUS_INPUT')
  const focused = action(await enabled.request(
    'click',
    { viewport_id: afterClick.viewport_id, element_id: currentFocusTarget.id },
    new AbortController().signal,
  ))

  const typed = action(await enabled.request(
    'type_text',
    { viewport_id: focused.after.viewport_id, text: '\u5c0f\u86c7 Windows \u9a8c\u6536' },
    new AbortController().signal,
  ))
  const pressed = action(await enabled.request(
    'press',
    { viewport_id: typed.after.viewport_id, keys: '{ENTER}' },
    new AbortController().signal,
  ))
  const listed = record(await enabled.request(
    'list_windows',
    { max_windows: 40 },
    new AbortController().signal,
  ))
  if (!Array.isArray(listed.windows)) throw new Error('Window list response is invalid')
  const focusMatches = listed.windows.filter(item => item?.title === 'Xiaoshe Windows Acceptance')
  if (focusMatches.length !== 1 || typeof focusMatches[0].id !== 'string') {
    throw new Error(`Expected one exact acceptance window target, received ${focusMatches.length}`)
  }
  const focusedWindow = action(await enabled.request(
    'focus_window',
    { window_id: focusMatches[0].id, title: focusMatches[0].title },
    new AbortController().signal,
  ))

  evidence = {
    schema: 1,
    executedAt: new Date().toISOString(),
    platform: process.platform,
    isolatedWindow: {
      title: 'Xiaoshe Windows Acceptance',
      marker: windowMarker.name,
      elementId: windowMarker.id,
      automationIds: ['XIAOSHE_SAFE_BUTTON', 'XIAOSHE_FOCUS_INPUT', 'XIAOSHE_SAFE_INPUT', 'XIAOSHE_SAFE_STATUS'],
    },
    bridgeHealth: health,
    observation: summary(first),
    actions: {
      click: actionSummary(clicked),
      staleGuard: actionSummary(stale),
      focusInput: actionSummary(focused),
      typeChinese: actionSummary(typed),
      pressEnter: actionSummary(pressed),
      focusWindow: actionSummary(focusedWindow),
    },
    assertions: {
      isolatedControlsResolved: true,
      clickCompleted: true,
      oldViewportRejectedWithoutInput: true,
      focusCompleted: true,
      chineseTypeCompleted: true,
      enterCompleted: true,
      exactWindowFocusCompleted: true,
    },
  }
} finally {
  await enabled.dispose()
}

const disabled = new BridgeClient(config(false))
try {
  let disabledCode
  try {
    await disabled.request(
      'click',
      { viewport_id: 'must-not-execute', image_x: 0, image_y: 0 },
      new AbortController().signal,
    )
    throw new Error('Disabled Bridge accepted an action')
  } catch (error) {
    if (!(error instanceof BridgeRpcError)) throw error
    disabledCode = error.rpcData
  }
  evidence.actionsDisabled = { rejected: true, rpcData: disabledCode }
  evidence.assertions.actionsDisabledFailClosed = true
} finally {
  await disabled.dispose()
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
