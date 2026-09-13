import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { TerminalApp } from '../lib/app.js'
import { DshApiClient, DshRpcError } from '../lib/api.js'

async function until(predicate, message = 'condition', timeout = 1200) {
  const end = Date.now() + timeout
  while (!predicate() && Date.now() < end) await delay(5)
  assert.ok(predicate(), message)
}

// Substitute only external Host transport. Real API shaping, feed, readline and
// app arbitration execute together; controllable streams never call a model.
async function fixture(t, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough()
  let text = '', errors = '', seq = -1, hostCursor = -1, created = 0
  let controlBaseline = { queues: {}, jobs: {}, projections: {} }
  output.on('data', chunk => { text += chunk }); error.on('data', chunk => { errors += chunk })
  const calls = [], channels = new Map()
  const catalog = { default: { provider: 'fixture', model: 'test', reasoningEffort: 'low' }, routableProviders: ['fixture'], groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'test', name: 'Test', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }] }], failures: [] }
  const snapshot = () => ({ type: 'snapshot', cursor: Math.max(seq, hostCursor), records: [], hasMore: false, projections: { asOfSeq: Math.max(seq, hostCursor), values: { modelSelection: { next: catalog.default, lastUsed: null } } } })
  t.mock.method(DshApiClient.prototype, 'stream', async function* (endpoint, args, signal) {
    const channel = { rows: [], wake: undefined, ended: false }
    const entries = channels.get(endpoint) ?? []; entries.push(channel); channels.set(endpoint, entries)
    if (endpoint === 'session/follow') {
      if (options.failSnapshot?.()) throw new Error('snapshot unavailable')
      yield snapshot()
    }
    else if (endpoint === 'session/control') yield { type: 'baseline', value: controlBaseline }
    else if (endpoint === '$events') yield { type: 'ready', clientId: 'client' }
    const wake = () => channel.wake?.()
    signal.addEventListener('abort', wake)
    try {
      while (!signal.aborted && !channel.ended) {
        if (channel.rows.length) yield channel.rows.shift()
        else await new Promise(resolve => { channel.wake = resolve })
      }
    } finally { signal.removeEventListener('abort', wake); entries.splice(entries.indexOf(channel), 1) }
  })
  t.mock.method(DshApiClient.prototype, 'remote', async function (endpoint, args, signal) {
    calls.push({ endpoint, args })
    if (endpoint === 'session/list') return { items: [] }
    if (endpoint === 'session/create') return { sessionId: ++created === 1 ? 'session-a' : 'session-b' }
    if (endpoint === 'session/modelCatalog') return catalog
    if (endpoint === 'session/selectModel') {
      if (options.rejectEffort) throw new DshRpcError('session/model-unavailable', 'effort denied', {})
      return { selected: { provider: 'fixture', model: 'test', reasoningEffort: args.request.reasoningEffort }, persistence: { status: 'session-only', warning: 'fixture only' }, effective: 'next-request' }
    }
    if (endpoint === 'session/prompt') {
      if (options.prompt) return options.prompt(args.request, signal)
      return { accepted: true }
    }
    if (endpoint === 'commands/execute') return null
    if (endpoint === 'session/updateQueue' && options.rejectQueue) throw new DshRpcError('session/queue-item-not-found', 'no longer pending', {})
    if (endpoint === 'session/updateQueue' || endpoint === 'session/cancel' || endpoint === '$events/result') return { accepted: true }
    throw new Error('Unexpected endpoint: ' + endpoint)
  })
  const app = new TerminalApp({ baseUrl: 'http://127.0.0.1:1', fresh: true, noColor: true, help: false }, { input, output, error, color: false })
  const run = app.run()
  run.catch(() => {})
  t.after(async () => { input.end(); app.rl.close(); app.mux.close(); await Promise.race([run.catch(() => {}), delay(50)]) })
  await until(() => text.includes(':help'), 'banner ready')
  await delay(5)
  const push = (endpoint, value) => { for (const channel of channels.get(endpoint) ?? []) { channel.rows.push(value); channel.wake?.() } }
  return { input, app, run, calls, text: () => text, errors: () => errors,
    send(line) { input.write(line + '\n') },
    event(type, data = {}) { push('session/follow', { type: 'event', event: { type, data, seq: ++seq, time: Date.now() } }) },
    question(id = 'question') { push('$events', { type: 'waterfall', eventId: id, agentId: 'session-a', event: 'user-questions/request', request: { questions: [{ id: 'q', question: 'Choose?', options: [{ label: 'yes' }] }] } }) },
    queue(items) { push('session/control', { type: 'queue', sessionId: 'session-a', items }) },
    inboxCutoff(seq) { hostCursor = Math.max(hostCursor, seq); push('session/control', { type: 'projection', sessionId: 'session-a', key: 'inbox', value: { 'next-turn': [], 'next-step': [] }, seq }) },
    disconnectControl(cutoff) {
      hostCursor = Math.max(hostCursor, cutoff)
      controlBaseline = { queues: { 'session-a': [] }, jobs: {}, projections: { 'session-a': { asOfSeq: cutoff, values: {} } } }
      for (const channel of channels.get('session/control') ?? []) { channel.ended = true; channel.wake?.() }
    },
    approval(id = 'approve') { push('$events', { type: 'waterfall', eventId: id, agentId: 'session-a', event: 'approval/request', request: { toolName: 'write', reason: 'save document' } }) },
    cancelQuestion(id = 'approve') { push('$events', { type: 'cancel', eventId: id }) },
  }
}

