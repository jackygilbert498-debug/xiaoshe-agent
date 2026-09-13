/** Two real native process phases sharing one durable model session. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { callAcceptanceRpc } from './interaction-acceptance.mjs'
import { acceptanceServiceEnvironment } from './acceptance-isolation.mjs'
import { observeLoadedFrontend, versionEvidence } from './lifecycle-acceptance.mjs'
import { prepareVisionComposer as prepareProductComposer, waitForFreshVisionComposer as waitForFreshProductComposer } from './vision-acceptance.mjs'
import { prepareAcceptanceBrowser, prepareAcceptanceTabCapture, captureAcceptancePng } from './browser-acceptance-ready.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
export function batchAcceptanceConfig(argv, environment, options) {
  if (!argv.includes('--acceptance-batch')) return undefined
  const isolation = acceptanceServiceEnvironment(environment, options)
  if (!isolation) throw new Error('batch acceptance requires isolated native launch')
  const root = isolation.XIAOSHE_DESKTOP_ACCEPTANCE_ROOT, runId = basename(root).slice('xiaoshe-product-acceptance-'.length)
  const phase = environment.XIAOSHE_BATCH_PHASE, candidateId = environment.XIAOSHE_BATCH_CANDIDATE_ID
  if (environment.XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID !== runId || !['seed', 'resume'].includes(phase)
    || !/^[a-f0-9]{64}$/u.test(candidateId ?? '')) throw new Error('batch phase or identity mismatch')
  const fixture = new URL(environment.XIAOSHE_BATCH_FIXTURE_URL)
  if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1' || !fixture.port || fixture.port === '3080'
    || fixture.port === isolation.XIAOSHE_DSH_PORT || fixture.pathname !== `/${runId}/` || fixture.username || fixture.password || fixture.search || fixture.hash) throw new Error('invalid batch fixture URL')
  return Object.freeze({ root, runId, sessionId: `xiaoshe-batch-${runId}`, phase, candidateId, fixtureUrl: fixture.href,
    productUrl: `http://127.0.0.1:${isolation.XIAOSHE_DSH_PORT}/`, backendPort: Number(isolation.XIAOSHE_DSH_PORT),
    workspaceRoot: isolation.XIAOSHE_ACCEPTANCE_WORKSPACE, profileRoot: join(isolation.DSH_HOME, 'profiles/web'),
    reportPath: join(root, `batch-${phase}-native.json`) })
}

export function batchPrompt(config) {
  const pairs = [1, 2, 3].map(index => `读取 "input-${index}.jsonl" → 只能新增 "output/item-${index}.json"。对应网页：${config.fixtureUrl}item-${index}/`).join('\n')
  // Publish the same stage boundary checked by the independent seed proof;
  // the full-batch mapping below is context, not permission to pre-read it.
  const stage = config.phase === 'seed'
    ? '本阶段只执行第一项。本阶段只读取第一项资料与其生成结果；不读取第二、第三项资料或它们的结果，不打开后两项网页。它的本地文件和网页实际保存均独立核对后，先停止，明确剩余两项待继续，不提前处理第二、第三项。'
    : '继续同一批次任务。先重新读取 output/item-1.json，并打开第一项网页确认服务器保存的实际记录；不要相信历史完成标签，不要改写或再次提交第一项。确认后按顺序继续第二、第三项。'
  // The proof checks an explicit completion count. Publish that output
  // requirement in advance, without supplying the expected count or bad item.
  return `${stage}\n工作目录：${config.workspaceRoot}。沿用本批次的明确一对一映射：\n${pairs}\n逐行提取 project、amount、quantity、owner，保留原顺序、值和类型，缺少 owner 置 null。每项输出顶层只有 items，数组各项只有上述四字段，写后必须回读核对，再在小蛇专用浏览器填写对应网页并保存，独立核对实际服务器记录。原资料不得改变。若某份资料无法解析，说明文件名、具体行号和错误原因，不猜测、修补原资料或生成该项结果，诚实保留未完成项；不影响其他有效项。每个网页只允许本链接的验收记录、只能提交一次，结果不明先查看记录，不盲目重发。禁止终端、直接HTTP、修改配置、系统桌面操作和其他路径。最后逐项说明实际完成状态及未完成项，并以“实际完成数量/总数量”汇总已独立核对的交付进度，未完成或待验证项不得计作完成。`
}

/** Historical mounts do not authorize a newly started backend. Check both
 * current-process fences before the first paid prompt in either phase. */
