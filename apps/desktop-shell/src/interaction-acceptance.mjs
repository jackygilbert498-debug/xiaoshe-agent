import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

const MODE_FLAG = '--acceptance-interaction'
const DOM_TIMEOUT_MS = 20_000

export function interactionAcceptanceRequested(argv, environment) {
  return environment.XIAOSHE_DESKTOP_ACCEPTANCE === '1' && argv.includes(MODE_FLAG)
}

export async function callAcceptanceRpc(productUrl, method, payload, fetcher = globalThis.fetch) {
  if (!/^[-.A-Za-z]+$/u.test(method)) throw new TypeError('acceptance RPC method is invalid')
  const rpcId = randomUUID()
  const response = await fetcher(new URL(`api/${method}`, productUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json()
  if (!response.ok || body?.rpcId !== rpcId || body?.result?.ok !== true) {
    throw new Error(`acceptance RPC ${method} failed: HTTP ${response.status} ${String(body?.result?.error?.message ?? 'invalid response')}`)
  }
  return body.result.value
}

export async function runInteractionAcceptance({ target, productUrl, simulateCleanExit, reportPath, fetcher = globalThis.fetch, onStep = async () => {} }) {
  if (target?.webContents === undefined || typeof target.webContents.executeJavaScript !== 'function') throw new TypeError('interaction acceptance requires a BrowserWindow')
  if (typeof simulateCleanExit !== 'function') throw new TypeError('interaction acceptance requires a clean-exit simulator')
  if (typeof reportPath !== 'string' || !isAbsolute(reportPath)) throw new TypeError('interaction acceptance report path must be absolute')

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

  // Enter the synthetic draft only after the acceptance-owned session is the
  // authoritative current session. Otherwise an asynchronous startup session
  // projection can legitimately replace the no-session composer and make a
  // successful input look as if the renderer erased it.
  const draft = `小蛇交互验收-${randomUUID()}`
  const accepted = await target.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('textarea[aria-label="输入消息"]')
    if (!(textarea instanceof HTMLTextAreaElement) || textarea.disabled) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (setter === undefined) return false
    setter.call(textarea, ${JSON.stringify(draft)})
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    return textarea.value.length === ${draft.length}
  })()`, true)
  if (accepted !== true) throw new Error('native composer did not accept an input event')

  await onStep('draft-entered')
  await simulateCleanExit()
  const afterCleanExit = await rendererSnapshot(target)
  if (afterCleanExit.draftLength !== draft.length) throw new Error('clean renderer retirement erased the active draft')

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
  for (const sessionId of createdIds) {
    await callAcceptanceRpc(productUrl, 'workspace.archiveSession', { sessionId }, fetcher)
  }
  await onStep('temporary-session-archived')

  const report = Object.freeze({
    schemaVersion: 1,
    accepted: true,
    productUrl: new URL(productUrl).origin,
    shell: initial.shell,
    composerAcceptedInput: accepted,
    draftSurvivedCleanExit: afterCleanExit.draftLength === draft.length,
    newSessionAcceptedClick: clicked,
    modelEnabled: ready.modelEnabled,
    permissionEnabled: ready.permissionEnabled,
    modelLabel: ready.modelLabel,
    permissionLabel: ready.permissionLabel,
    paidModelRequestSent: false,
    archivedAcceptanceSessions: createdIds.length,
    completedAt: new Date().toISOString(),
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
  throw new Error(`timed out waiting for ${description}; last=${JSON.stringify(last)}`)
}

async function rendererSnapshot(target) {
  return await target.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('.xsla-shell')
    const textarea = document.querySelector('textarea[aria-label="输入消息"]')
    const model = document.querySelector('.model-select')
    const modelWrap = document.querySelector('.model-select-wrap')
    const permission = document.querySelector('.permission-select-wrap')
    return {
      shell: root instanceof HTMLElement,
      textarea: textarea instanceof HTMLTextAreaElement,
      textareaDisabled: textarea instanceof HTMLTextAreaElement ? textarea.disabled : true,
      draftLength: textarea instanceof HTMLTextAreaElement ? textarea.value.length : -1,
      modelEnabled: model instanceof HTMLSelectElement && !model.disabled && model.value !== '',
      permissionEnabled: permission instanceof HTMLButtonElement && !permission.disabled && !permission.textContent.includes('不可用'),
      modelLabel: modelWrap instanceof HTMLElement ? modelWrap.getAttribute('title') ?? '' : '',
      permissionLabel: permission instanceof HTMLElement ? permission.getAttribute('title') ?? '' : '',
    }
  })()`, true)
}

function sessionIds(value) {
  const items = Array.isArray(value?.items) ? value.items : []
  return new Set(items.flatMap(item => typeof item?.sessionId === 'string' ? [item.sessionId] : []))
}