test('running input submits two FIFO messages and explicit steer before the first turn ends', async t => {
  const f = await fixture(t)
  f.send('first')
  await until(() => f.calls.some(row => row.endpoint === 'session/prompt'))
  f.event('turn/start', { turn: 1 })
  f.send('second')
  await until(() => f.calls.filter(row => row.endpoint === 'session/prompt').length === 2, 'second prompt admitted while first runs')
  f.send(':steer change direction')
  await until(() => f.calls.filter(row => row.endpoint === 'session/prompt').length === 3)
  assert.deepEqual(f.calls.filter(row => row.endpoint === 'session/prompt').map(row => [row.args.request.mode, row.args.request.content[0].text]), [['queue', 'first'], ['queue', 'second'], ['steer', 'change direction']])
  assert.match(f.text(), /正在发送/)
  assert.match(f.text(), /已接收/)
  f.send(':exit'); await f.run
})

test('send receipt is honest and stop is independent of an unresolved admission', async t => {
  let admit
  const f = await fixture(t, { prompt: () => new Promise(resolve => { admit = resolve }) })
  f.send('slow receipt')
  await until(() => admit !== undefined)
  assert.match(f.text(), /正在发送/)
  assert.doesNotMatch(f.text(), /已接收/)
  f.send(':stop')
  await until(() => f.calls.some(row => row.endpoint === 'session/cancel'), 'stop does not await prompt receipt')
  admit({ accepted: true })
  await until(() => f.text().includes('已接收'))
  f.send(':exit'); await f.run
})

test('queue edit/remove/steer use Host item identities and authoritative updates', async t => {
  const f = await fixture(t)
  const item = { id: 'q2', placement: 'queued', message: { id: 'q2', content: [{ type: 'text', text: 'pending text' }] } }
  f.queue([item]); await delay(10)
  f.send(':queue'); await until(() => f.text().includes('pending text'))
  f.send(':queue edit q2 revised message')
  await until(() => f.calls.some(row => row.endpoint === 'session/updateQueue'))
  f.send(':queue steer q2')
  await until(() => f.calls.filter(row => row.endpoint === 'session/updateQueue').length === 2)
  f.send(':queue remove q2')
  await until(() => f.calls.filter(row => row.endpoint === 'session/updateQueue').length === 3)
  assert.deepEqual(f.calls.filter(row => row.endpoint === 'session/updateQueue').map(row => row.args.request), [
    { sessionId: 'session-a', itemId: 'q2', action: { kind: 'edit', content: [{ type: 'text', text: 'revised message' }] } },
    { sessionId: 'session-a', itemId: 'q2', action: { kind: 'steer' } },
    { sessionId: 'session-a', itemId: 'q2', action: { kind: 'remove' } },
  ])
  f.queue([]); await delay(10); f.send(':queue')
  await until(() => f.text().includes('暂无排队消息'))
  f.send(':exit'); await f.run
})

test('running effort uses the current advertised route and states the next request boundary', async t => {
  const f = await fixture(t)
  f.event('turn/start', { turn: 1 })
  f.send(':effort high')
  await until(() => f.calls.some(row => row.endpoint === 'session/selectModel'))
  assert.deepEqual(f.calls.find(row => row.endpoint === 'session/selectModel').args.request, { sessionId: 'session-a', provider: 'fixture', model: 'test', reasoningEffort: 'high' })
  await until(() => f.text().includes('下一次模型请求'))
  f.send(':effort max'); await until(() => f.errors().includes('不支持'))
  assert.equal(f.calls.filter(row => row.endpoint === 'session/selectModel').length, 1)
  f.send(':exit'); await f.run
})

