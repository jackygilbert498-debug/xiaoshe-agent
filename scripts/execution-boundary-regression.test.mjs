import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/plugins/agent-reliability.js'

function harness(goal, root = '/owned/project') {
  const events = new Map(), messages = [], stops = []
  const names = ['bash', 'read', 'write', 'edit', 'todo_write', 'ask_user_question']
  apply({ systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: { schemas: () => names.map(name => ({ name, description: name, parameters: {} })), register: () => () => {} },
    on: (name, fn) => events.set(name, fn), effect: fn => fn() })
  const agent = { id: 'boundary-replay', session: { header: { cwd: root } }, steer: message => messages.push(message), cancel: cause => stops.push(cause) }
  const input = text => events.get('agent/inbox/claimed')({ agent, message: { id: crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  input(goal)
  let sequence = 0
  const execution = (name, args) => ({ agent, name, arguments: args, callId: `call-${++sequence}`, signal: new AbortController().signal })
  return { agent, events, messages, stops, input, execution,
    check: (name, args) => events.get('tools/pre-execute')(execution(name, args), async () => ({ kind: 'allow' })),
    read: async path => {
      const call = execution('read', { file_path: path })
      const decision = await events.get('tools/pre-execute')(call, async () => ({ kind: 'allow' }))
      assert.equal(decision.kind, 'allow')
      events.get('tools/result')(call, { isError: false, content: [{ type: 'text', text: 'actual existing implementation read' }] })
    },
  }
}

test('real discovery and CSS probes do not become source mutations', async () => {
  const h = harness('修改同名媒体工具的裁剪框颜色并验证效果。')
  for (const command of [
    'find . -iname "*media_sync*" -maxdepth 4 -not -path "*/node_modules/*" 2>/dev/null | head -50',
    'grep -n "crop-frame" app.css 2>/dev/null | head -20',
    'python3 -c "s=open(\'app.css\').read(); print(\'accent ->\', s.count(\'{\') > 0)"',
    'python3 - <<\'PY\'\ns=open("app.css").read()\nprint("accent ->",len(s)>0)\nPY',
  ]) assert.equal((await h.check('bash', { command })).kind, 'allow', command)
})

test('new preview output needs input evidence, not a read of a nonexistent file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xs-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'app.css'), '.crop{}')
  const h = harness('先读取需求、测试、脚本清单和当前实现，再修复当前项目的 app.css，最后建立预览运行测试验证。', root)
  await h.read(join(root, 'app.css'))
  assert.equal((await h.check('write', { file_path: join(root, 'preview.html'), content: '<p>preview</p>' })).kind, 'allow')
  await writeFile(join(root, 'untouched.html'), 'original')
  assert.equal((await h.check('write', { file_path: join(root, 'untouched.html'), content: 'changed' })).kind, 'deny')
})

test('requested project tests do not require user-authored command literals', async () => {
  const h = harness('修复 src/main.py，只允许修改 src/main.py，完成后运行项目测试验证。')
  for (const command of ['python3 -m pytest tests -q', 'npm run test', 'python3 --version', 'bash bin/offline.test.sh']) {
    assert.equal((await h.check('bash', { command, workdir: '/owned/project' })).kind, 'allow', command)
  }
  assert.equal((await h.check('bash', { command: 'python3 -m pytest tests -q', workdir: '/other' })).kind, 'deny')
  assert.equal((await h.check('bash', { command: 'cd "nested tool" && python3 -m pytest tests -q' })).kind, 'allow')
  assert.equal((await h.check('bash', { command: 'cd ../other && python3 -m pytest tests -q' })).kind, 'deny')
  assert.equal((await h.check('bash', { command: 'python3 -m pytest tests -q; rm src/main.py' })).kind, 'deny')
  assert.equal((await h.check('bash', { command: 'echo changed > other.py' })).kind, 'deny')
})

test('explicit no-write and no-network requirements are not overridden by test labels', async () => {
  for (const goal of ['不得进行任何修改，检查现有文件并运行测试。', '只修改 src/main.py，不联网，运行测试。']) {
    const h = harness(goal)
    assert.equal((await h.check('bash', { command: 'python3 -m pytest tests -q' })).kind, 'deny', goal)
  }
})

test('test cwd symlinks and traversal operands cannot escape the task workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xs-test-cwd-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'project')); await mkdir(join(root, 'outside'))
  await symlink(join(root, 'outside'), join(root, 'project', 'linked'))
  const h = harness('只修改 app.css，运行项目测试。', join(root, 'project'))
  assert.equal((await h.check('bash', { command: 'python3 -m pytest tests -q', workdir: 'linked' })).kind, 'deny')
  for (const command of ['python3 -m pytest tests/../../outside', 'node --test --import ./other.mjs', 'npm run test --prefix=C:\\outside']) {
    assert.equal((await h.check('bash', { command })).kind, 'deny', command)
  }
})

test('delegated source-preservation scope permits tests but not source edits', async () => {
  const h = harness('运行 Python 测试套件并回报原始输出。pytest 产生 __pycache__ / .pytest_cache 是可接受的。不要修改源文件 app.css、index.html 和 tests/test_frontend_contract.py，只运行测试。')
  assert.equal((await h.check('bash', { command: 'python3 -m pytest tests -q', workdir: '/owned/project' })).kind, 'allow')
  assert.equal((await h.check('edit', { file_path: 'app.css', old_string: 'a', new_string: 'b' })).kind, 'deny')
  const actual = harness('运行 Python 测试套件并回报原始输出。pytest 产生 __pycache__ / .pytest_cache 是可接受的。不要修改任何源文件（app.css / index.html / app.js / tests/*.py 都不要改动），只运行测试。')
  assert.equal((await actual.check('bash', { command: 'python3 -m pytest tests -q' })).kind, 'allow')
  for (const file_path of ['app.css', 'index.html', 'app.js', 'tests/test_frontend_contract.py']) {
    assert.equal((await actual.check('edit', { file_path, old_string: 'a', new_string: 'b' })).kind, 'deny', file_path)
  }
  for (const command of ['echo pytest', 'python3 -c "print(\'pytest\')"', 'python3 -m pytest --basetemp=/other', 'npm run test --prefix /other']) {
    assert.equal((await h.check('bash', { command })).kind, 'deny', command)
  }
})

test('persistent scope refusals stay denied without cancelling authorized recovery', async () => {
  const h = harness('只允许修改 src/main.py；完成后验证。')
  for (let n = 0; n < 5; n++) assert.equal((await h.check('bash', { command: `python3 -c "print(${n})"` })).kind, 'deny')
  assert.equal(h.messages.length, 0)
  assert.equal(h.stops.length, 0)
  assert.equal((await h.check('bash', { command: 'python3 --version' })).kind, 'allow')
  h.input('换个任务：解释这段文字。')
  assert.equal((await h.check('bash', { command: 'python3 --version' })).kind, 'allow')
  assert.equal(h.stops.length, 0)
})
