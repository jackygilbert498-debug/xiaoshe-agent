import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '../runtime/DSH/vendor/cordis/lib/index.js'
import { ToolRuntime } from '../runtime/DSH/packages/core/tools/lib/index.js'
import { SystemPrompt, renderContextSnapshot, renderPrompt } from '../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { createScope, scopeTarget } from '../runtime/DSH/packages/core/scope/lib/index.js'
import { createUserMessage, createToolResultMessage } from '../runtime/DSH/packages/llm/llm/lib/index.js'
import { applyWebSearchTool } from '../runtime/DSH/packages/web/tool-web/src/search.ts'
import { apply } from '../dist/plugins/agent-reliability.js'
import { apply as applyBrowser } from '../dist/plugins/isolated-browser.js'
import { browserOrigin, browserFault, createBrowserEndpoint } from './isolated-browser-protocol.mjs'

const goal = '帮我搜集一下今天a i行业里面都有些什么样的新闻可以关注一下x'
const url = 'https://lab.example/research'
const readerCommand = `curl.exe -s --max-time 40 "https://r.jina.ai/${url}" | Select-Object -First 120`
const foreground = { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false }
const readerText = `Title: Laboratory announcement\n\nURL Source: ${url}\n\nMarkdown Content:\nThe laboratory describes a new inference architecture, its evaluation methodology, and deployment limitations. This text is a synthetic fixture, not a factual news report.`

function harness(t, events = []) {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false }); new ToolRuntime(ctx); apply(ctx)
  const session = { events, append(type, data) {
    const event = { seq: events.length, type, data: structuredClone(data), time: events.length + 1 }
    events.push(event); ctx.emit('session/event', session, event); return event
  } }
  const steers = [], cancellations = []
  const agent = { id: randomUUID(), session, steer: message => steers.push(message), cancel: cause => cancellations.push(cause) }
  const scope = createScope(ctx, agent); agent.ctx = scope.ctx
  t.after(() => { scope.dispose(); ctx.fiber.dispose() })
  // Only external I/O is substituted; use the real DSH schema, formatter,
  // native ToolRuntime dispatch, post-result hooks and durable event shape.
  let failSearch = false, searchFailure = 'fetch failed'
  let readerOutput = { ...foreground, stdout: readerText }
  applyWebSearchTool({ tools: ctx.tools, systemPrompt: ctx.systemPrompt, web: {
    async search({ query }) {
      assert.equal(typeof query, 'string')
      if (failSearch) throw new Error(searchFailure)
      return { sources: [{ title: 'Laboratory architecture announcement', url }], truncated: false }
    },
  } }, 8, 4, 30_000, true)
  ctx.tools.register({ name: 'web_fetch', description: 'Fetch a public source body.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    async execute(args) { assert.ok(args.url.startsWith('https://')); throw new Error('trusted DoH lookup failed') },
  })
  ctx.tools.register({ name: 'pwsh', description: 'Run an already available shell command.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.stdout }],
      presentationMeta: (_args, value) => ({ shellProcess: { kind: value.kind, exitCode: value.exitCode, signal: value.signal, timedOut: value.timedOut, aborted: value.aborted } }),
    },
    async execute(args) { assert.equal(args.command, readerCommand); return readerOutput },
  })
  const send = text => {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    ctx.emit(scopeTarget(agent, agent), 'agent/inbox/claimed', { agent, message })
    session.append('user/message', message)
    ctx.emit(scopeTarget(agent, agent), 'agent/assistant-stream', { agent, frame: { type: 'start' } })
  }
  const call = async (name, args, signal = new AbortController().signal) => {
    const callId = randomUUID()
    session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
    const result = await ctx.tools.execute({ name, arguments: args, callId, agent, signal })
    const event = session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
      ...(result.meta !== undefined ? { meta: result.meta } : {}), ...(result.error ? { error: result.error } : {}),
    })
    return { result, event }
  }
  const names = async () => (await ctx.systemPrompt.assemble({ scope: agent, agent })).tools.map(tool => tool.name)
  const stop = () => ctx.serial(scopeTarget(agent, agent), 'agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  return { ctx, agent, session, events, send, call, names, stop, steers, cancellations,
    failSearch: (message = 'fetch failed') => { failSearch = true; searchFailure = message },
    readerOutput: value => { readerOutput = value },
    resume: () => ctx.emit(scopeTarget(agent, agent), 'agent/session-start', { agent, source: 'resume' }),
  }
}