test('effort rejection remains visible and does not end the input loop', async t => {
  const f = await fixture(t, { rejectEffort: true })
  f.send(':effort high'); await until(() => f.errors().includes('effort denied'))
  assert.doesNotMatch(f.text(), /下一次模型请求/)
  f.send(':help'); await until(() => f.text().includes('本地命令'))
  f.send(':exit'); await f.run
})

test('approval preempts normal input and cancellation preserves the next user message', async t => {
  const f = await fixture(t)
  f.event('turn/start', { turn: 1 })
  f.approval(); await until(() => f.text().includes('本次允许'))
  f.send('y\nnext task')
  await until(() => f.calls.some(row => row.endpoint === 'session/prompt'), 'pasted prompt after approval is not lost')
  assert.equal(f.calls.find(row => row.endpoint === '$events/result').args.outcome.value, 'allowed-once')
  assert.equal(f.calls.find(row => row.endpoint === 'session/prompt').args.request.content[0].text, 'next task')
  f.approval('cancelled'); await until(() => f.text().split('本次允许').length === 3)
  f.cancelQuestion('cancelled'); await delay(10)
  f.send('after cancel'); await until(() => f.calls.filter(row => row.endpoint === 'session/prompt').length === 2)
  assert.equal(f.calls.filter(row => row.endpoint === '$events/result').length, 1)
  f.send(':exit'); await f.run
})

test('routine tools are concise, details never expose reasoning, failures do not get a success mark', async t => {
  const f = await fixture(t)
  f.send('work'); await until(() => f.calls.some(row => row.endpoint === 'session/prompt'))
  f.event('turn/start', { turn: 1 })
  for (let n = 0; n < 10; n++) { f.event('tool/call', { name: 'read_file', callId: 'c' + n }); f.event('tool/result', { callId: 'c' + n, message: { content: [{ type: 'tool-result', text: 'ok' }] } }) }
  f.event('tool/result', { callId: 'bad', error: 'read denied' })
  f.event('assistant/message', { stream: [{ type: 'reasoning-chunks', texts: ['SECRET THINKING'] }, { type: 'text-chunks', texts: ['Final answer'] }] })
  f.event('turn/end', { turn: 1, reason: { kind: 'error', error: 'failed' } })
  await until(() => f.text().includes('本轮失败'))
  assert.match(f.text() + f.errors(), /read denied/)
  assert.match(f.text(), /Final answer/)
  assert.doesNotMatch(f.text(), /✓ 本轮失败|SECRET THINKING|tool\/call|reasoning-delta/)
  assert.ok(f.text().split('\n').filter(line => line.includes('工具')).length < 8, 'routine tool output stays compact')
  f.send(':details'); await until(() => f.text().includes('read_file'))
  assert.doesNotMatch(f.text(), /SECRET THINKING/)
  f.send(':exit'); await f.run
})

test('non-TTY batched input and EOF drain the admitted turn and clean input listeners', async t => {
  const f = await fixture(t)
  f.send('one\ntwo')
  await until(() => f.calls.filter(row => row.endpoint === 'session/prompt').length === 2, 'both buffered input lines submitted')
  f.event('turn/start', { turn: 1 }); await delay(10)
  for (const row of f.calls.filter(row => row.endpoint === 'session/prompt')) f.event('user/message', { source: { kind: 'user', rpcId: row.args.request.requestId }, content: row.args.request.content })
  f.input.end()
  f.event('assistant/message', { content: [{ type: 'text', text: 'finished before exit' }] })
  f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await f.run
  assert.match(f.text(), /finished before exit/)
  assert.equal(f.input.listenerCount('data'), 0)
  assert.equal(f.input.listenerCount('end'), 0)
})

test('lost admission reports uncertain result and retains the original text without retry', async t => {
  const f = await fixture(t, { prompt: async () => { throw new Error('lost receipt') } })
  f.send('keep this draft')
  await until(() => f.errors().includes('lost receipt'))
  assert.match(f.errors(), /结果不明/)
  assert.match(f.errors(), /keep this draft/)
  assert.doesNotMatch(f.text(), /已接收/)
  assert.equal(f.calls.filter(row => row.endpoint === 'session/prompt').length, 1)
  f.send(':exit'); await f.run
})

