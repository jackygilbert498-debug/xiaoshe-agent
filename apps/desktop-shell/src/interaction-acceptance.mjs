import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { validateDesktopLoginUrl, redactDesktopLogin } from './desktop-login.mjs'

const MODE_FLAG = '--acceptance-interaction'
const DOM_TIMEOUT_MS = 20_000
const EXTERNAL_ACTION_TIMEOUT_MS = 100_000
const PRODUCT_BUNDLE_ID = 'com.xiaoshe.desktop'

export function interactionAcceptanceRequested(argv, environment) {
  return environment.XIAOSHE_DESKTOP_ACCEPTANCE === '1' && argv.includes(MODE_FLAG)
}

let acceptanceTransport
let clientsByFetcher = new WeakMap()

/** Explicit test-mode setup; the packaged shell imports the adapter from its verified product root. */
export function configureAcceptanceRpc({ ApiClient, authenticatedUrl }) {
  if (typeof ApiClient !== 'function') throw new TypeError('acceptance API adapter is required')
  const origin = new URL(authenticatedUrl).origin
  const loginUrl = validateDesktopLoginUrl(authenticatedUrl, origin + '/')
  acceptanceTransport = { ApiClient, origin, loginUrl }
  clientsByFetcher = new WeakMap()
}

export async function callAcceptanceRpc(productUrl, method, payload, fetcher = globalThis.fetch) {
  if (!/^[-.A-Za-z]+$/u.test(method)) throw new TypeError('acceptance RPC method is invalid')
  const base = new URL(productUrl)
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new TypeError('acceptance RPC requires a loopback root address')
  }
  try {
    if (acceptanceTransport && acceptanceTransport.origin !== base.origin) throw new Error('acceptance Host origin changed')
    let clients = clientsByFetcher.get(fetcher)
    if (!clients) { clients = new Map(); clientsByFetcher.set(fetcher, clients) }
    let client = clients.get(base.origin)
    if (!client) {
      const ApiClient = acceptanceTransport?.ApiClient
        ?? (await import('../../../packages/terminal-client/lib/api.js')).DshApiClient
      client = new ApiClient(acceptanceTransport?.loginUrl ?? base.href, fetcher)
      clients.set(base.origin, client)
    }
    // Reuse the same authenticated new-protocol transport and pinned history cursor.
    return await client.call(method, payload, AbortSignal.timeout(10_000))
  } catch (error) {
    throw new Error('acceptance RPC ' + method + ' failed: ' + redactDesktopLogin(error instanceof Error ? error.message : 'invalid response'))
  }
}