test('native search, transport failure and Reader recovery retain source evidence through actual hooks and cold replay', async t => {
  const f = harness(t); f.send(goal)
  f.session.append('turn/start', { turn: 1 }); f.ctx.emit('session/event', f.session, f.events.at(-1))
  const discovery = await f.call('web_search', { queries: ['AI news today'] })
  assert.equal(discovery.result.isError, false)
  assert.match(discovery.result.content[0].text, /External web content follows/)
  f.failSearch()
  const failedSearch = await f.call('web_search', { queries: ['more official AI news'] })
  assert.equal(failedSearch.result.isError, true)
  for (let i = 0; i < 5; i++) assert.equal((await f.call('web_fetch', { url: `https://lab.example/unavailable-${i}` })).result.isError, true)
  for (const name of ['web_search', 'web_fetch', 'pwsh']) assert.ok((await f.names()).includes(name), name)
  const prompt = renderPrompt(await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent }))
  assert.match(prompt, /小蛇任务执行契约/)
  assert.doesNotMatch(prompt, /应直接交付带实际来源/, 'the base task contract must not contradict recovery advice with an unconditional early exit')
  const cold = harness(t, structuredClone(f.events)); cold.resume()
  assert.ok((await cold.names()).includes('web_fetch'), 'resuming does not restore a whole-family ban')
  const recovered = await cold.call('pwsh', { command: readerCommand })
  assert.equal(recovered.result.isError, false)
  cold.session.append('assistant/message', { turn: 1, stream: [], message: { role: 'assistant', content: [{ type: 'text', text: `已读到实验室说明正文，发布日期仍需核对，不能据此断言是今日新闻。[实际来源](${url})` }] } })
  await cold.stop()
  const receipt = cold.events.filter(event => event.type === 'xiaoshe/obligation-state' && event.data.kind === 'research').at(-1).data
  assert.equal(receipt.status, 'satisfied', JSON.stringify({ receipt, markers: cold.events.filter(event => event.type === 'xiaoshe/research-evidence'), steers: cold.steers }))
  assert.ok(receipt.sourceResultSeqs.includes(discovery.event.seq))
  assert.ok(!receipt.sourceResultSeqs.includes(failedSearch.event.seq), 'failed search is not source evidence')
  assert.ok(receipt.bodyResultSeqs.includes(recovered.event.seq))
  assert.deepEqual(receipt.citedBodyResultSeqs, [recovered.event.seq])
  assert.deepEqual(cold.steers, []); assert.deepEqual(cold.cancellations, [])
  const reloaded = harness(t, structuredClone(cold.events)); reloaded.resume(); await reloaded.stop()
  assert.deepEqual(reloaded.steers, []); assert.deepEqual(reloaded.cancellations, [])
  assert.doesNotMatch(renderContextSnapshot(await reloaded.ctx.systemPrompt.assemble({ agent: reloaded.agent, scope: reloaded.agent })), /不要继续搜索|本轮未取得可核验来源/)
})

test('research recovery never weakens explicit offline constraints or public HTTPS restrictions', async t => {
  const f = harness(t); f.send(goal)
  const unsafe = await f.call('web_fetch', { url: 'http://plain.example/news' })
  assert.equal(unsafe.result.isError, true)
  assert.match(unsafe.result.content.map(block => block.text ?? '').join('\n'), /公开 HTTPS/)
  f.send('本任务禁止联网，只做离线分析。')
  assert.ok(!(await f.names()).includes('web_search'))
  assert.equal((await f.call('web_search', { queries: ['AI news'] })).result.isError, true)
  assert.equal((await f.call('pwsh', { command: readerCommand })).result.isError, true)
})

