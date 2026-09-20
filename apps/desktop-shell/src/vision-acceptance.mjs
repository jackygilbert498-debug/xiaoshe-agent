/** Explicit isolated desktop journey; never used by ordinary startup. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { callAcceptanceRpc } from './interaction-acceptance.mjs'
import { acceptanceServiceEnvironment } from './acceptance-isolation.mjs'
import { observeLoadedFrontend, versionEvidence } from './lifecycle-acceptance.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
export function visionAcceptanceConfig(argv, environment, options) {
  if (!argv.includes('--acceptance-vision')) return undefined
  const isolation = acceptanceServiceEnvironment(environment, options)
  if (!isolation) throw new Error('vision acceptance requires isolated native launch')
  const root = isolation.XIAOSHE_DESKTOP_ACCEPTANCE_ROOT, runId = basename(root).slice('xiaoshe-product-acceptance-'.length)
  const inputKind = environment.XIAOSHE_VISION_INPUT_KIND
  if (environment.XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID !== runId || !['path', 'attachment'].includes(inputKind)
    || inputKind === 'attachment' && environment.XIAOSHE_VISION_CLIPBOARD_AUTHORIZED !== '1') throw new Error('vision identity, input or clipboard authorization mismatch')
  return Object.freeze({ root, runId, sessionId: `xiaoshe-vision-${runId}`, inputKind,
    productUrl: `http://127.0.0.1:${isolation.XIAOSHE_DSH_PORT}/`, workspaceRoot: isolation.XIAOSHE_ACCEPTANCE_WORKSPACE,
    imagePath: join(isolation.XIAOSHE_ACCEPTANCE_WORKSPACE, 'input.png'), profileRoot: join(isolation.DSH_HOME, 'profiles/web'),
    reportPath: join(root, 'vision-native.json') })
}
async function waitFor(observe, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const value = await observe(); if (value) return value; await delay(100) }
  throw new Error(`vision acceptance timed out: ${label}`)
}

/** Before paid input, all three independent mounts must belong to the same
 * live backend. The outer runner separately checks its launch token/PID/time. */
export function assertVisionCurrentGuards({ config, budget, policy, wire, imageSha256, sourceHashes }, probe = process.kill.bind(process)) {
  const reject = () => { throw new Error('vision current-process guards not ready') }
  const now = new Date().toISOString(), at = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value && value <= now
  const pid = budget?.mounts?.[0]?.pid
  if (!budget?.mounted || budget.runId !== config.runId || budget.mountCount !== 1 || budget.mounts?.length !== 1
    || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || budget.mounts[0].runId !== config.runId || !at(budget.mounts[0].at)
    || budget.mode !== 'bounded_model' || budget.maxRequests !== 8 || budget.maxOutputTokens !== 2048
    || budget.reservedRequests !== 0 || budget.attemptedRequests !== 0 || budget.deniedRequests !== 0 || budget.requests?.length !== 0) reject()
  if (!policy?.mounted || policy.runId !== config.runId || policy.inputKind !== config.inputKind || policy.imageSha256 !== imageSha256
    || !isDeepStrictEqual(policy.sessionIds, [config.sessionId]) || policy.workspaceRealPath !== config.workspaceRoot || policy.imagePath !== config.imagePath
    || !Array.isArray(policy.mounts) || policy.mounts.length !== 2
    || policy.mounts.some(row => row.pid !== pid || row.runId !== config.runId || row.policyDigest !== policy.policyDigest || !at(row.at))) reject()
  const host = policy.mounts.find(row => row.kind === 'host' && row.sessionId === null), agent = policy.mounts.find(row => row.kind === 'agent' && row.sessionId === config.sessionId)
  if (!host || !agent || agent.at < host.at) reject()
  const m = wire?.manifest, w = wire?.mount
  if (wire?.schema !== 'xiaoshe-vision-wire-ledger/v1' || wire.runId !== config.runId || wire.sessionId !== config.sessionId
    || wire.mounted !== true || wire.observedAttempts !== 0 || wire.requests?.length !== 0
    || m?.schema !== 'xiaoshe-vision-wire-manifest/v1' || m.runId !== config.runId || m.sessionId !== config.sessionId || m.pid !== pid
    || m.endpoint !== 'https://api.deepseek.com/chat/completions' || !at(m.createdAt)
    || w?.schema !== 'xiaoshe-vision-wire-host-mount/v1' || w.runId !== config.runId || w.sessionId !== config.sessionId || w.pid !== pid
    || !at(w.at) || w.at < m.createdAt
    || !/^[a-f0-9]{64}$/u.test(sourceHashes?.observerSourceSha256 ?? '') || !/^[a-f0-9]{64}$/u.test(sourceHashes?.installerSourceSha256 ?? '')
    || m.observerSourceSha256 !== sourceHashes.observerSourceSha256 || m.installerSourceSha256 !== sourceHashes.installerSourceSha256) reject()
  try { probe(pid, 0) } catch { reject() } // EPERM is not evidence of current ownership.
  return pid
}