export async function runInteractionAcceptance({
  target,
  productUrl,
  retireRenderer,
  reportPath,
  challenge,
  runId,
  application,
  externalActionReadyPath,
  awaitExternalDesktopAction = waitForExternalDesktopInput,
  fetcher = globalThis.fetch,
  onStep = async () => {},
}) {
  if (target?.webContents === undefined || typeof target.webContents.executeJavaScript !== 'function') throw new TypeError('interaction acceptance requires a BrowserWindow')
  if (typeof retireRenderer !== 'function') throw new TypeError('interaction acceptance requires a renderer retirement action')
  if (typeof reportPath !== 'string' || !isAbsolute(reportPath)) throw new TypeError('interaction acceptance report path must be absolute')
  if (typeof externalActionReadyPath !== 'string' || !isAbsolute(externalActionReadyPath) || externalActionReadyPath === reportPath) {
    throw new TypeError('interaction acceptance external-action ready path must be a distinct absolute path')
  }
  if (typeof awaitExternalDesktopAction !== 'function') throw new TypeError('interaction acceptance requires an external desktop action waiter')
  if (!/^[a-f0-9]{64}$/u.test(challenge ?? '')) throw new TypeError('interaction acceptance challenge is invalid')
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(runId ?? '')) {
    throw new TypeError('interaction acceptance run identity is invalid')
  }
  const applicationIdentity = packagedApplicationIdentity(application)
  const startedAt = new Date().toISOString()

  await onStep('session-baseline')
  const before = await callAcceptanceRpc(productUrl, 'session.list', {}, fetcher)
  const beforeIds = sessionIds(before)
  await onStep('composer-wait')
  const initial = await waitForRenderer(target, snapshot => snapshot.shell && snapshot.textarea && !snapshot.textareaDisabled, 'interactive composer')
  const clicked = await target.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('button.primary-session')
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false
    button.click()
    return true
  })()`, true)
  if (clicked !== true) throw new Error('native new-session control did not accept a click')
  await onStep('new-session-clicked')
  const ready = await waitForRenderer(
    target,
    snapshot => snapshot.textarea && !snapshot.textareaDisabled && snapshot.modelEnabled && snapshot.permissionEnabled,
    'new-session model and permission controls',
  )
  const modelControl = await verifySelectedModelControl(target)
  await onStep('model-control-verified')

  // Accept the challenge-derived marker only after the acceptance-owned session is the
  // authoritative current session. Otherwise an asynchronous startup session
  // projection can legitimately replace the no-session composer and make a
  // successful input look as if the renderer erased it.
  // The packaged app announces readiness, but it never synthesizes the input
  // that satisfies the formal desktop-action fact. The lifecycle-owned macOS
  // driver must focus this exact child through AX and inject OS keyboard input.
  const draft = externalActionMarker(challenge)
  await writeExternalActionReady(externalActionReadyPath, {
    schema: 'xiaoshe-packaged-app-external-action-ready/v1',
    challenge,
    runId,
    applicationPid: applicationIdentity.pid,
    readyAt: new Date().toISOString(),
  })
  await onStep('external-desktop-action-ready')
  const accepted = await awaitExternalDesktopAction(target, draft)
  if (accepted !== true) throw new Error('packaged composer did not observe external desktop input')

  await onStep('draft-entered')
  const beforeCleanExit = await rendererSnapshot(target)
  if (beforeCleanExit.draftLength !== draft.length || typeof beforeCleanExit.rendererGeneration !== 'string') {
    throw new Error('native composer draft was not observable before renderer retirement')
  }
  const retirement = await retireRenderer()
  if (!rendererProcessChanged(retirement)) throw new Error('renderer process did not change during forced retirement')
  const afterCleanExit = await waitForRenderer(
    target,
    snapshot => snapshot.draftLength === draft.length
      && rendererGenerationChanged(beforeCleanExit.rendererGeneration, snapshot.rendererGeneration),
    'rebuilt renderer with the active draft',
  )
  const exactDraftRetained = await rendererDraftMatches(target, draft)
  if (!exactDraftRetained) throw new Error('rebuilt renderer did not retain the exact active draft')

  await onStep('draft-survived')
  await target.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('textarea[aria-label="输入消息"]')
    if (!(textarea instanceof HTMLTextAreaElement)) return
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, '')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })()`, true)

  const after = await callAcceptanceRpc(productUrl, 'session.list', {}, fetcher)
  const createdIds = [...sessionIds(after)].filter(id => !beforeIds.has(id))
  if (createdIds.length !== 1) throw new Error('isolated interaction acceptance did not create exactly one temporary session')
  for (const sessionId of createdIds) {
    await callAcceptanceRpc(productUrl, 'workspace.archiveSession', { sessionId }, fetcher)
  }
  await onStep('temporary-session-archived')

  const interaction = Object.freeze({
    schema: 'xiaoshe-packaged-ui-interaction/v1',
    shellReady: initial.shell,
    composerAcceptedInput: accepted,
    draftSurvivedRendererRetirement: exactDraftRetained,
    rendererGenerationChanged: rendererGenerationChanged(beforeCleanExit.rendererGeneration, afterCleanExit.rendererGeneration),
    rendererProcessChanged: rendererProcessChanged(retirement),
    externalDesktopActionObserved: accepted,
    newSessionAcceptedClick: clicked,
    modelControlEnabled: ready.modelEnabled,
    modelControlOpened: modelControl.opened,
    modelSelectionPresent: modelControl.selectionPresent,
    modelControlClosed: modelControl.closed,
    permissionControlEnabled: ready.permissionEnabled,
    paidModelRequestSent: false,
    archivedAcceptanceSessions: createdIds.length,
  })
  // Deliberately project only boolean/count facts and process identity. The
  // challenge-derived marker, configured labels, environment, and RPC payloads must
  // never cross into a durable acceptance artifact.
  const report = Object.freeze({
    schema: 'xiaoshe-packaged-app-interaction/v1',
    schemaVersion: 1,
    accepted: true,
    challenge,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    application: applicationIdentity,
    interaction,
  })
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