test('live context and cold replay retain mixed outcomes and accept an honest not-current partial answer', async t => {
  const f = harness(t); f.send('搜索今天 AI 行业新闻')
  f.session.append('turn/start', { turn: 1 }); f.ctx.emit('session/event', f.session, f.events.at(-1))
  await f.call('web_search', { queries: ['AI news'] })
  f.readerOutput({ ...foreground, stdout: readerText.replace('Markdown Content:', 'Published Time: 2001-01-01\n\nMarkdown Content:') })
  await f.call('pwsh', { command: readerCommand })
  f.readerOutput({ ...foreground, exitCode: 1, stdout: '(no output)\n[exit code: 1]' })
  await f.call('pwsh', { command: readerCommand })
  f.failSearch('DeepSeek search transport failure [ECONNRESET].')
  await f.call('web_search', { queries: ['different public sources'] })
  for (let i = 0; i < 5; i++) await f.call('web_fetch', { url: `https://lab.example/failure-${i}` })
  const live = renderContextSnapshot(await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent }))
  const cold = harness(t, structuredClone(f.events)); cold.resume()
  const replayed = renderContextSnapshot(await cold.ctx.systemPrompt.assemble({ agent: cold.agent, scope: cold.agent }))
  for (const context of [live, replayed]) {
    assert.match(context, /Reader[^\n]*成功 1[^\n]*失败 1/)
    assert.match(context, /web_search[^\n]*成功 1[^\n]*失败 1/)
    assert.match(context, /非零退出[^\n]*原因[^\n]*未知/)
    assert.match(context, /已读取页面：https:\/\/lab.example\/research/)
    assert.match(context, /ECONNRESET[^\n]*不能证明端点/)
    assert.doesNotMatch(context, /明确来源正文未能读取/)
  }
  cold.session.append('assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: `证据边界：已读取页面，但无法确认其内容属于今天。不提供未经来源核验的具体事实。[已读取页面](${url})` }] } })
  await cold.stop()
  assert.deepEqual(cold.steers, []); assert.deepEqual(cold.cancellations, [])
  assert.equal(cold.events.filter(event => event.type === 'xiaoshe/obligation-state').at(-1).data.status, 'bounded-partial')
  cold.send('新任务：解释二分查找算法，不需要联网。')
  const next = renderContextSnapshot(await cold.ctx.systemPrompt.assemble({ agent: cold.agent, scope: cold.agent }))
  assert.doesNotMatch(next, /Reader（shell）|研究工具事实|ECONNRESET|已读取页面：/)
})

test('canonical ToolRuntime cancellation after a completed body survives cold replay', async t => {
  const f = harness(t), controller = new AbortController()
  f.ctx.tools.register({ name: 'search_web', description: 'Search public sources.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    async execute() { controller.abort(); return { sources: [] } },
  })
  f.send(goal)
  const cancelled = await f.call('search_web', {}, controller.signal)
  assert.equal(cancelled.result.error?.info?.code, 'ABORTED', JSON.stringify(cancelled.result))
  const live = renderContextSnapshot(await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent }))
  const cold = harness(t, structuredClone(f.events)); cold.resume()
  const replayed = renderContextSnapshot(await cold.ctx.systemPrompt.assemble({ agent: cold.agent, scope: cold.agent }))
  for (const context of [live, replayed]) assert.match(context, /web_search：成功 0，失败 0，中止 1/)
})

test('real private browser errors survive ToolRuntime and cancellation replay without spending retry budget', async t => {
  const previous = process.env.XIAOSHE_BROWSER_BRIDGE_DIR
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-research-browser-cancel-'))
  process.env.XIAOSHE_BROWSER_BRIDGE_DIR = directory
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  const endpoint = await createBrowserEndpoint({ origin: browserOrigin(), dispatch: async (_owner, command, args, signal) => {
    if (command === 'status') return { connected: true, owner_id: _owner, mode: 'agent', active_tab: null, tabs: [] }
    if (command === 'snapshot') throw browserFault('BROWSER_NOT_VISIBLE', '专用浏览器尚未建立可操作的页面尺寸。')
    if (args.url?.endsWith('/slow')) {
      entered()
      await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }))
    }
    throw browserFault('BROWSER_CANCELLED', '浏览器操作已停止，请核对已发出的操作结果。')
  } })
  t.after(async () => {
    await endpoint.close()
    if (previous === undefined) delete process.env.XIAOSHE_BROWSER_BRIDGE_DIR; else process.env.XIAOSHE_BROWSER_BRIDGE_DIR = previous
    await rm(directory, { recursive: true, force: true })
  })
  const f = harness(t); applyBrowser(f.ctx); f.send('搜索今天 AI 行业新闻')
  const cancelled = await f.call('browser_open', { url })
  assert.equal(cancelled.result.isError, true)
  assert.match(JSON.stringify(cancelled.result), /BROWSER_CANCELLED/)
  const controller = new AbortController()
  const pending = f.call('browser_open', { url: `${url}/slow` }, controller.signal)
  await ready; controller.abort()
  assert.equal((await pending).result.isError, true)
  await f.call('browser_snapshot', { tab_id: 'fixture-tab' })
  const live = renderContextSnapshot(await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent }))
  const cold = harness(t, structuredClone(f.events)); cold.resume()
  const replayed = renderContextSnapshot(await cold.ctx.systemPrompt.assemble({ agent: cold.agent, scope: cold.agent }))
  for (const context of [live, replayed]) assert.match(context, /browser：成功 0，失败 1，中止 2/)
})
