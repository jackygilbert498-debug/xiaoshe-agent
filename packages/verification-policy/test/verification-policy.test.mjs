import assert from 'node:assert/strict'
import test from 'node:test'
import { createVerificationPolicy } from '../lib/index.js'

test('JSONL edits use data proof gates; embedded script syntax never invents code gates', () => {
  const policy = createVerificationPolicy()
  for (const toolName of ['edit', 'write']) {
    const classified = policy.classifyTool({ toolName, arguments: { file_path: '/data/records.jsonl' } })
    assert.equal(classified.change.kind, 'data')
    assert.deepEqual(policy.planTool({ toolName, ...classified.change }).gates, ['functional-probe'])
  }
  for (const risk of ['low', 'medium', 'high']) assert.deepEqual(policy.plan({ kind: 'data', risk }).gates, ['functional-probe'])
  for (const file_path of ['/data/src/a.jsonl', '/data/package.jsonl', '/data/a.ts']) {
    assert.equal(policy.classifyTool({ toolName: 'edit', arguments: { file_path } }).change.kind, 'code')
  }
  for (const command of ["python3 <<'PY'\nif n > 0: save()\nPY", "node <<'JS'\nconst f = x => x;\nJS", 'echo x > a.jsonl\nother-command']) {
    assert.deepEqual(policy.classifyTool({ toolName: 'bash', arguments: { command } }), { mutation: true })
  }
})

test('the latest result for one gate supersedes an older attempt', () => {
  const policy = createVerificationPolicy()
  const plan = policy.plan({ kind: 'code', risk: 'low' })
  assert.equal(policy.evaluate(plan, [
    { gate: 'typecheck', status: 'failed' },
    { gate: 'typecheck', status: 'passed' },
    { gate: 'test', status: 'passed' },
  ]), 'verified')
  assert.equal(policy.evaluate(plan, [
    { gate: 'typecheck', status: 'passed' },
    { gate: 'typecheck', status: 'failed' },
    { gate: 'test', status: 'passed' },
  ]), 'failed')
})

test('missing gates remain partial and evidence gates remain strict', () => {
  const policy = createVerificationPolicy()
  const code = policy.plan({ kind: 'code', risk: 'low' })
  assert.equal(policy.evaluate(code, [{ gate: 'test', status: 'passed' }]), 'partial')
  const ui = policy.plan({ kind: 'ui', risk: 'low' })
  assert.equal(policy.evaluate(ui, [
    { gate: 'typecheck', status: 'passed' },
    { gate: 'test', status: 'passed' },
    { gate: 'browser', status: 'passed' },
  ]), 'partial')
})

test('external UI actions use reachable postcondition gates rather than code-build gates', () => {
  const policy = createVerificationPolicy()
  assert.deepEqual(
    policy.planTool({ toolName: 'screen_click', kind: 'windows', risk: 'high' }).gates,
    ['windows-evidence'],
  )
  assert.deepEqual(
    policy.planTool({ toolName: 'screen_focus_window', kind: 'windows', risk: 'high' }).gates,
    ['windows-evidence'],
  )
  assert.deepEqual(
    policy.planTool({ toolName: 'browser_press', kind: 'ui', risk: 'medium' }).gates,
    ['browser'],
  )
  assert.deepEqual(
    policy.planTool({ toolName: 'write', kind: 'code', risk: 'medium' }).gates,
    ['typecheck', 'test', 'build'],
  )
})

test('tool classification separates read-only shell probes from known and unknown mutations', () => {
  const policy = createVerificationPolicy()
  for (const command of [
    'rg --files',
    'git status --short',
    'git diff --check',
    'npm run test',
    'node --test test/example.test.mjs',
  ]) assert.deepEqual(
    policy.classifyTool({ toolName: 'pwsh', arguments: { command } }),
    { mutation: false },
    command,
  )

  for (const command of [
    "Set-Content -LiteralPath 'src/a.ts' -Value 'changed'",
    'npm install left-pad',
    'git add src/a.ts',
    'echo changed > src/a.ts',
  ]) assert.deepEqual(
    policy.classifyTool({ toolName: 'pwsh', arguments: { command } }),
    { mutation: true, change: { kind: 'code', risk: 'medium' } },
    command,
  )

  assert.deepEqual(
    policy.classifyTool({ toolName: 'pwsh', arguments: { command: 'Invoke-CustomOperation' } }),
    { mutation: true },
  )
})