async function waitForRenderer(target, predicate, description) {
  const deadline = Date.now() + DOM_TIMEOUT_MS
  let last
  while (Date.now() < deadline) {
    last = await rendererSnapshot(target)
    if (predicate(last)) return last
    await new Promise(resolveWait => setTimeout(resolveWait, 150))
  }
  throw new Error(`timed out waiting for ${description}; last=${JSON.stringify(contentFreeReadiness(last))}`)
}

/**
 * Exercise the current model control without invoking a provider. The old
 * select acceptance required a non-empty current value; its popover successor
 * proves the equivalent state by exposing one selected route. A route may be
 * disabled when the isolated acceptance profile intentionally has no secrets.
 */
async function verifySelectedModelControl(target) {
  const opened = await target.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('.model-controls')
    const trigger = document.querySelector('.model-reasoning-trigger')
    if (!(root instanceof HTMLElement) || root.getAttribute('data-status') !== 'ready') return false
    if (!(trigger instanceof HTMLButtonElement) || trigger.disabled || trigger.getAttribute('aria-disabled') === 'true') return false
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
    return true
  })()`, true)
  if (opened !== true) throw new Error('native model control did not accept an open action')

  try {
    await waitForRenderer(
      target,
      snapshot => snapshot.modelPopoverOpen && snapshot.selectedModelPresent,
      'selected model in the native model control',
    )
  } finally {
    const closeAccepted = await target.webContents.executeJavaScript(`(() => {
      const popover = document.querySelector('.model-reasoning-popover')
      if (!(popover instanceof HTMLElement)) return true
      const close = document.querySelector('.model-reasoning-close')
      if (!(close instanceof HTMLButtonElement) || close.disabled) return false
      close.click()
      return true
    })()`, true)
    if (closeAccepted !== true) throw new Error('native model control did not accept a close action')
  }
  await waitForRenderer(target, snapshot => !snapshot.modelPopoverOpen, 'closed native model control')
  return Object.freeze({ opened: true, selectionPresent: true, closed: true })
}

export async function rendererSnapshot(target) {
  return await target.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('.xsla-shell')
    const textarea = document.querySelector('textarea[aria-label="输入消息"]')
    const modelRoot = document.querySelector('.model-controls')
    const model = document.querySelector('.model-reasoning-trigger')
    const modelLabel = document.querySelector('.model-reasoning-label')
    const modelPopover = document.querySelector('.model-reasoning-popover')
    const selectedModel = document.querySelector('.model-choice-option.selected[aria-checked="true"]')
    const permission = document.querySelector('.permission-select-wrap')
    const generationKey = '__xiaosheAcceptanceRendererGeneration'
    if (typeof globalThis[generationKey] !== 'string') globalThis[generationKey] = [Date.now(), Math.random()].join('-')
    return {
      shell: root instanceof HTMLElement,
      textarea: textarea instanceof HTMLTextAreaElement,
      textareaDisabled: textarea instanceof HTMLTextAreaElement ? textarea.disabled : true,
      draftLength: textarea instanceof HTMLTextAreaElement ? textarea.value.length : -1,
      rendererGeneration: globalThis[generationKey],
      modelEnabled: modelRoot instanceof HTMLElement && modelRoot.getAttribute('data-status') === 'ready'
        && model instanceof HTMLButtonElement && !model.disabled && model.getAttribute('aria-disabled') !== 'true'
        && !model.textContent.includes('不可用'),
      modelPopoverOpen: modelPopover instanceof HTMLElement,
      selectedModelPresent: selectedModel instanceof HTMLButtonElement
        && (selectedModel.getAttribute('data-model-route') ?? '').trim() !== '',
      permissionEnabled: permission instanceof HTMLButtonElement && !permission.disabled && !permission.textContent.includes('不可用'),
      modelLabel: modelLabel instanceof HTMLElement ? modelLabel.textContent.trim() : '',
      permissionLabel: permission instanceof HTMLElement ? permission.getAttribute('title') ?? '' : '',
    }
  })()`, true)
}