test('EOF after admission waits for the matching durable prompt even before turn start', async t => {
  const f = await fixture(t)
  let finished = false
  f.run.then(() => { finished = true })
  f.send('delayed start'); await until(() => f.text().includes('已接收'))
  f.input.end(); await delay(30)
  assert.equal(finished, false, 'EOF cannot discard an admitted prompt awaiting turn start')
  const prompt = f.calls.find(row => row.endpoint === 'session/prompt').args.request
  f.event('turn/start', { turn: 1 })
  f.event('user/message', { source: { kind: 'user', rpcId: prompt.requestId }, content: prompt.content })
  f.event('assistant/message', { content: [{ type: 'text', text: 'delayed result' }] })
  f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await f.run
  assert.match(f.text(), /delayed result/)
})

test('Ctrl-C cancels a running turn and two idle interrupts release input listeners', async t => {
  const f = await fixture(t)
  f.event('turn/start', { turn: 1 }); await until(() => f.text().includes('已开始本轮'))
  f.app.rl.emit('SIGINT')
  await until(() => f.calls.some(row => row.endpoint === 'session/cancel'))
  f.event('turn/end', { turn: 1, reason: { kind: 'aborted' } }); await until(() => f.text().includes('本轮已取消'))
  f.app.rl.emit('SIGINT'); f.app.rl.emit('SIGINT')
  await f.run
  assert.equal(f.input.listenerCount('data'), 0)
})

test('EOF cancels a required question without fabricating a default answer', async t => {
  const f = await fixture(t)
  f.question(); await until(() => f.text().includes('输入编号或自定义回答'))
  f.input.end(); await f.run
  const reply = f.calls.find(row => row.endpoint === '$events/result')
  assert.equal(reply.args.outcome.kind, 'rejected')
  assert.match(f.text(), /问题已取消/)
  assert.equal(f.input.listenerCount('data'), 0)
})

test('a rejected queue edit remains an error and preserves the live queue display', async t => {
  const f = await fixture(t, { rejectQueue: true })
  f.queue([{ id: 'q', placement: 'queued', message: { id: 'q', content: [{ type: 'text', text: 'original pending' }] } }])
  await delay(10)
  f.send(':queue edit q cannot commit')
  await until(() => f.errors().includes('no longer pending'))
  assert.doesNotMatch(f.text(), /已接收队列更新/)
  f.send(':queue'); await until(() => f.text().includes('original pending'))
  f.send(':exit'); await f.run
})

test('a delayed receipt after session switch remains tied to its original session', async t => {
  let admit
  const f = await fixture(t, { prompt: request => request.sessionId === 'session-a' ? new Promise(resolve => { admit = resolve }) : { accepted: true } })
  f.send('old session draft'); await until(() => admit !== undefined)
  f.send(':new'); await until(() => f.text().split('小蛇 · 终端工作台').length === 3)
  f.send('new session draft')
  admit({ accepted: true })
  await until(() => f.calls.filter(row => row.endpoint === 'session/prompt').length === 2)
  assert.match(f.text(), /已接收 \[session-a\]/)
  assert.deepEqual(f.calls.filter(row => row.endpoint === 'session/prompt').map(row => [row.args.request.sessionId, row.args.request.content[0].text]), [['session-a', 'old session draft'], ['session-b', 'new session draft']])
  f.send(':exit'); await f.run
})

test('explicit double idle Ctrl-C exits after stop even with retained queued admissions', async t => {
  const f = await fixture(t)
  let finished = false
  f.run.then(() => { finished = true }, () => {})
  f.event('turn/start', { turn: 1 })
  f.send('retained queue'); await until(() => f.text().includes('已接收'))
  const prompt = f.calls.find(row => row.endpoint === 'session/prompt').args.request
  f.queue([{ id: 'retained', rpcId: prompt.requestId, placement: 'queued', message: { id: 'retained', content: prompt.content } }])
  f.send(':stop'); await until(() => f.calls.some(row => row.endpoint === 'session/cancel'))
  f.event('turn/end', { turn: 1, reason: { kind: 'aborted' } }); await until(() => f.text().includes('本轮已取消'))
  f.app.rl.emit('SIGINT'); f.app.rl.emit('SIGINT')
  await until(() => finished, 'explicit exit bypasses retained queue drain')
  assert.equal(f.input.listenerCount('data'), 0)
})

test('external queue removal retires admission only after follow reaches the removal cutoff', async t => {
  const f = await fixture(t)
  let finished = false
  f.run.then(() => { finished = true }, () => {})
  f.send('desktop removes this'); await until(() => f.text().includes('已接收'))
  const prompt = f.calls.find(row => row.endpoint === 'session/prompt').args.request
  f.event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: 'removed', source: { kind: 'user', rpcId: prompt.requestId }, content: prompt.content }] })
  f.queue([{ id: 'removed', rpcId: prompt.requestId, placement: 'queued', message: { id: 'removed', content: prompt.content } }]); await delay(10)
  f.inboxCutoff(1); f.queue([]); f.input.end(); await delay(30)
  assert.equal(finished, false, 'a faster control stream cannot discard unread durable activity')
  f.event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
  await until(() => finished, 'external removal must not leave an unresolvable admission at EOF')
  assert.equal(f.input.listenerCount('data'), 0)
})

