/** Explicit native-main acceptance. The model owns file/browser decisions;
 * this observer only supplies a task, exercises takeover and reads evidence. */
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { callAcceptanceRpc } from './interaction-acceptance.mjs'
import { acceptanceServiceEnvironment } from './acceptance-isolation.mjs'
import { observeLoadedFrontend, versionEvidence } from './lifecycle-acceptance.mjs'
import { waitForFreshVisionComposer as waitForFreshProductComposer } from './vision-acceptance.mjs'
import { prepareAcceptanceBrowser, captureAcceptancePng } from './browser-acceptance-ready.mjs'
const MATERIAL_SCENARIOS = Object.freeze(['normal', 'missing_input', 'response_lost', 'takeover'])

export function materialAcceptanceConfig(argv, environment, options) {
  if (!argv.includes('--acceptance-material')) return undefined
  const isolation = acceptanceServiceEnvironment(environment, options)
  if (!isolation) throw new Error('material acceptance requires isolated native launch')
  const root = isolation.XIAOSHE_DESKTOP_ACCEPTANCE_ROOT
  const runId = basename(root).slice('xiaoshe-product-acceptance-'.length)
  if (environment.XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID !== runId || !MATERIAL_SCENARIOS.includes(environment.XIAOSHE_MATERIAL_SCENARIO)) throw new Error('material acceptance identity or scenario mismatch')
  const fixture = new URL(environment.XIAOSHE_MATERIAL_FIXTURE_URL)
  if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1' || !fixture.port || fixture.port === '3080'
    || fixture.port === isolation.XIAOSHE_DSH_PORT || fixture.pathname !== `/${runId}/` || fixture.username || fixture.password || fixture.search || fixture.hash) throw new Error('material fixture must be a distinct owned loopback URL')
  return Object.freeze({ root, runId, sessionId: `xiaoshe-material-${runId}`, scenario: environment.XIAOSHE_MATERIAL_SCENARIO,
    fixtureUrl: fixture.href, productUrl: `http://127.0.0.1:${isolation.XIAOSHE_DSH_PORT}/`,
    workspaceRoot: isolation.XIAOSHE_ACCEPTANCE_WORKSPACE, profileRoot: join(isolation.DSH_HOME, 'profiles/web'),
    reportPath: join(root, 'material-native.json') })
}

export function materialPrompt(config) {
  const input = config.scenario === 'missing_input' ? 'missing.jsonl' : 'input.jsonl'
  return `完成本次资料交付任务。工作目录：${config.workspaceRoot}。先读取 ${input}，按原行序提取 project、amount、quantity、owner，保留值和类型，缺少 owner 置 null；生成 output/result.json，顶层只含 items 数组，各项只含上述四字段，并回读核对。然后在小蛇专用浏览器打开 ${config.fixtureUrl}，把已核对的结构化 JSON 填入表单，保存并重新读取网页核对实际保存结果。只能新增 output/result.json，原资料不得改变；网页只允许本链接下的验收记录。禁止终端、直接 HTTP、修改配置或系统桌面操作。所需输入缺失时停止并如实说明，不要猜测内容或擅自改读其他文件。保存结果不明时先查看已保存记录，不盲目重发；用户接管后停止网页操作，不自行交回。最后分别说明文件和网页的真实完成状态及未完成项。`
}

export function assertMaterialCurrentGuards({ budget, policy, config }) {
  // The reader validates the full manifest; the native observer additionally
  // binds its version and scenario before any user prompt can reach a model.
  if (!budget?.mounted || budget.reservedRequests !== 0 || budget.runId !== config.runId
    || !policy?.mounted || policy.schema !== 'xiaoshe-live-material-policy/v2'
    || !MATERIAL_SCENARIOS.includes(config.scenario) || policy.scenario !== config.scenario
    || policy.runId !== config.runId || policy.workspaceRealPath !== config.workspaceRoot
    || JSON.stringify(policy.sessionIds) !== JSON.stringify([config.sessionId])) throw new Error('live guards not ready')
}

const save = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
async function waitFor(observe, label, timeout = 20_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = await observe(); if (value) return value; await delay(100) }
  throw new Error(`material acceptance timed out: ${label}`)
}

