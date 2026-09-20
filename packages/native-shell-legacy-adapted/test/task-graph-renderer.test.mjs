import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import ts from 'typescript'

const desktopRequire = createRequire(new URL('../../../apps/desktop-shell/package.json', import.meta.url))
const webRequire = createRequire(new URL('../../../runtime/DSH/apps/web/package.json', import.meta.url))

function installFixture() {
  const e = React.createElement
  const root = ReactDOM.createRoot(document.getElementById('fixture'))
  const graph = {
    version: 1, id: 'graph-renderer', revision: 3, sessionId: 'fixture-session', taskGeneration: 1,
    goalId: 'goal-1', objective: '验证窄任务栏', runtimeInstance: 'runtime-a', durability: 'durable', status: 'waiting', stale: false, recoveryRequired: true,
    nodes: [
      { id: 'long-build-node', title: '这是一个需要在最窄任务栏中自然换行且不能制造横向滚动的超长中文任务节点标题', dependencies: [], acceptance: [{ id: 'a1', text: '长标题和验收条件在窄栏中仍然完整可读' }], status: 'completed', attempt: 1, startSeq: 2,
        evidence: [{ callId: 'c1', resultSeq: 4, toolName: 'exec_command', attempt: 1, kind: 'reviewer-assessment', acceptanceId: 'a1', assertion: '评估通过', sourceExcerpt: 'renderer fixture' }], feedback: [] },
      { id: 'dependent-node', title: '依赖后的中断节点', dependencies: ['long-build-node'], acceptance: [{ id: 'a2', text: '键盘可以展开详情' }], status: 'interrupted', attempt: 2, startSeq: 5, evidence: [], feedback: [{ text: '运行实例变化后等待人工检查', outcome: 'interrupted' }] },
    ], feedback: [],
  }
  window.drawGraph = (theme, scenario = 'waiting', revision = 3) => {
    const current = { ...graph, revision, objective: '核对两份资料并生成汇总', status: 'active', recoveryRequired: false,
      feedback: [{ text: '先确认来源，再形成汇总；保留已经核对完成的步骤。', outcome: 'needs-work' }],
      nodes: [graph.nodes[0], { ...graph.nodes[1], title: '核对两份资料的分歧', status: 'running', feedback: [{ text: '正在逐项对照来源', outcome: 'needs-work' }] }] }
    const long = { ...current, status: 'ready', nodes: Array.from({ length: 24 }, (_, index) => ({ ...graph.nodes[0],
      id: `step-${index}`, title: index === 18 ? '等待补充缺少的来源文件' : `核对来源并整理结论 ${index + 1}`,
      dependencies: [], status: index < 12 ? 'completed' : index === 18 ? 'blocked' : 'pending',
      feedback: index === 18 ? [{ text: '请补充原始来源文件的位置，已有结果保留。' + '补充说明应当在窄栏中正确换行。'.repeat(12), outcome: 'failed' }] : [] })) }
    const selected = scenario === 'long' ? long : scenario === 'stale' ? { ...long, stale: true, status: 'waiting', objective: '上一任务：对照两份资料并整理引用来源' } : current
    const content = scenario === 'waiting' ? uiGraph.renderTaskGraphSection(e, uiGraph.taskGraphPresentation(graph))
      : uiGraph.renderRunCenterPanel(e, {
        runCenter: { sessionId: 'fixture-session', status: 'ready', jobs: [], subagents: [], queue: [], skills: [], deliverables: [], taskGraph: selected,
          todos: scenario === 'stale' ? [{ id: 'new-todo', text: '整理本次资料的摘要', status: 'in_progress' }] : [] },
        taskGoal: '当前任务：整理新资料', surfaces: [], runtimeState: 'running', stopping: false, questionCount: 1, approvalCount: 0,
        contextView: uiGraph.contextPresentation(undefined), heartbeat: { status: '正常', detail: '', running: false }, onInteraction() {},
      })
    ReactDOM.flushSync(() => root.render(e('div', { className: 'xsla-shell', 'data-theme': theme },
      e('aside', { className: 'unified-workbench', 'data-workbench-active': 'task' }, e('div', { className: 'workbench-view insp-body' }, content)))))
  }
}

