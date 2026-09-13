import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context } from '../runtime/DSH/vendor/cordis/lib/index.js'
import { SessionStore } from '../runtime/DSH/packages/core/session/lib/index.js'
import { SystemPrompt } from '../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { ToolRuntime } from '../runtime/DSH/packages/core/tools/lib/index.js'
import * as todoTool from '../runtime/DSH/packages/todo/tool-todo/lib/index.js'

// Load the actual built package through Cordis and execute via ToolRuntime.
// The standard internal gate builds DSH host libraries before discovering this
// root *.test.mjs file; no model, browser or replacement tool body is involved.
async function harness(t, allowParallelInProgress) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new ToolRuntime(ctx)
  new SessionStore(ctx)
  await ctx.plugin(todoTool, { allowParallelInProgress })
  const session = ctx.sessions.create(`todo-contract-${randomUUID()}`)
  const agent = { id: session.header.id, ctx, session }
  return {
    ctx, session, agent,
    write: todos => ctx.tools.execute({ name: 'todo_write', arguments: { todos },
      callId: randomUUID(), agent, signal: new AbortController().signal }),
    snapshots: () => session.events.filter(event => event.type === 'todo/write'),
  }
}

const fieldContract = 'Each todo must be a flat object containing exactly content and status; do not add other fields.'
const initial = [{ content: 'Read source', status: 'in_progress' }, { content: 'Verify delivery', status: 'pending' }]
const corrected = [
  { content: 'Read source and extract fields', status: 'completed' },
  { content: 'Write the result and independently read it back', status: 'completed' },
  { content: 'Open the authorized record page', status: 'in_progress' },
  { content: 'Fill, save and independently verify the record', status: 'pending' },
]

for (const allowParallel of [false, true]) {
  const mode = `allowParallelInProgress=${allowParallel}`

  test(`todo model-facing schema states exact flat fields without changing the contract (${mode})`, async t => {
    const h = await harness(t, allowParallel)
    const registered = h.ctx.tools.schemas(h.agent).find(tool => tool.name === 'todo_write')
    const assembly = await h.ctx.systemPrompt.assemble({ scope: h.agent, agent: h.agent })
    const wire = JSON.parse(JSON.stringify(assembly.tools.find(tool => tool.name === 'todo_write')))
    assert.deepEqual(wire, registered, 'the actual assembled model schema retains the registered contract')
    assert.ok(wire.description.includes(fieldContract))
    assert.match(wire.description, allowParallel ? /several at once when work genuinely runs in parallel/u : /AT MOST ONE/u)
    assert.deepEqual(Object.keys(wire.parameters.properties), ['todos'])
    assert.deepEqual(wire.parameters.required, ['todos'])
    const item = wire.parameters.properties.todos.items
    assert.equal(item.type, 'object')
    assert.equal(item.additionalProperties, false)
    assert.deepEqual(Object.keys(item.properties), ['content', 'status'])
    assert.deepEqual(item.required, ['content', 'status'])
    assert.deepEqual(item.properties.status.enum, ['pending', 'in_progress', 'completed'])
    assert.equal(h.snapshots().length, 0, 'schema assembly is not a task-list write')
  })

  test(`todo extra fields fail before changing the real session list; corrected calls succeed (${mode})`, async t => {
    const h = await harness(t, allowParallel)
    assert.equal((await h.write(initial)).isError, false)
    for (const [key, value] of [['container', ''], ['id', 'invented-id'], ['children', []]]) {
      const before = structuredClone(h.session.events)
      // Reproduce the observed whole-list extra-field error, not a guard stub.
      const invalid = corrected.map(item => ({ [key]: value, ...item }))
      const unchangedArgs = structuredClone(invalid)
      const rejected = await h.write(invalid)
      assert.equal(rejected.isError, true, key)
      assert.equal(rejected.error?.info?.code, 'INVALID_ARGS', key)
      assert.match(rejected.content[0].text, new RegExp(`todos\\[0\\]\\.${key}`))
      assert.equal(rejected.value, undefined, 'a rejected list cannot return a success value')
      assert.deepEqual(invalid, unchangedArgs, 'the runtime must not clean unknown fields in place')
      assert.deepEqual(h.session.events, before, 'invalid input must not append or replace a todo snapshot')

      const accepted = await h.write(corrected)
      assert.equal(accepted.isError, false)
      assert.deepEqual(accepted.value, { todos: corrected, counts: { pending: 1, inProgress: 1, completed: 2 } })
      assert.deepEqual(accepted.content, [{ type: 'text', text: 'Updated todo list: 1 pending, 1 in progress, 2 completed.' }])
      assert.equal(h.session.events.length, before.length + 1)
      assert.deepEqual(h.snapshots().at(-1).data.todos, corrected, 'success records the whole corrected list')
    }
    assert.equal(h.snapshots().length, 4, 'only the initial list and three valid corrections were written')
  })

  test(`todo field clarification preserves the existing parallel execution option (${mode})`, async t => {
    const h = await harness(t, allowParallel)
    assert.equal((await h.write(initial)).isError, false)
    const before = structuredClone(h.session.events)
    const concurrent = [{ content: 'Read first source', status: 'in_progress' }, { content: 'Read second source', status: 'in_progress' }]
    const result = await h.write(concurrent)
    if (allowParallel) {
      assert.equal(result.isError, false)
      assert.deepEqual(h.snapshots().at(-1).data.todos, concurrent)
      assert.deepEqual(result.content, [{ type: 'text', text: 'Updated todo list: 0 pending, 2 in progress, 0 completed.' }])
    } else {
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /at most one task may be in_progress/u)
      assert.deepEqual(h.session.events, before)
    }
  })
}