export function assertBatchCurrentGuards({ config, budget, policy }) {
  const reject = () => { throw new Error('batch current-process guards not ready') }
  const count = config.phase === 'seed' ? 1 : 2
  if (!budget?.mounted || budget.runId !== config.runId || budget.mountCount !== count
    || !Array.isArray(budget.mounts) || budget.mounts.length !== count
    || budget.mounts.some(row => row.runId !== config.runId || !Number.isSafeInteger(row.pid) || row.pid <= 1 || !Number.isFinite(Date.parse(row.at)))
    || new Set(budget.mounts.map(row => row.pid)).size !== count
    || (config.phase === 'seed' ? budget.reservedRequests !== 0 : budget.reservedRequests < 1)) reject()
  const current = [...budget.mounts].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1)
  if (!policy?.mounted || policy.runId !== config.runId || policy.workspaceRealPath !== config.workspaceRoot
    || !Array.isArray(policy.sessionIds) || policy.sessionIds.length !== 1 || policy.sessionIds[0] !== config.sessionId
    || !Array.isArray(policy.mounts)) reject()
  const mounts = policy.mounts.filter(row => row.pid === current.pid)
  const host = mounts.find(row => row.kind === 'host' && row.sessionId === null)
  const agent = mounts.find(row => row.kind === 'agent' && row.sessionId === config.sessionId)
  // The budget publishes asynchronously while the policy mounts synchronously;
  // their timestamps need not share an order. PID identity and the policy's
  // own host-before-agent order are the relevant pre-dispatch facts.
  if (mounts.length !== 2 || !host || !agent || mounts.some(row => row.runId !== config.runId || row.policyDigest !== policy.policyDigest)
    || !Number.isFinite(Date.parse(host.at)) || !Number.isFinite(Date.parse(agent.at))
    || Date.parse(agent.at) < Date.parse(host.at)) reject()
  return current.pid
}
async function waitFor(observe, label) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) { const value = await observe(); if (value) return value; await delay(100) }
  throw new Error(`batch acceptance timed out: ${label}`)
}