export async function runMaterialAcceptance({ config, productRoot, target, workspace, expectedIdentity, onStep = () => {} }) {
  // Packaged app.asar and the copied product root are different trees. Resolve
  // acceptance helpers only from the validated product root and only in this
  // explicitly gated branch; ordinary desktop startup needs none of them.
  const fromProduct = path => import(pathToFileURL(join(productRoot, path)).href)
  const { completedNewTurn } = await fromProduct('scripts/acceptance/same-session-files-live.mjs')
  const { readBudgetLedger } = await fromProduct('scripts/acceptance/live-request-budget.mjs')
  const { readLiveMaterialPolicyLedger } = await fromProduct('scripts/acceptance/live-material-policy.mjs')
  const report = { schema: 'xiaoshe-material-native/v1', runId: config.runId, sessionId: config.sessionId,
    scenario: config.scenario, startedAt: new Date().toISOString(), pid: process.pid,
    nativeActions: [], takeover: null, finalPage: null, accepted: false }
  const rpc = (method, payload) => callAcceptanceRpc(config.productUrl, method, payload), inspect = code => target.webContents.executeJavaScript(code)
  const originalAgent = workspace.agent
  let history, stage = 'startup', takeoverStarted = false
  const step = async value => { stage = value; await onStep(value) }
  const click = async text => waitFor(() => inspect(`(() => {
    const button=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&!el.disabled)
    if(!button)return false;button.click();return true
  })()`), `UI button ${text}`)
  workspace.agent = async function(ownerId, command, args = {}, signal) {
    const row = { ownerId, command, args: structuredClone(args), startedAt: new Date().toISOString() }
    report.nativeActions.push(row)
    let value
    try {
      value = await originalAgent.call(this, ownerId, command, args, signal)
      row.status = 'success'; row.value = structuredClone(value); row.finishedAt = new Date().toISOString()
    } catch (error) {
      row.status = 'error'; row.code = error.code ?? 'UNCLASSIFIED'; row.message = String(error.message).slice(0, 1000); row.finishedAt = new Date().toISOString()
      throw error
    }
    try {
      if (config.scenario === 'takeover' && ownerId === config.sessionId && command === 'type' && !takeoverStarted) {
        takeoverStarted = true
        // A real renderer button invokes the normal trusted IPC path. Do this
        // after typing, before returning its result, so the next model action
        // encounters the actual user-mode gate instead of a mocked rejection.
        await click('我来接管')
        await waitFor(() => workspace.status(ownerId).mode === 'user', 'native takeover mode')
        report.takeover = { at: new Date().toISOString(), mode: 'user', uiClicked: true, afterCommand: command }
      }
      return value
    } catch (error) {
      // A failed test-side takeover is not a failed native type operation.
      // Keep both observations so proof cannot misclassify an injected error.
      row.injectionFailure = { at: new Date().toISOString(), message: String(error.message).slice(0, 1000) }
      report.injectionFailure = row.injectionFailure
      throw error
    }
  }
  try {
    await step('loaded-product-version')
    const ui = await observeLoadedFrontend(target)
    const desktop = await fetch(new URL('xiaoshe/desktop/status', config.productUrl)).then(r => r.json())
    const version = await fetch(new URL(`xiaoshe/desktop/version?frontend_identity=${encodeURIComponent(ui.identity ?? '')}`, config.productUrl)).then(r => r.json())
    report.frontend = versionEvidence({ ui, desktop, version, expectedIdentity, productUrl: config.productUrl })
    if (!report.frontend.identityMatches || !report.frontend.frontendMatches || !report.frontend.aboutRendered) throw new Error('native candidate identity mismatch')
    await step('owned-session')
    const created = await rpc('session.create', { sessionId: config.sessionId, cwd: config.workspaceRoot, agentPreset: 'standard' })
    if (created.sessionId !== config.sessionId) throw new Error('unexpected session identity')
    await rpc('session.rename', { sessionId: config.sessionId, title: `资料交付验收 ${config.scenario}` })
    await rpc('session.selectModel', { sessionId: config.sessionId, provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' })
    report.model = await rpc('session.models', { sessionId: config.sessionId })
    if (report.model.routable !== true || report.model.current?.provider !== 'deepseek-official' || report.model.current?.model !== 'deepseek-v4-flash' || report.model.current?.reasoningEffort !== 'off') throw new Error('wrong live model')
    report.budgetBefore = await readBudgetLedger(join(config.root, 'budget'))
    report.policyBefore = await readLiveMaterialPolicyLedger(join(config.root, 'tool-policy'))
    assertMaterialCurrentGuards({ budget: report.budgetBefore, policy: report.policyBefore, config })
    // Reopen the real UI after About, then select the exact owned session.
    await target.loadURL(config.productUrl)
    // Reuse the native-paste journey's real onboarding interaction. Otherwise
    // an asynchronously mounted beta notice can leave takeover buttons inert.
    await waitForFreshProductComposer(inspect, state => { report.composerPreparation = state })
    await waitFor(() => inspect(`(() => {const row=document.querySelector('[data-session-id="${config.sessionId}"] button.sess');if(!row)return false;row.click();return true})()`), 'owned session in sidebar')
    await waitFor(() => inspect(`!!document.querySelector('[data-session-id="${config.sessionId}"].on')`), 'owned session selected')
    report.browserPreparation = await prepareAcceptanceBrowser({ target, workspace, sessionId: config.sessionId,
      onObservation: value => { report.browserPreparation = value } })
    await step('model-task')
    const before = await rpc('session.history', { sessionId: config.sessionId, maxMessages: 200 })
    const previous = before.events.at(-1)?.event.seq ?? -1
    await rpc('session.prompt', { sessionId: config.sessionId, mode: 'queue', content: [{ type: 'text', text: materialPrompt(config) }] })
    let result
    const deadline = Date.now() + 420_000
    let nextProgress = Date.now() + 20_000
    while (Date.now() < deadline) {
      await delay(500)
      history = await rpc('session.history', { sessionId: config.sessionId, maxMessages: 200 })
      result = completedNewTurn(history, previous)
      if (result) break
      if (Date.now() > nextProgress) { await onStep('model-running'); nextProgress = Date.now() + 20_000 }
    }
    report.turn = result
    if (!result || result.reason !== 'completed') throw new Error(`model task did not complete (${result?.reason ?? 'timeout'})`)
    await step('native-final-observation')
    report.browserStatus = workspace.status(config.sessionId)
    report.mounted = { ownerId: workspace.activeOwner, bounds: workspace.bounds,
      dockPresent: await inspect('!!document.querySelector("#xsla-browser-dock")') }
    report.chatLayout = await inspect(`(() => {
      const dimensions = selector => { const el=document.querySelector(selector); if(!el)return null;
        const box=el.getBoundingClientRect();return {clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,x:box.x,width:box.width} };
      return {stream:dimensions('.xsla-shell .stream'),events:dimensions('.xsla-shell .events'),userMessage:dimensions('.xsla-shell .event-user')}
    })()`)
    if (['normal', 'response_lost'].includes(config.scenario)) {
      const tabId = report.browserStatus.active_tab
      const tab = workspace.tab(tabId, config.sessionId)
      const contents = tab.view.webContents
      // This independent read occurs AFTER the model's completed turn. Reload
      // invokes GET only; it must never fill, submit or fix the model's result.
      await contents.loadURL(config.fixtureUrl)
      const page = await contents.executeJavaScript(`(() => {const text=document.querySelector('#record')?.textContent;return {url:location.href,status:document.querySelector('#status')?.textContent,record:text?JSON.parse(text):null}})()`)
      report.finalPage = { ...page, rendererPid: contents.getOSProcessId(), reloaded: true, capturedAt: new Date().toISOString() }
      if (workspace.activeOwner !== config.sessionId || !(workspace.bounds?.width > 100) || !report.mounted.dockPresent) throw new Error('native browser was not visibly mounted in the product')
      // BrowserWindow.capturePage excludes child WebContentsView pixels on
      // macOS; retain the real native page separately instead of implying the
      // blank child area in a shell-only capture proves the webpage rendered.
      await writeFile(join(config.root, 'material-page.png'), await captureAcceptancePng(contents), { flag: 'wx', mode: 0o600 })
    }
    await writeFile(join(config.root, 'material-product.png'), await captureAcceptancePng(target.webContents), { flag: 'wx', mode: 0o600 })
    if (report.injectionFailure) throw new Error('native takeover injection failed; see separate injection evidence')
    report.accepted = true
  } catch (error) {
    report.failure = { stage, message: String(error.message).slice(0, 800) }
    throw error
  } finally {
    workspace.agent = originalAgent
    try { await rpc('session.cancel', { sessionId: config.sessionId }) } catch { /* outer process/service teardown remains mandatory */ }
    let retentionError
    try { if (history) await save(join(config.root, 'material-history.json'), history) }
    catch (error) {
      retentionError = error
      report.accepted = false
      report.retentionFailure = { stage: 'history', message: String(error.message).slice(0, 800) }
    }
    report.finishedAt = new Date().toISOString()
    await save(config.reportPath, report)
    if (retentionError) throw retentionError
  }
  return report
}
