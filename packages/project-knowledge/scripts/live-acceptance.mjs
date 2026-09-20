/** Opt-in paid, synthetic multi-file acceptance. No running Xiaoshe Profile is changed.
 * Tests this plugin in the real Cordis prompt/settings stack, not the full desktop/DSH agent loop.
 */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, mkdir, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { parse } from 'yaml'
import { Context } from '../../../runtime/DSH/vendor/cordis/lib/index.js'
import { FileSettingsProvider } from '../../../runtime/DSH/packages/settings/settings-file/lib/index.js'
import SystemPrompt, { renderPrompt, renderContextSections } from '../../../runtime/DSH/packages/core/system-prompt/lib/index.js'
import * as knowledge from '../lib/index.js'
import { readSource } from '../lib/source.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
if (!process.argv.includes('--live')) throw new Error('Explicit --live required: uses the existing DeepSeek credential on synthetic fixtures only')
const model = process.env.XS_KNOWLEDGE_TEST_MODEL ?? 'deepseek-flash'
if (!/^[a-z0-9.-]{1,80}$/u.test(model)) throw new Error('Invalid model')
const runId = randomUUID()
const directory = await mkdtemp(join(tmpdir(), 'xs-knowledge-live-'))
const workspace = join(directory, 'workspace'), settingsFile = join(directory, 'settings.json')
await mkdir(workspace)
await writeFile(settingsFile, '{}')
const fixtures = {
  'config.ts': 'export const RETRY_LIMIT = 3;\n',
  'queue.ts': 'import { run } from "./worker";\nconst queues = new Map<string, Promise<unknown>>();\nexport function enqueue(workspace: string, task: () => Promise<boolean>, signal: AbortSignal) {\n const before = queues.get(workspace) ?? Promise.resolve();\n const next = before.catch(() => undefined).then(() => run(task, signal));\n queues.set(workspace, next); return next;\n}\n',
  'worker.ts': 'import { RETRY_LIMIT } from "./config";\nexport async function run(task: () => Promise<boolean>, signal: AbortSignal) {\n for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {\n  if (signal.aborted) return { status: "cancelled", attempts: attempt };\n  if (await task()) return { status: "done", attempts: attempt + 1 };\n }\n return { status: "failed", attempts: RETRY_LIMIT };\n}\n',
  'unrelated.ts': 'export const theme = "neutral";\n',
}
for (const [path, text] of Object.entries(fixtures)) await writeFile(join(workspace, path), text)
const report = { runId, model, scope: 'real-model + real-Cordis knowledge plugin; NOT full desktop/harness acceptance', phases: [], requests: 0, passed: false }
let ctx, key
const secretFile = join(process.env.USERPROFILE ?? process.env.HOME, '.dsh', '.credentials.yaml')
const secretStat = await lstat(secretFile)
if (!secretStat.isFile() || secretStat.isSymbolicLink() || secretStat.size > 1_048_576) throw new Error('Unsafe credential file')
key = parse(await readFile(secretFile, 'utf8'))?.refs?.DEEPSEEK_API_KEY
if (typeof key !== 'string' || !key.trim()) throw new Error('Existing official DeepSeek key missing')
const requestSignal = AbortSignal.timeout(600_000)
let definitions
async function startHost() {
  ctx = new Context(); definitions = new Map()
  ctx.provide('tools', { register(tool) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } })
  await ctx.plugin(FileSettingsProvider, { path: settingsFile, watch: false })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(knowledge)
}
async function toggle(enabled) {
  const settings = ctx.get('xiaosheProjectKnowledge', false).settings, snapshot = settings.getSnapshot()
  await settings.replace({ ...snapshot.value, enabled }, snapshot.revision)
}
const ordinary = [
  { name: 'list_sources', description: '列出此测试项目的源码路径。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'read_source', description: '读取此项目的一个源码文件以确认实际行为。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
]
async function phase(name, goal, { allowKnowledge = true, expected } = {}) {
  const started = performance.now(), phase = { name, tools: [], requests: 0, inputTokens: 0, outputTokens: 0 }
  report.phases.push(phase)
  const message = { source: { kind: 'user' }, content: [{ type: 'text', text: goal }] }
  const agent = { id: `${runId}-${name}`, session: { header: { cwd: workspace }, events: [{ type: 'user/message', data: message }] } }
  const history = [{ role: 'user', content: goal }]
  const available = [...ordinary, ...(allowKnowledge ? [...definitions.values()] : [])]
  const tools = available.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
  for (let step = 0; step < 8; step++) {
    if (++report.requests > 32) throw new Error('request budget exhausted')
    phase.requests++
    const assembly = await ctx.systemPrompt.assemble({ agent, signal: requestSignal })
    const contexts = renderContextSections(assembly).map(row => row.text).join('\n')
    phase.contextChars = contexts.length
    const messages = [{ role: 'system', content: `${renderPrompt(assembly)}\n你正在处理隔离测试项目。先根据证据理解再回答，必要时读源码核实。不要捏造成功，不修改源文件，不要求用户完成你可做的工作。` },
      ...(contexts ? [{ role: 'user', content: `以下是参考资料：\n${contexts}` }] : []), ...history]
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0, max_tokens: 1400, thinking: { type: 'disabled' }, stream: false }),
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(90_000)]),
    })
    if (!response.ok) throw new Error(`provider HTTP ${response.status}`)
    const json = await response.json(), answer = json.choices?.[0]?.message
    if (!answer) throw new Error('provider missing answer')
    if (json.choices[0].finish_reason === 'length') throw new Error(`truncated answer in ${name}`)
    phase.inputTokens += json.usage?.prompt_tokens ?? 0
    phase.outputTokens += json.usage?.completion_tokens ?? 0
    const publicAnswer = { role: 'assistant', content: answer.content ?? null, ...(answer.tool_calls ? { tool_calls: answer.tool_calls } : {}) }
    history.push(publicAnswer)
    if (!answer.tool_calls?.length) {
      phase.answer = answer.content ?? ''; phase.durationMs = Math.round(performance.now() - started)
      if (expected) assert.match(phase.answer, expected)
      console.log(JSON.stringify({ phase: name, requests: phase.requests, tools: phase.tools.length, status: 'completed' }))
      return phase
    }
    for (const call of answer.tool_calls) {
      const args = JSON.parse(call.function.arguments), toolName = call.function.name
      let value
      if (!available.some(tool => tool.name === toolName)) throw new Error('model called unavailable tool')
      if (toolName === 'list_sources') value = { files: Object.keys(fixtures) }
      else if (toolName === 'read_source') value = await readSource(workspace, args.path, requestSignal)
      else value = await definitions.get(toolName).execute(args, { agent, signal: requestSignal })
      phase.tools.push({ name: toolName, ok: value.ok ?? true, ...(value.error_code ? { error_code: value.error_code } : {}), ...(toolName === 'read_source' ? { path: args.path } : {}) })
      history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(value) })
    }
  }
  throw new Error(`phase step limit: ${name}`)
}

