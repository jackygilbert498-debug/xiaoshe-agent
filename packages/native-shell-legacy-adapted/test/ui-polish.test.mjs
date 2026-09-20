import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source + '\nexport { renderInspector as testInspector };', { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const app = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('wide workbench reserves a readable conversation instead of spending saved width', () => {
  assert.equal(app.browserDockWidth(900, 1197), 623)
  assert.equal(app.workSurfaceDockWidth(900, 1197), 623)
  assert.equal(app.workbenchPanelWidth('task', { task: 400 }, 920), 346)
  assert.equal(app.workSurfaceDockWidth(Number.NaN, 1197), 420)
})

test('assistant updates are distinguished using subsequent actions, never private reasoning', () => {
  const items = [
    { key: 'u', kind: 'user', text: '核对资料' },
    { key: 'a', kind: 'assistant', text: '正在核对', reasoning: 'PRIVATE' },
    { key: 't', kind: 'tool', text: 'read' },
    { key: 'b', kind: 'assistant', text: '核对结果' },
    { key: 'u2', kind: 'user', text: '继续' },
    { key: 'partial', kind: 'assistant', text: '收到' },
  ]
  const phases = app.conversationMessagePhases(items)
  assert.deepEqual([...phases], [['a', 'progress'], ['b', 'reply'], ['partial', 'responding']])
  assert.equal(items[1].text, '正在核对')
})

test('completion gaps expose only recorded evidence and keep unknown distinct from success', () => {
  assert.deepEqual(app.completionGaps({ unverified: ['尚未核对原件', '', '尚未核对原件', 42] }), ['尚未核对原件'])
  assert.deepEqual(app.completionGaps({}), [])
  assert.deepEqual(app.completionGaps(undefined), [])
  assert.deepEqual(app.completionGaps({ unverified: 'bad payload' }), [])
  assert.equal(app.verificationGapPresentation('verified', []), undefined)
  assert.deepEqual(app.verificationGapPresentation('cancelled', ['执行影响未验证']), { gaps: ['执行影响未验证'] })
  assert.match(app.verificationGapPresentation('partial', []).detail, /不能视为验证通过/)
})

test('compact native browser is a reading drawer, not an occluding modal', () => {
  const e = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const base = {
    surfaces: [], runtimeState: 'idle', stopping: false, questionCount: 0, approvalCount: 0,
    collapsed: false, overlayOpen: true, receipt: 'verified',
    contextView: app.contextPresentation(undefined),
    heartbeat: { status: '正常', detail: '', running: false },
    runCenter: { status: 'ready', jobs: [], subagents: [], queue: [], todos: [], skills: [], deliverables: [] },
    browserAvailable: true, materialCount: 0,
  }
  const browser = app.testInspector(e, { ...base, view: 'browser' })
  assert.equal(browser.props['aria-modal'], undefined, 'otherwise BrowserDock correctly hides itself as modal-present')
  assert.equal(browser.props.role, 'complementary')
  assert.equal(app.testInspector(e, { ...base, view: 'materials' }).props['aria-modal'], 'true')
})