async function runHidden() {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', config.profile)
  await app.whenReady()
  const win = new BrowserWindow({ show: false, width: 420, height: 720, webPreferences: { sandbox: true } })
  try {
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/u.test(details.url) }))
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<style>' + config.css + '</style><div id="fixture"></div>'))
    await win.webContents.executeJavaScript(config.renderer)
    const failures = []
    for (const width of [248, 400]) for (const theme of ['light', 'ink-jade']) {
      win.setContentSize(width, 700)
      await win.webContents.executeJavaScript('drawGraph(' + JSON.stringify(theme) + ')')
      const reading = await win.webContents.executeJavaScript(`(()=>{
        const panel=document.querySelector('.unified-workbench'),view=document.querySelector('.workbench-view'),title=document.querySelector('[data-task-node] b');
        const dependency=document.querySelector('.task-graph-dependencies'),badge=document.querySelector('[data-task-node-status="interrupted"] span');
        return {panelWidth:panel.getBoundingClientRect().width,overflow:view.scrollWidth-view.clientWidth,titleWrap:title.getBoundingClientRect().height>20,
          dependency:dependency.textContent,badge:badge.textContent,badgeColor:getComputedStyle(badge).color,panelColor:getComputedStyle(panel).backgroundColor,
          graphState:panel.querySelector('.task-graph-state')?.textContent,waitingNote:panel.textContent.includes('节点状态为最近记录'),
          independent:panel.textContent.includes('独立验证'),details:panel.querySelectorAll('details').length}
      })()`)
      if (reading.panelWidth > width + 1 || reading.overflow > 1 || !reading.titleWrap || !reading.dependency.includes('这是一个')
        || reading.badge !== '已中断 · 待检查' || reading.graphState !== '等待检查' || !reading.waitingNote
        || reading.badgeColor === reading.panelColor || reading.independent || reading.details !== 2) failures.push({ width, theme, reading })
    }
    await win.webContents.executeJavaScript(`(()=>{const summary=document.querySelector('details>summary');summary.focus();return document.activeElement===summary&&!summary.parentElement.open})()`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await new Promise(resolve => setTimeout(resolve, 60))
    const keyboard = await win.webContents.executeJavaScript(`(()=>{const summary=document.querySelector('details>summary');return {open:summary.parentElement.open,focused:document.activeElement===summary,outline:getComputedStyle(summary).outlineStyle}})()`)
    if (!keyboard.open || !keyboard.focused) failures.push({ keyboard })
    for (const scenario of ['current', 'long', 'stale']) for (const width of [248, 400]) for (const theme of ['light', 'ink-jade']) {
      win.setContentSize(width, 700)
      await win.webContents.executeJavaScript(`drawGraph(${JSON.stringify(theme)},${JSON.stringify(scenario)})`)
      const reading = await win.webContents.executeJavaScript(`(()=>{
        const view=document.querySelector('.workbench-view'),graph=document.querySelector('[data-task-graph]'),interaction=document.querySelector('[data-task-interaction]');
        const history=document.querySelector('.task-graph-history'),more=document.querySelector('.task-graph-more'),todo=document.querySelector('[data-run-todo-id="new-todo"]');
        const visibleNodes=[...document.querySelectorAll('[data-task-node]')].filter(node=>!node.closest('details:not([open])'));
        return {overflow:view.scrollWidth-view.clientWidth,pendingFirst:interaction.getBoundingClientRect().top<graph.getBoundingClientRect().top,
          historyClosed:history?!history.open:null,todoBeforeHistory:todo&&history?todo.getBoundingClientRect().top<history.getBoundingClientRect().top:null,
          visibleNodes:visibleNodes.length,completedVisible:visibleNodes.some(node=>node.dataset.taskNodeStatus==='completed'),
          blockedVisible:visibleNodes.some(node=>node.dataset.taskNodeStatus==='blocked'),moreClosed:more?!more.open:null,
          feedbackPreview:document.querySelector('.task-graph-feedback>summary')?.textContent,
          currentFeedback:document.querySelector('.task-graph-current-feedback')?.textContent}
      })()`)
      if (reading.overflow > 1 || (scenario !== 'stale' && !reading.pendingFirst)
        || (scenario === 'stale' && (!reading.historyClosed || !reading.todoBeforeHistory || reading.visibleNodes !== 0))
        || (scenario === 'long' && (!reading.blockedVisible || reading.visibleNodes >= 24 || reading.completedVisible || !reading.moreClosed || !reading.currentFeedback?.includes('补充原始来源文件')))
        || !reading.feedbackPreview?.includes('先确认来源')) failures.push({ scenario, width, theme, reading })
      if (config.screenshots) {
        const fs = require('node:fs/promises'), path = require('node:path')
        await fs.mkdir(config.screenshots, { recursive: true })
        await fs.writeFile(path.join(config.screenshots, `${scenario}-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
      }
    }
    await win.webContents.executeJavaScript(`drawGraph('light','long');document.querySelector('.task-graph-more').open=true;drawGraph('light','long',4)`)
    const retained = await win.webContents.executeJavaScript(`document.querySelector('.task-graph-more').open`)
    if (!retained) failures.push('same-graph revision closed the expanded nodes')
    await win.webContents.executeJavaScript(`drawGraph('light','stale');document.querySelector('.task-graph-history>summary').focus()`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await new Promise(resolve => setTimeout(resolve, 60))
    const historyKeyboard = await win.webContents.executeJavaScript(`document.querySelector('.task-graph-history').open`)
    if (!historyKeyboard) failures.push('historical graph is not keyboard reachable')
    if (win.isVisible() || win.isFocused()) failures.push('renderer became visible or focused')
    if (failures.length) throw new Error(JSON.stringify(failures))
    console.log('TASK_GRAPH_RENDERER_PASS: narrow widths, light/dark states, wrapping and keyboard disclosure')
    win.destroy(); app.exit(0)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}

test('hidden renderer keeps task graph readable and keyboard accessible', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-task-graph-renderer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const css = (await Promise.all([
    ...['tokens', 'base', 'components', 'panels', 'observatory'].map(name => readFile(new URL('../ui/styles/' + name + '.css', import.meta.url), 'utf8')),
    readFile(new URL('../src/client/adapted.css', import.meta.url), 'utf8'),
  ])).join('\n')
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source + '\nexport { renderTaskGraphSection, renderRunCenterPanel };', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const react = await readFile(join(dirname(webRequire.resolve('react')), 'umd/react.production.min.js'), 'utf8')
  const reactDom = await readFile(join(dirname(webRequire.resolve('react-dom')), 'umd/react-dom.production.min.js'), 'utf8')
  const config = { profile: join(root, 'profile'), screenshots: process.env.XIAOSHE_TASK_GRAPH_SCREENSHOTS, css,
    renderer: react + '\n' + reactDom + '\n(()=>{const exports={};' + compiled + '\nwindow.uiGraph=exports;})();(' + installFixture.toString() + ')()' }
  const runner = join(root, 'runner.cjs')
  await writeFile(runner, 'const config=' + JSON.stringify(config) + ';(' + runHidden.toString() + ')()')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(desktopRequire('electron'), [runner], { env, windowsHide: true, timeout: 25_000 })
  assert.match(result.stdout, /TASK_GRAPH_RENDERER_PASS/u)
})