/** Electron 44 commits ClipboardItem payloads atomically. Use its documented
 * native-format mapping to preserve the synthetic PNG bytes without a decode/
 * re-encode. Never clear first or read the user's prior clipboard contents. */
export async function writeNativeVisionClipboard({ clipboard, ClipboardItem, bytes }) {
  if (typeof clipboard?.write !== 'function' || typeof ClipboardItem !== 'function'
    || !Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('native PNG clipboard API unavailable')
  const item = new ClipboardItem({ 'electron application/osclipboard;format="public.png"': new Blob([bytes], { type: 'image/png' }) })
  await clipboard.write([item])
}

/** Runs inside the real product page. Acknowledge only its known informational
 * beta notice through the actual button, never strip inert or dismiss approval. */
export function prepareVisionComposer(doc) {
  const dialogs = [...doc.querySelectorAll('[role="dialog"][aria-modal="true"]')]
  const notice = dialogs.find(dialog => dialog.querySelector('h2')?.textContent?.trim() === '内测声明')
  if (notice) {
    const buttons = [...notice.querySelectorAll('button')].filter(button => button.textContent?.trim() === '继续' && !button.disabled)
    if (buttons.length !== 1) return { ready: false, reason: 'beta-notice-button-unavailable' }
    buttons[0].click()
    return { ready: false, reason: 'beta-notice-acknowledged' }
  }
  if (dialogs.length) return { ready: false, reason: 'other-dialog-open' }
  const el = doc.querySelector('.xsla-shell form.cbox textarea[name="content"]')
  if (!el || el.disabled || !el.isConnected || el.getClientRects().length === 0
    || el.closest('[inert],[hidden],[aria-hidden="true"]')) return { ready: false, reason: 'composer-not-editable' }
  el.focus()
  return { ready: doc.activeElement === el, reason: doc.activeElement === el ? 'ready' : 'composer-not-focused' }
}

export async function waitForFreshVisionComposer(inspect, onState = () => {}) {
  let acknowledged = false
  return waitFor(async () => {
    const state = await inspect(`(${prepareVisionComposer.toString()})(document)`)
    if (state.reason === 'beta-notice-acknowledged') acknowledged = true
    onState({ ...state, acknowledged })
    // Fresh Profiles have not acknowledged this notice. Its settings join is
    // async: an initially unobstructed composer is not onboarding completion.
    return acknowledged && state.ready ? { ...state, acknowledged } : undefined
  }, 'fresh-profile onboarding and interactive composer')
}

/** Backend completion precedes renderer subscription/paint. Observe the real
 * final-answer surface and idle composer before keeping a delivery screenshot. */
export function observeFinishedVisionPage(doc) {
  const answers = [...doc.querySelectorAll('.xsla-shell .event-assistant .event-markdown')]
  const answerText = answers.at(-1)?.textContent?.trim() ?? ''
  const running = !!doc.querySelector('.xsla-shell .stop-generation')
  const blocked = !!doc.querySelector('[role="dialog"][aria-modal="true"]')
  return { ready: !!answerText && !running && !blocked, assistantCount: answers.length, answerText, running, blocked }
}

/** Read only an already rendered, same-origin session Blob. A draft preview,
 * remote URL or a matching thumbnail size cannot substitute for stored bytes. */
export async function observeVisionAttachmentPage(doc, attachmentId, sessionId, fetchImage = fetch, digestBytes = bytes => crypto.subtle.digest('SHA-256', bytes)) {
  const images = [...doc.querySelectorAll('.xsla-shell .event-user img[data-attachment-id]')]
    .filter(node => node.dataset.attachmentId === attachmentId && node.dataset.sessionId === sessionId)
  if (images.length !== 1) return { ready: false, reason: 'historical-image-not-unique' }
  const img = images[0]
  if (!img.complete || !(img.naturalWidth > 0) || !(img.naturalHeight > 0)) return { ready: false, reason: 'historical-image-not-decoded' }
  let url
  try { url = new URL(img.currentSrc || img.src) } catch { return { ready: false, reason: 'historical-image-source-unavailable' } }
  if (url.protocol !== 'blob:' || url.origin !== doc.location.origin) return { ready: false, reason: 'historical-image-source-not-session-blob' }
  try {
    const response = await fetchImage(url.href, { redirect: 'error' })
    if (!response.ok || response.headers.get('content-type') !== 'image/png') return { ready: false, reason: 'historical-image-bytes-unavailable' }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > 1024 * 1024) return { ready: false, reason: 'historical-image-unexpected-size' }
    const sha256 = [...new Uint8Array(await digestBytes(bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
    return { ready: true, source: 'session-attachment-blob', attachmentId, sessionId, sha256, bytes: bytes.byteLength,
      width: img.naturalWidth, height: img.naturalHeight, observedAt: new Date().toISOString() }
  } catch { return { ready: false, reason: 'historical-image-read-failed' } }
}

export async function runVisionAcceptance({ config, productRoot, target, expectedIdentity, clipboard, ClipboardItem, onStep = () => {} }) {
  const fromProduct = path => import(pathToFileURL(join(productRoot, path)).href)
  const { completedNewTurn } = await fromProduct('scripts/acceptance/same-session-files-live.mjs')
  const { visionQuestion } = await fromProduct('scripts/acceptance/vision-fixture.mjs')
  const { readBudgetLedger } = await fromProduct('scripts/acceptance/live-request-budget.mjs')
  const { readLiveVisionPolicyLedger } = await fromProduct('scripts/acceptance/live-vision-policy.mjs')
  const { readVisionWireLedger, readVisionWireSourceHashes } = await fromProduct('scripts/acceptance/vision-wire-install.mjs')
  const report = { schema: 'xiaoshe-vision-native/v1', runId: config.runId, sessionId: config.sessionId,
    inputKind: config.inputKind, startedAt: new Date().toISOString(), pid: process.pid, accepted: false }
  const rpc = (method, payload) => callAcceptanceRpc(config.productUrl, method, payload), inspect = code => target.webContents.executeJavaScript(code)
  const imageBytes = await readFile(config.imagePath), imageSha256 = sha(imageBytes)
  let history, stage = 'startup'
  const step = async value => { stage = value; await onStep(value) }
  try {
    await step('loaded-product-version')
    const ui = await observeLoadedFrontend(target)
    const desktop = await fetch(new URL('xiaoshe/desktop/status', config.productUrl)).then(r => r.json())
    const version = await fetch(new URL(`xiaoshe/desktop/version?frontend_identity=${encodeURIComponent(ui.identity ?? '')}`, config.productUrl)).then(r => r.json())
    report.frontend = versionEvidence({ ui, desktop, version, expectedIdentity, productUrl: config.productUrl })
    if (!report.frontend.identityMatches || !report.frontend.frontendMatches || !report.frontend.aboutRendered) throw new Error('native candidate identity mismatch')
    const created = await rpc('session.create', { sessionId: config.sessionId, cwd: config.workspaceRoot, agentPreset: 'standard' })
    if (created.sessionId !== config.sessionId) throw new Error('unexpected session identity')
    await rpc('session.rename', { sessionId: config.sessionId, title: `视觉验收 ${config.inputKind}` })
    await rpc('session.selectModel', { sessionId: config.sessionId, provider: 'deepseek-modlens', model: 'deepseek-v4-flash', reasoningEffort: 'off' })
    report.model = await rpc('session.models', { sessionId: config.sessionId })
    if (!report.model.routable || report.model.current?.provider !== 'deepseek-modlens' || report.model.current?.model !== 'deepseek-v4-flash') throw new Error('wrong vision wrapper model')
    report.budgetBefore = await readBudgetLedger(join(config.root, 'budget'))
    report.policyBefore = await readLiveVisionPolicyLedger(join(config.root, 'tool-policy'))
    report.wireBefore = await readVisionWireLedger({ acceptanceRoot: config.root, runId: config.runId, sessionId: config.sessionId })
    report.backendPid = assertVisionCurrentGuards({ config, budget: report.budgetBefore, policy: report.policyBefore,
      wire: report.wireBefore, imageSha256, sourceHashes: await readVisionWireSourceHashes() })
    await target.loadURL(config.productUrl)
    await waitForFreshVisionComposer(inspect, state => {
      report.betaNoticeAcknowledged = state.acknowledged
      report.composerPreparation = state
    })
    await waitFor(() => inspect(`(() => {const row=document.querySelector('[data-session-id="${config.sessionId}"] button.sess');if(!row)return false;row.click();return true})()`), 'owned session in sidebar')
    await waitFor(() => inspect(`!!document.querySelector('[data-session-id="${config.sessionId}"].on')`), 'owned session selected')
    const before = await rpc('session.history', { sessionId: config.sessionId, maxMessages: 200 }), previous = before.events.at(-1)?.event.seq ?? -1
    const question = visionQuestion({ kind: config.inputKind, path: config.imagePath })
    if (config.inputKind === 'attachment') {
      await step('native-image-paste')
      // The user explicitly authorized replacing the system clipboard for this
      // test. Never read or retain its previous potentially private contents.
      if (!clipboard || process.platform !== 'darwin') throw new Error('native clipboard unavailable')
      await writeNativeVisionClipboard({ clipboard, ClipboardItem, bytes: imageBytes })
      await waitFor(() => inspect(`(() => {const el=document.querySelector('textarea[name="content"]');return !!el&&!el.disabled&&el.getClientRects().length>0})()`), 'editable composer')
      // Clipboard writing is asynchronous; focus/listen only afterwards so a
      // React update cannot leave the observer on an obsolete textarea.
      await inspect(`(() => {
        window.__xsVisionPaste=null;document.addEventListener('paste',event=>{
          if(event.target!==document.querySelector('textarea[name="content"]'))return;
          const files=[...event.clipboardData.files];
          const observation={trusted:event.isTrusted,at:new Date().toISOString(),count:files.length};
          window.__xsVisionPaste=observation;Promise.all(files.map(async file=>({type:file.type,size:file.size,
            sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('')})))
            .then(values=>{observation.files=values},()=>{observation.error=true}); },{once:true,capture:true}); })()`)
      report.pasteTarget = { webContentsFocused: target.webContents.isFocused(), windowFocused: target.isFocused(),
        dom: await inspect(`(() => {const el=document.querySelector('textarea[name="content"]');el.focus();return {documentFocused:document.hasFocus(),composerFocused:document.activeElement===el,disabled:el.disabled,connected:el.isConnected,
          active:{tag:document.activeElement?.tagName,id:document.activeElement?.id,className:document.activeElement?.className},
          blockers:[...document.querySelectorAll('[inert],[aria-modal="true"]')].map(node=>({tag:node.tagName,id:node.id,className:node.className,containsComposer:node.contains(el)})),
          composerCount:document.querySelectorAll('textarea[name="content"]').length}})()`) }
      if (!report.pasteTarget.dom.composerFocused) {
        await writeFile(join(config.root, 'vision-product.png'), (await target.capturePage()).toPNG(), { flag: 'wx', mode: 0o600 })
        throw new Error('current composer did not receive native paste focus')
      }
      target.webContents.paste()
      const pasted = await waitFor(() => inspect('window.__xsVisionPaste?.files ? window.__xsVisionPaste : null'), 'trusted paste event')
      report.paste = pasted
      if (!pasted.trusted || pasted.count !== 1 || pasted.files[0].type !== 'image/png' || pasted.files[0].sha256 !== imageSha256) throw new Error('native paste bytes or trusted event mismatch')
      report.previewCount = await waitFor(() => inspect('document.querySelectorAll(".attachment-strip .attachment-item").length'), 'image preview')
      if (report.previewCount !== 1) throw new Error('unexpected attachment count')
      await inspect(`(() => {const el=document.querySelector('textarea[name="content"]');el.value=${JSON.stringify(question)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      report.submitStartedAt = new Date().toISOString()
      await inspect(`(() => {const form=document.querySelector('form.cbox');if(!form)throw Error('composer missing');form.requestSubmit()})()`)
      await waitFor(async () => {
        history = await rpc('session.history', { sessionId: config.sessionId, maxMessages: 200 })
        return history.events.some(row => row.event.seq > previous && row.event.type === 'user/message' && row.event.data.source?.kind === 'user')
      }, 'UI attachment submitted')
      report.submitCompletedAt = new Date().toISOString()
    } else await rpc('session.prompt', { sessionId: config.sessionId, mode: 'queue', content: [{ type: 'text', text: question }] })
    await step('vision-model-task')
    let result
    const deadline = Date.now() + 300_000
    while (Date.now() < deadline) {
      await delay(500)
      history = await rpc('session.history', { sessionId: config.sessionId, maxMessages: 200 })
      result = completedNewTurn(history, previous)
      if (result) break
    }
    report.turn = result
    if (!result || result.reason !== 'completed') throw new Error(`vision task did not complete (${result?.reason ?? 'timeout'})`)
    if (config.inputKind === 'attachment') {
      const user = history.events.map(row => row.event).find(row => row.seq > previous && row.type === 'user/message' && row.data.source?.kind === 'user')
      const attachment = user?.data.content?.find(block => block.type === 'image')?.attachment
      report.delivery = { schema: 'xiaoshe-vision-native-attachment/v1', runId: config.runId, sessionId: config.sessionId,
        source: 'native_clipboard', trustedPaste: report.paste.trusted, previewCount: report.previewCount, pasteAt: report.paste.at,
        submitStartedAt: report.submitStartedAt, submitCompletedAt: report.submitCompletedAt,
        userMessageId: user?.data.id, attachmentId: attachment?.attachmentId, imageSha256 }
    }
    await step('visible-final-answer')
    await waitFor(async () => {
      report.finalPage = await inspect(`(${observeFinishedVisionPage.toString()})(document)`)
      return report.finalPage.ready
    }, 'rendered final answer and idle composer')
    if (config.inputKind === 'attachment') {
      const observeImage = async () => {
        const value = await inspect(`(${observeVisionAttachmentPage.toString()})(document,${JSON.stringify(report.delivery.attachmentId)},${JSON.stringify(config.sessionId)})`)
        if (!value.ready) return undefined
        if (value.sha256 !== imageSha256 || value.bytes !== imageBytes.length
          || value.width !== imageBytes.readUInt32BE(16) || value.height !== imageBytes.readUInt32BE(20)) throw new Error('historical attachment differs from actual pasted PNG')
        return value
      }
      report.attachmentViews = { submitted: await waitFor(observeImage, 'submitted image visible in history') }
      await step('attachment-history-reload')
      report.historyReload = { startedAt: new Date().toISOString() }
      await target.loadURL(config.productUrl)
      await waitFor(() => inspect(`(() => {const row=document.querySelector('[data-session-id="${config.sessionId}"] button.sess');if(!row)return false;row.click();return true})()`), 'owned session after reload')
      await waitFor(() => inspect(`!!document.querySelector('[data-session-id="${config.sessionId}"].on')`), 'reloaded owned session selected')
      report.historyReload.completedAt = new Date().toISOString()
      report.attachmentViews.reloaded = await waitFor(observeImage, 'stored image visible after real page reload')
      await waitFor(async () => {
        report.finalPage = await inspect(`(${observeFinishedVisionPage.toString()})(document)`)
        return report.finalPage.ready
      }, 'final answer restored after reload')
    }
    await writeFile(join(config.root, 'vision-product.png'), (await target.capturePage()).toPNG(), { flag: 'wx', mode: 0o600 })
    report.accepted = true
  } catch (error) { report.failure = { stage, message: String(error.message).slice(0, 800) }; throw error }
  finally {
    try { await rpc('session.cancel', { sessionId: config.sessionId }) } catch { /* outer owned cleanup is mandatory */ }
    try { if (history) await save(join(config.root, 'vision-history.json'), history) }
    catch (error) { report.accepted = false; report.retentionFailure = { message: String(error.message).slice(0, 800) } }
    report.finishedAt = new Date().toISOString()
    await save(config.reportPath, report)
  }
  return report
}