export function rendererGenerationChanged(before, after) {
  return typeof before === 'string' && before !== '' && typeof after === 'string' && after !== '' && before !== after
}

export function rendererProcessChanged(value) {
  return Number.isSafeInteger(value?.beforePid) && value.beforePid > 0
    && Number.isSafeInteger(value?.afterPid) && value.afterPid > 0
    && value.beforePid !== value.afterPid
}

/** Compare inside the renderer and return only a boolean; never extract draft text. */
export async function rendererDraftMatches(target, expected) {
  if (!/^xsax-[a-f0-9]{20}$/u.test(expected ?? '')) throw new TypeError('renderer draft marker is invalid')
  return await target.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('textarea[aria-label="输入消息"]')
    return textarea instanceof HTMLTextAreaElement && textarea.value === ${JSON.stringify(expected)}
  })()`, true) === true
}

/** Shared with the macOS AX driver; the marker itself never enters a report. */
export function externalActionMarker(challenge) {
  if (!/^[a-f0-9]{64}$/u.test(challenge ?? '')) throw new TypeError('external action challenge is invalid')
  return `xsax-${challenge.slice(0, 20)}`
}

async function writeExternalActionReady(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, path)
}

async function waitForExternalDesktopInput(target, expected) {
  const deadline = Date.now() + EXTERNAL_ACTION_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const observed = await target.webContents.executeJavaScript(`(() => {
        const textarea = document.querySelector('textarea[aria-label="输入消息"]')
        return textarea instanceof HTMLTextAreaElement && textarea.value === ${JSON.stringify(expected)}
      })()`, true)
      if (observed === true) return true
    } catch {
      // The external driver and renderer may race for a bounded interval.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error('timed out waiting for external desktop input')
}

function contentFreeReadiness(snapshot) {
  if (snapshot === undefined || snapshot === null) return snapshot
  return {
    shell: snapshot.shell === true,
    textarea: snapshot.textarea === true,
    textareaDisabled: snapshot.textareaDisabled !== false,
    draftLength: Number.isSafeInteger(snapshot.draftLength) ? snapshot.draftLength : -1,
    modelEnabled: snapshot.modelEnabled === true,
    modelPopoverOpen: snapshot.modelPopoverOpen === true,
    selectedModelPresent: snapshot.selectedModelPresent === true,
    permissionEnabled: snapshot.permissionEnabled === true,
  }
}

function packagedApplicationIdentity(application) {
  if (application?.isPackaged !== true) throw new TypeError('interaction acceptance requires the packaged application')
  if (!Number.isSafeInteger(application.pid) || application.pid <= 0) throw new TypeError('interaction acceptance process identity is invalid')
  if (typeof application.executablePath !== 'string' || !isAbsolute(application.executablePath)) {
    throw new TypeError('interaction acceptance executable path must be absolute')
  }
  if (application.bundleId !== PRODUCT_BUNDLE_ID) throw new TypeError('interaction acceptance bundle identity is invalid')
  const macosDirectory = dirname(application.executablePath)
  const contentsDirectory = dirname(macosDirectory)
  const bundlePath = dirname(contentsDirectory)
  if (basename(macosDirectory) !== 'MacOS' || basename(contentsDirectory) !== 'Contents' || !basename(bundlePath).endsWith('.app')) {
    throw new TypeError('interaction acceptance executable is not inside a macOS application bundle')
  }
  return Object.freeze({
    pid: application.pid,
    executablePath: application.executablePath,
    isPackaged: true,
    bundleId: application.bundleId,
    bundlePath,
    bundleExecutable: basename(application.executablePath),
  })
}

function sessionIds(value) {
  const items = Array.isArray(value?.items) ? value.items : []
  return new Set(items.flatMap(item => typeof item?.sessionId === 'string' ? [item.sessionId] : []))
}
