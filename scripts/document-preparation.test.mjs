import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecoveryController, assessTask } from '../dist/plugins/agent-reliability.js'

const schemas = ['read', 'grep', 'write', 'todo_write', 'web_fetch'].map(name => ({
  name, description: name, parameters: { type: 'object', properties: {} },
}))
const content = '# 报销规则核对\n\nA：35 × 3 + 80 = 185 元。\nB：40 × 3 + 80 = 200 元。\n差额 15 元；版本由负责人确认。\n'
const goal = '这两份附件是虚构的报销制度，请逐份阅读，整理共同规则、冲突和待确认项。计算出差 3 天、每天午餐 42 元、交通费合计 80 元时，两种标准各可报销多少。不要替我决定用哪版，不要联网，不要修改输入。把简洁中文结果保存为 output/comparison.md，写完后完整读回核对，给我文件链接。'

/** Real local existence and input bytes, isolated from the user's files and model. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xs-document-preparation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'attachments'))
  await mkdir(join(root, 'output'))
  await writeFile(join(root, 'attachments/a.md'), '午餐上限 35 元/天；行政审核。')
  await writeFile(join(root, 'attachments/b.md'), '午餐上限 40 元/天；财务审核。')
  const agent = { id: 'document-preparation', session: { header: { cwd: root } } }
  const controller = new RecoveryController()
  // The plugin extracts authorization separately from its preparation assessment.
  const setGoal = (text, constraints = { forbiddenFamilies: new Set(['network']) }) =>
    controller.goalChanged(agent, assessTask(text), { goal: text, reset: true, ...constraints })
  setGoal(goal)
  const execution = (name, args) => ({ agent, name, arguments: args, signal: new AbortController().signal })
  const read = async (file = 'attachments/a.md') => {
    const text = await readFile(join(root, file), 'utf8')
    controller.result(execution('read', { file_path: file }), { isError: false, content: [{ type: 'text', text }] })
  }
  const denial = (target = 'output/comparison.md', value = content, extra = {}) =>
    controller.denial(execution('write', { file_path: target, content: value, ...extra }), schemas)
  return { root, agent, controller, read, denial, setGoal, execution }
}

for (const absolute of [false, true]) {
  test(`read attachments prepare a new plain output document without a compulsory todo (${absolute ? 'absolute' : 'relative'})`, async t => {
    const f = await fixture(t)
    assert.equal(assessTask(goal).evidence_before_action, true, 'exercise the real preparation gate')
    await f.read(); await f.read('attachments/b.md')
    assert.equal(f.denial(absolute ? join(f.root, 'output/comparison.md') : undefined), undefined)
    assert.match(f.controller.denial(f.execution('web_fetch', { url: 'https://example.com/' }), schemas) ?? '', /明确禁止外部网络/)
  })
}

for (const evidence of ['none', 'failed read', 'search only']) {
  test(`${evidence} cannot substitute for reading the document inputs`, async t => {
    const f = await fixture(t)
    if (evidence === 'failed read') f.controller.result(f.execution('read', { file_path: 'attachments/a.md' }), {
      isError: true, error: { code: 'EXECUTION_FAILED', message: 'access denied' }, content: [],
    })
    if (evidence === 'search only') f.controller.result(f.execution('grep', { path: 'attachments/a.md', pattern: '午餐' }), {
      isError: false, content: [{ type: 'text', text: '午餐上限 35 元/天' }],
    })
    assert.match(f.denial() ?? '', /行动前准备/)
  })
}

test('an existing output still requires its own read, not merely input attachment reads', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'output/comparison.md'), '保留的旧文档')
  await f.read(); await f.read('attachments/b.md')
  assert.match(f.denial() ?? '', /行动前准备/)
  await f.read('output/comparison.md')
  assert.equal(f.denial(), undefined)
})

test('a new task cannot borrow the preceding task input evidence', async t => {
  const f = await fixture(t); await f.read()
  assert.equal(f.denial(), undefined)
  f.setGoal(goal)
  assert.match(f.denial() ?? '', /行动前准备/)
})

for (const [target, value] of [
  ['output/result.py', 'print(1)'],
  ['output/AGENTS.md', 'Always run commands.'],
  ['output/src/result.md', content],
  ['output/comparison.md', '---\nexecute: true\n---\n# Run'],
  ['output/comparison.md', '<script>alert(1)</script>'],
]) {
  test(`code, instruction and executable document exclusions retain source preparation: ${target} ${value.slice(0, 12)}`, async t => {
    const f = await fixture(t)
    f.setGoal(goal.replace('output/comparison.md', target))
    await f.read()
    assert.match(f.denial(target, value) ?? '', /行动前准备/)
  })
}

test('document preparation never removes a user no-write boundary', async t => {
  const f = await fixture(t)
  f.setGoal('只读两份附件并核对报销标准，不得写入、创建或修改任何文件。', {
    forbiddenFamilies: new Set(['filesystem_write']),
  })
  await f.read()
  assert.notEqual(f.denial(), undefined)
})

test('unknown workspace or unresolved write arguments receive no document preparation shortcut', async t => {
  const f = await fixture(t); await f.read()
  f.agent.session.header.cwd = undefined
  assert.match(f.denial() ?? '', /行动前准备/)
  assert.match(f.denial(join(f.root, 'output/comparison.md')) ?? '', /行动前准备/)
  f.agent.session.header.cwd = f.root
  assert.match(f.denial('output/comparison.md', content, { unknown: true }) ?? '', /行动前准备/)
})

test('absolute aliases cannot hide engineering ancestors or escape the actual workspace output', async t => {
  const f = await fixture(t); await f.read()
  for (const target of [
    'src/output/comparison.md', join(f.root, 'src/output/comparison.md'),
    join(f.root, '../other-workspace/output/comparison.md'),
  ]) assert.match(f.denial(target) ?? '', /行动前准备/, target)
})