export async function runBatchAcceptance({ config, productRoot, target, workspace, expectedIdentity, onStep = () => {} }) {
  const fromProduct = path => import(pathToFileURL(join(productRoot, path)).href)
  const { completedNewTurn } = await fromProduct('scripts/acceptance/same-session-files-live.mjs')
  const { readBudgetLedger } = await fromProduct('scripts/acceptance/live-request-budget.mjs')
  const { readLiveMaterialPolicyLedger } = await fromProduct('scripts/acceptance/live-material-policy.mjs')
  const report = { schema: 'xiaoshe-batch-native/v1', runId: config.runId, sessionId: config.sessionId,
    phase: config.phase, candidateId: config.candidateId, profileRoot: config.profileRoot, backendPort: config.backendPort,
    runtimeIdentity: expectedIdentity, pid: process.pid, startedAt: new Date().toISOString(), accepted: false, nativeActions: [], finalPages: [] }
  const rpc = (method, payload) => callAcceptanceRpc(config.productUrl, method, payload), inspect = code => target.webContents.executeJavaScript(code)
  const originalAgent = workspace.agent
  let history, stage = 'startup'
  const step = async value => { stage = value; await onStep(value) }
  workspace.agent = async function(ownerId, command, args = {}, signal) {
    const row = { ownerId, command, args: structuredClone(args), startedAt: new Date().toISOString() }
    report.nativeActions.push(row)
    try { const value = await originalAgent.call(this, ownerId, command, args, signal); row.status = 'success'; row.value = structuredClone(value); return value }
    catch (error) { row.status = 'error'; row.code = error.code ?? 'UNCLASSIFIED'; row.message = String(error.message).slice(0, 1000); throw error }
    finally { row.finishedAt = new Date().toISOString() }
  }
  try {
    await step('loaded-product-version')
    const ui = await observeLoadedFrontend(target)
    const desktop = await fetch(new URL('xiaoshe/desktop/status', config.productUrl)).then(r => r.json())
    const version = await fetch(new URL(`xiaoshe/desktop/version?frontend_identity=${encodeURIComponent(ui.identity ?? '')}`, config.productUrl)).then(r => r.json())
    report.frontend = versionEvidence({ ui, desktop, version, expectedIdentity, productUrl: config.productUrl })
    if (!report.frontend.identityMatches || !report.frontend.frontendMatches || !report.frontend.aboutRendered) throw new Error('batch candidate identity mismatch')
    if (config.phase === 'seed') {
      const created = await rpc('session.create', { sessionId: config.sessionId, cwd: config.workspaceRoot, agentPreset: 'standard' })
      if (created.sessionId !== config.sessionId) throw new Error('unexpected session identity')
      await rpc('session.rename', { sessionId: config.sessionId, title: '批量资料 · 重启续做验收' })
      await rpc('session.selectModel', { sessionId: config.sessionId, provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' })
    }
    report.model = await rpc('session.models', { sessionId: config.sessionId })
    if (!report.model.routable || report.model.current?.provider !== 'deepseek-official' || report.model.current?.model !== 'deepseek-v4-flash'
      || report.model.current?.reasoningEffort !== 'off') throw new Error('batch model changed or missing after restart')
    report.budgetBefore = await readBudgetLedger(join(config.root, 'budget'))
    report.policyBefore = await readLiveMaterialPolicyLedger(join(config.root, 'tool-policy'))
    report.backendPid = assertBatchCurrentGuards({ config, budget: report.budgetBefore, policy: report.policyBefore })
    await target.loadURL(config.productUrl)
    // Only the first process has a fresh Profile. The second must retain the
    // normal UI acknowledgement, not wait for a notice already acknowledged.
    if (config.phase === 'seed') await waitForFreshProductComposer(inspect, state => { report.composerPreparation = state })
    else await waitFor(async () => {
      report.composerPreparation = await inspect(`(${prepareProductComposer.toString()})(document)`)
      return report.composerPreparation.ready
    }, 'restored interactive composer')
    await waitFor(() => inspect(`(() => {const row=document.querySelector('[data-session-id="${config.sessionId}"] button.sess');if(!row)return false;row.click();return true})()`), 'owned session in sidebar')
    await waitFor(() => inspect(`!!document.querySelector('[data-session-id="${config.sessionId}"].on')`), 'owned session selected')
    report.browserPreparation = await prepareAcceptanceBrowser({ target, workspace, sessionId: config.sessionId,
      onObservation: value => { report.browserPreparation = value } })
    const before = await rpc('session.history', { sessionId: config.sessionId, maxMessages: 400 })
    if (before.hasMore) throw new Error('incomplete batch history before phase')
    const previous = before.events.at(-1)?.event.seq ?? -1
    report.previousSeq = previous
    if (config.phase === 'resume') {
      const checkpoint = JSON.parse(await readFile(join(config.root, 'batch-checkpoint.json'), 'utf8'))
      const prefix = before.events.filter(row => row.event.seq <= checkpoint.lastSeq).map(row => row.event)
      if (checkpoint.runId !== config.runId || checkpoint.sessionId !== config.sessionId || checkpoint.candidateId !== config.candidateId
        || checkpoint.lastSeq > previous || sha(JSON.stringify(prefix)) !== checkpoint.historySha256) throw new Error('durable history checkpoint mismatch')
      report.restoredCheckpoint = checkpoint
    }
    await step(`batch-${config.phase}-model-task`)
    await rpc('session.prompt', { sessionId: config.sessionId, mode: 'queue', content: [{ type: 'text', text: batchPrompt(config) }] })
    const deadline = Date.now() + 420_000
    let result, nextProgress = Date.now() + 20_000
    while (Date.now() < deadline) {
      await delay(500); history = await rpc('session.history', { sessionId: config.sessionId, maxMessages: 400 })
      result = completedNewTurn(history, previous)
      if (result) break
      if (Date.now() > nextProgress) { await onStep(`batch-${config.phase}-model-running`); nextProgress = Date.now() + 20_000 }
    }
    report.turn = result
    if (!result || result.reason !== 'completed' || history.hasMore) throw new Error(`batch phase did not complete (${result?.reason ?? 'timeout'})`)
    await step('independent-final-pages')
    for (const index of config.phase === 'seed' ? [1] : [1, 2]) {
      const itemId = `item-${index}`, url = `${config.fixtureUrl}${itemId}/`
      // Reusing one tab is legitimate. The independent observer only performs
      // GET after the turn, and never creates/submits a record for the model.
      const owned = [...workspace.tabs.values()].filter(row => row.ownerId === config.sessionId)
      const tab = owned.find(row => row.view.webContents.getURL() === url) ?? owned[0]
      if (!tab) throw new Error(`model did not leave an observable item tab: ${itemId}`)
      const contents = tab.view.webContents
      await contents.loadURL(url)
      const page = await contents.executeJavaScript(`(() => {const text=document.querySelector('#record')?.textContent;return {url:location.href,status:document.querySelector('#status')?.textContent,record:text?JSON.parse(text):null}})()`)
      const capturePreparation = await prepareAcceptanceTabCapture({ target, workspace, sessionId: config.sessionId, tab, expectedUrl: url })
      report.finalPages.push({ itemId, ...page, reloaded: true, rendererPid: contents.getOSProcessId(), capturePreparation, capturedAt: new Date().toISOString() })
      await writeFile(join(config.root, `batch-${config.phase}-${itemId}.png`), await captureAcceptancePng(contents), { flag: 'wx', mode: 0o600 })
    }
    if (config.phase === 'seed') {
      report.checkpoint = { runId: config.runId, sessionId: config.sessionId, candidateId: config.candidateId,
        lastSeq: history.events.at(-1).event.seq, savedAt: new Date().toISOString(), historySha256: sha(JSON.stringify(history.events.map(row => row.event))) }
      await save(join(config.root, 'batch-checkpoint.json'), report.checkpoint)
    }
    await writeFile(join(config.root, `batch-${config.phase}-product.png`), await captureAcceptancePng(target.webContents), { flag: 'wx', mode: 0o600 })
    report.accepted = true
  } catch (error) { report.failure = { stage, message: String(error.message).slice(0, 800) }; throw error }
  finally {
    workspace.agent = originalAgent
    try { await rpc('session.cancel', { sessionId: config.sessionId }) } catch { /* outer owned shutdown remains required */ }
    try { if (history) await save(join(config.root, `batch-${config.phase}-history.json`), history) }
    catch (error) { report.accepted = false; report.retentionFailure = { message: String(error.message).slice(0, 800) } }
    report.finishedAt = new Date().toISOString(); await save(config.reportPath, report)
  }
  return report
}