test('str_replace_editor classifies view as observation and edit commands as mutations', () => {
  const policy = createVerificationPolicy()
  assert.deepEqual(
    policy.classifyTool({ toolName: 'str_replace_editor', arguments: { command: 'view', path: 'C:\\workspace\\a.ts' } }),
    { mutation: false },
  )
  for (const command of ['create', 'str_replace', 'insert']) assert.deepEqual(
    policy.classifyTool({ toolName: 'str_replace_editor', arguments: { command, path: 'C:\\workspace\\a.ts' } }),
    { mutation: true, change: { kind: 'code', risk: 'medium' } },
    command,
  )
})

test('memory writes require a target-specific readback while memory listing stays read-only', () => {
  const policy = createVerificationPolicy()
  for (const toolName of ['xiaoshe_memory_remember', 'xiaoshe_memory_set_state']) {
    const classification = policy.classifyTool({ toolName, arguments: {} })
    assert.deepEqual(classification, {
      mutation: true,
      change: { kind: 'persistence', risk: 'high' },
    })
    assert.deepEqual(policy.planTool({ toolName, ...classification.change }).gates, ['functional-probe'])
  }
  assert.deepEqual(
    policy.classifyTool({ toolName: 'xiaoshe_memory_list', arguments: { scope: 'all' } }),
    { mutation: false },
  )
})

test('a complete static JSON write uses data readback gates without weakening project configuration', () => {
  const policy = createVerificationPolicy()
  const content = JSON.stringify({ city: '上海', temperature: 27, raining: false })

  for (const file_path of [
    'output/delivery.json',
    'output/acceptance/weather-result.json',
    'output\\data\\cities.json',
    'C:\\workspace\\output\\acceptance\\live-result.json',
    '/workspace/output/acceptance/live-result.json',
  ]) {
    const classification = policy.classifyTool({ toolName: 'write', arguments: { file_path, content } })
    assert.deepEqual(classification, {
      mutation: true,
      change: { kind: 'data', risk: 'low' },
    }, file_path)
    assert.deepEqual(
      policy.planTool({ toolName: 'write', ...classification.change }).gates,
      ['functional-probe'],
      file_path,
    )
  }

  for (const file_path of [
    'delivery.json',
    'artifacts/weather-result.json',
    'public/data/cities.json',
    'package.json',
    'tsconfig.build.json',
    '.vscode/settings.json',
    'config/runtime.json',
    'src/catalog.json',
    'runtime/profile.json',
    'plugins/weather/plugin.json',
    '.codex-plugin/plugin.json',
    'output/package.json',
    'output/tsconfig.build.json',
    'output/config/runtime.json',
    'output/src/catalog.json',
    'output/test/fixture.json',
    'output/.git/state.json',
    'output/.openai/hosting.json',
    'output/pnpm-lock.json',
    'output/../delivery.json',
    'output/report.json:shadow.json',
    '\\\\?\\C:\\workspace\\output\\report.json',
    '\\\\server\\share\\output\\report.json',
  ]) assert.deepEqual(
    policy.classifyTool({ toolName: 'write', arguments: { file_path, content } }),
    { mutation: true, change: { kind: 'code', risk: 'medium' } },
    file_path,
  )

  assert.deepEqual(
    policy.classifyTool({ toolName: 'write', arguments: { file_path: 'output/delivery.json', content: '{invalid' } }),
    { mutation: true, change: { kind: 'code', risk: 'medium' } },
    'invalid JSON must fail closed as a code mutation',
  )
  assert.deepEqual(
    policy.classifyTool({
      toolName: 'edit',
      arguments: { file_path: 'output/delivery.json', old_string: '27', new_string: '28' },
    }),
    { mutation: true, change: { kind: 'code', risk: 'medium' } },
    'partial edits do not carry the complete post-write value and must stay fail closed',
  )
  for (const [toolName, args] of [
    ['write_file', { path: 'output/delivery.json', content }],
    ['file_write', { file: 'output/delivery.json', content }],
    ['create_file', { filename: 'output/delivery.json', content }],
    ['write', { file_path: 'output/delivery.json', content, mode: 'append' }],
  ]) assert.deepEqual(
    policy.classifyTool({ toolName, arguments: args }),
    { mutation: true, change: { kind: 'code', risk: 'medium' } },
    `${toolName} must not inherit the first-party whole-file write exception`,
  )
})