try {
  await startHost()
  const question = '请追踪这个项目从排队到执行的完整流程：同工作区与不同工作区如何并发、失败最多尝试几次、什么时候检查取消、signal是否实际传给task函数。如果要把最大尝试次数改为7，应该改哪一处并做哪些边界测试？根据源码分析，不要修改。最终只输出JSON（不包代码块）：{"sameWorkspace":"serial或parallel","differentWorkspace":"serial或parallel","maxAttempts":数字,"signalPassedToTask":布尔值,"configFile":"文件名","changeFiles":["文件名"],"cancelAt":"简述检查点","tests":["至少三个简短边界测试"]}。'
  const checkFacts = phase => {
    const answer = JSON.parse(phase.answer.trim().replace(/^```json\s*|\s*```$/gu, ''))
    assert.equal(answer.sameWorkspace, 'serial'); assert.equal(answer.differentWorkspace, 'parallel')
    assert.equal(answer.maxAttempts, 3); assert.equal(answer.signalPassedToTask, false)
    assert.equal(answer.configFile, 'config.ts'); assert.deepEqual(answer.changeFiles, ['config.ts'])
    assert.ok(Array.isArray(answer.tests) && answer.tests.length >= 3)
    phase.factsChecked = true
  }
  await toggle(false)
  const baseline = await phase('baseline', question, { allowKnowledge: false, expected: /3|三/u })
  checkFacts(baseline)
  assert.ok(baseline.tools.some(tool => tool.name === 'read_source' && tool.path === 'worker.ts'))
  await toggle(true)
  await phase('learn', '请先用 inspect 一次读取 queue.ts、worker.ts、config.ts（这个顺序），然后基于正文为 queue.ts 保存一条项目概览知识，列清工作区串行、重试上限、取消时点和真实依赖。save成功后停止，说明保存边界。不要只回复摘要，实际调用工具。')
  assert.equal(ctx.get('xiaosheProjectKnowledge', false).settings.getSnapshot().value.entries.length, 1)
  await ctx.fiber.dispose(); await startHost()
  const resumed = await phase('resumed-with-knowledge', question, { expected: /3|三/u })
  checkFacts(resumed)
  assert.ok(resumed.contextChars > 0)
  await writeFile(join(workspace, 'config.ts'), 'export const RETRY_LIMIT = 7;\n')
  const stale = await ctx.get('xiaosheProjectKnowledge', false).service.query({ cwd: workspace })
  assert.equal(stale.entries.length, 0); assert.equal(stale.stale, 1)
  const changed = await phase('dependency-changed', '现在实际源码中最大尝试次数是多少？请核对源码给出具体数字和定义文件，不沿用旧资料，也不修改。', { expected: /7|七/u })
  assert.ok(changed.tools.some(tool => (tool.name === 'read_source' && tool.path === 'config.ts') || tool.name === 'xiaoshe_knowledge_inspect'))
  const refreshed = await phase('refresh', '源码 config.ts 已变化。请 inspect queue.ts、worker.ts、config.ts，再依据当前正文和 existing.version 更新原有概览知识（不要新建另一条）。保存后停止。最终只输出JSON，不包代码块：{"previousVersion":更新前版本,"savedVersion":保存后版本,"changedSources":["inspect判断有变化的文件"],"priorSourceMatched":旧记录来源是否与本次读取一致的布尔值,"maxAttempts":当前最大尝试次数}。区分inspect的更新前证据和save刚写入的新内容。')
  const refreshedFacts = JSON.parse(refreshed.answer.trim().replace(/^```json\s*|\s*```$/gu, ''))
  assert.deepEqual(refreshedFacts, { previousVersion: 1, savedVersion: 2, changedSources: ['config.ts'], priorSourceMatched: false, maxAttempts: 7 })
  refreshed.factsChecked = true
  const updated = ctx.get('xiaosheProjectKnowledge', false).settings.getSnapshot().value.entries
  assert.equal(updated.length, 1); assert.equal(updated[0].version, 2)
  await toggle(false)
  const disabled = await phase('disabled-normal-tools', '读取当前 config.ts 告诉我实际 RETRY_LIMIT。只需核实回答，不修改。', { expected: /7|七/u })
  assert.ok(disabled.tools.some(tool => tool.name === 'read_source'))
  report.passed = true
} catch (error) {
  report.failure = { code: error.code ?? error.cause?.code ?? error.name, message: String(error.message).replaceAll(key, '[REDACTED]').slice(0, 300) }
  process.exitCode = 1
} finally {
  key = undefined
  await ctx?.fiber.dispose()
  const output = join(root, 'output', 'project-knowledge')
  await mkdir(output, { recursive: true })
  const path = join(output, `live-${runId}.json`)
  await writeFile(path, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, requests: report.requests, report: path, failure: report.failure }))
  // The exact path was returned by mkdtemp and contains synthetic data only.
  await rm(directory, { recursive: true, force: true })
}