test('queue claim preceding delayed follow still drains its final answer at EOF', async t => {
  const f = await fixture(t)
  let finished = false
  f.run.then(() => { finished = true }, () => {})
  f.send('claimed not canceled'); await until(() => f.text().includes('已接收'))
  const prompt = f.calls.find(row => row.endpoint === 'session/prompt').args.request
  f.event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: 'claimed', source: { kind: 'user', rpcId: prompt.requestId }, content: prompt.content }] })
  f.queue([{ id: 'claimed', rpcId: prompt.requestId, placement: 'queued', message: { id: 'claimed', content: prompt.content } }]); await delay(10)
  f.inboxCutoff(2); f.queue([]); f.input.end(); await delay(30)
  assert.equal(finished, false)
  f.event('turn/start', { turn: 1 })
  f.event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  await delay(30)
  assert.equal(finished, false, 'claim is active execution, not removal')
  f.event('user/message', { source: { kind: 'user', rpcId: prompt.requestId }, content: prompt.content })
  f.event('assistant/message', { content: [{ type: 'text', text: 'delayed final stays visible' }] })
  f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => finished)
  assert.match(f.text(), /delayed final stays visible/)
})

test('queue removal without a paired projection reconciles against a fresh history cutoff', async t => {
  const f = await fixture(t)
  let finished = false
  f.run.then(() => { finished = true }, () => {})
  f.send('removed across reconnect'); await until(() => f.text().includes('已接收'))
  const prompt = f.calls.find(row => row.endpoint === 'session/prompt').args.request
  f.queue([{ id: 'removed', rpcId: prompt.requestId, placement: 'queued', message: { id: 'removed', content: prompt.content } }]); await delay(10)
  f.event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
  f.queue([]); f.input.end()
  await until(() => finished, 'fresh history resolves an unpaired queue snapshot')
})

test('failure to confirm a removal cutoff surfaces an error instead of hanging at EOF', async t => {
  let failSnapshot = false
  const f = await fixture(t, { failSnapshot: () => failSnapshot })
  f.send('needs confirmation'); await until(() => f.text().includes('已接收'))
  const prompt = f.calls.find(row => row.endpoint === 'session/prompt').args.request
  f.queue([{ id: 'removed', rpcId: prompt.requestId, placement: 'queued', message: { id: 'removed', content: prompt.content } }]); await delay(10)
  failSnapshot = true
  f.queue([]); f.input.end()
  await assert.rejects(f.run, /无法确认队列移除后的历史.*snapshot unavailable/)
  assert.equal(f.input.listenerCount('data'), 0)
})

test('control disconnect between projection and queue cannot pair a stale cutoff with the reconnect baseline', async t => {
  const f = await fixture(t)
  let finished = false
  f.run.then(() => { finished = true }, () => {})
  f.send('claimed during reconnect'); await until(() => f.text().includes('已接收'))
  const prompt = f.calls.find(row => row.endpoint === 'session/prompt').args.request
  f.event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: 'claimed', source: { kind: 'user', rpcId: prompt.requestId }, content: prompt.content }] })
  f.queue([{ id: 'claimed', rpcId: prompt.requestId, placement: 'queued', message: { id: 'claimed', content: prompt.content } }]); await delay(10)
  // Old control generation delivered its projection, but disconnected before
  // the paired queue. During downtime Host opens a turn and claims the message.
  f.inboxCutoff(0); await delay(10)
  f.disconnectControl(2)
  await until(() => f.app.queues.get('session-a')?.length === 0, 'real Mux control maintenance reopened with the empty baseline')
  f.input.end(); await delay(30)
  assert.equal(finished, false, 'stale projection must not retire the receipt before new turn/start arrives')
  f.event('turn/start', { turn: 1 })
  f.event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  await delay(20)
  assert.equal(finished, false)
  f.event('user/message', { source: { kind: 'user', rpcId: prompt.requestId }, content: prompt.content })
  f.event('assistant/message', { content: [{ type: 'text', text: 'answer after control reconnect' }] })
  f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => finished)
  assert.match(f.text(), /answer after control reconnect/)
})
