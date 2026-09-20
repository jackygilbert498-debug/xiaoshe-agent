import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '../../../runtime/DSH/vendor/cordis/lib/index.js'
import { FileSettingsProvider } from '../../../runtime/DSH/packages/settings/settings-file/lib/index.js'
import SystemPrompt from '../../../runtime/DSH/packages/core/system-prompt/lib/index.js'
import * as plugin from '../lib/index.js'

async function host(t, filename) {
  const ctx = new Context(), definitions = new Map()
  ctx.provide('tools', { register(tool) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } })
  await ctx.plugin(FileSettingsProvider, { path: filename, watch: false })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(plugin)
  t.after(() => ctx.fiber.dispose())
  return { ctx, definitions }
}
test('real host assembles only source-valid user-role knowledge, live toggle and suppression stay authoritative', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xs-knowledge-host-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'settings.json'), '{}')
  await writeFile(join(dir, 'queue.ts'), 'export const ordering = "fifo"\n')
  const { ctx, definitions } = await host(t, join(dir, 'settings.json'))
  assert.equal(definitions.size, 4)
  const agent = { id: 'user-session', session: { header: { cwd: dir }, events: [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '说明消息队列' }] } }] } }
  const execution = { agent, signal: new AbortController().signal }
  const inspection = await definitions.get('xiaoshe_knowledge_inspect').execute({ paths: ['queue.ts'] }, execution)
  assert.equal(inspection.ok, true)
  assert.equal(inspection.saveArgs.expectedVersion, 0)
  assert.equal(inspection.saveArgs.receipt, inspection.receipt)
  assert.ok(!Object.hasOwn(definitions.get('xiaoshe_knowledge_save').parameters.properties, 'id'))
  const inventedId = await definitions.get('xiaoshe_knowledge_save').execute({ id: 'queue.ts' }, execution)
  assert.equal(inventedId.error_code, 'INVALID_ARGUMENTS')
  assert.match(inventedId.recovery, /saveArgs/u)
  const result = await definitions.get('xiaoshe_knowledge_save').execute({ receipt: inspection.receipt, expectedVersion: 0,
    document: { title: '消息队列', purpose: '先进先出，确保用户消息按发送顺序执行。', interfaces: ['ordering'], relations: [], constraints: [], overview: false } }, execution)
  assert.equal(result.ok, true)
  const assembly = await ctx.systemPrompt.assemble({ agent })
  const knowledge = assembly.contexts.find(row => row.name === 'xiaoshe:project-knowledge')
  assert.match(knowledge.text, /先进先出/u)
  assert.ok(!assembly.sections.some(row => row.text.includes('先进先出')))
  await writeFile(join(dir, 'queue.ts'), 'export const ordering = "priority"\n')
  assert.doesNotMatch(JSON.stringify((await ctx.systemPrompt.assemble({ agent })).contexts), /先进先出/u)
  const unchangedTools = definitions.size
  const invalid = await definitions.get('xiaoshe_knowledge_inspect').execute({ paths: ['../outside'] }, execution)
  assert.equal(invalid.ok, false)
  assert.equal(definitions.size, unchangedTools)
  assert.equal(typeof invalid.recovery, 'string')
  const scope = ctx.get('xiaosheProjectKnowledge', false).settings
  await scope.replace({ ...scope.getSnapshot().value, enabled: false }, scope.getSnapshot().revision)
  assert.ok(!(await ctx.systemPrompt.assemble({ agent })).contexts.some(row => row.name === 'xiaoshe:project-knowledge'))
  assert.equal((await definitions.get('xiaoshe_knowledge_inspect').execute({ paths: ['queue.ts'] }, execution)).error_code, 'DISABLED')
  assert.equal((await definitions.get('xiaoshe_knowledge_query').execute({}, execution)).error_code, 'DISABLED')
  await scope.replace({ ...scope.getSnapshot().value, enabled: true }, scope.getSnapshot().revision)
  const dispose = ctx.systemPrompt.suppressRuntimeContext()
  assert.deepEqual((await ctx.systemPrompt.assemble({ agent })).contexts, [])
  dispose()
})

test('same-turn writes cannot retroactively become prior knowledge; next user message may use the new version', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xs-knowledge-turn-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'settings.json'), '{}')
  await writeFile(join(dir, 'config.ts'), 'export const attempts = 3;')
  const { ctx, definitions } = await host(t, join(dir, 'settings.json'))
  const event = seq => ({ type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '核对重试次数' }] } })
  const agent = { id: 'one-agent', session: { header: { cwd: dir }, events: [event(1)] } }
  const execution = { agent, signal: new AbortController().signal }
  const inspect = () => definitions.get('xiaoshe_knowledge_inspect').execute({ paths: ['config.ts'] }, execution)
  const save = async purpose => {
    const read = await inspect()
    return definitions.get('xiaoshe_knowledge_save').execute({ ...read.saveArgs,
      document: { title: '重试', purpose, interfaces: [], relations: [], constraints: [], overview: true } }, execution)
  }
  const context = async () => JSON.stringify((await ctx.systemPrompt.assemble({ agent })).contexts)
  await context()
  const created = await save('首次记录，最多三次')
  assert.equal(created.ok, true)
  assert.doesNotMatch(await context(), /首次记录/u)
  agent.session.events.push(event(2))
  assert.match(await context(), /首次记录/u)
  await writeFile(join(dir, 'config.ts'), 'export const attempts = 7;')
  assert.doesNotMatch(await context(), /首次记录/u)
  const updated = await save('更新后最多七次')
  assert.equal(updated.ok, true)
  assert.equal(updated.provenance.kind, 'written_now')
  assert.equal(updated.provenance.previousVersion, 1)
  assert.equal(updated.provenance.savedVersion, 2)
  assert.doesNotMatch(await context(), /首次记录|更新后/u)
  // A long run is still the same user turn after its initiating message falls
  // outside the bounded recent-event window; it must not reset the version set.
  agent.session.events.push(...Array.from({ length: 510 }, (_, i) => ({ type: 'tool/result', seq: i + 3, data: {} })))
  assert.doesNotMatch(await context(), /首次记录|更新后/u)
  const queried = await definitions.get('xiaoshe_knowledge_query').execute({}, execution)
  assert.equal(queried.entries[0].version, 2)
  agent.session.events.push(event(513))
  assert.match(await context(), /更新后/u)
})

test('real file Settings CAS preserves independent project records from separate services and restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xs-knowledge-cas-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'settings.json')
  await writeFile(file, '{}'); await writeFile(join(dir, 'a.ts'), 'a'); await writeFile(join(dir, 'b.ts'), 'b')
  const first = await host(t, file), second = await host(t, file)
  const services = [first, second].map(row => row.ctx.get('xiaosheProjectKnowledge', false).service)
  const reads = await Promise.all(services.map((service, i) => service.inspect({ cwd: dir, owner: String(i), paths: [i ? 'b.ts' : 'a.ts'] })))
  await Promise.all(services.map((service, i) => service.save({ cwd: dir, owner: String(i), receipt: reads[i].receipt, expectedVersion: 0,
    document: { title: `Module ${i}`, purpose: 'Bounded fixture', interfaces: [], relations: [], constraints: [], overview: true } })))
  const stored = JSON.parse(await readFile(file, 'utf8'))['xiaoshe-project-knowledge']
  assert.equal(stored.entries.length, 2)
  const third = await host(t, file)
  assert.equal((await third.ctx.get('xiaosheProjectKnowledge', false).service.query({ cwd: dir })).entries.length, 2)
})
