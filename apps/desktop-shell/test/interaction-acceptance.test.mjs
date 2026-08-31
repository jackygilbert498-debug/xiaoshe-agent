import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { callAcceptanceRpc, interactionAcceptanceRequested } from '../src/interaction-acceptance.mjs'

test('native interaction acceptance is inaccessible outside the explicit test gate', () => {
  assert.equal(interactionAcceptanceRequested(['electron', '--acceptance-interaction'], {}), false)
  assert.equal(interactionAcceptanceRequested(['electron'], { XIAOSHE_DESKTOP_ACCEPTANCE: '1' }), false)
  assert.equal(interactionAcceptanceRequested(['electron', '--acceptance-interaction'], { XIAOSHE_DESKTOP_ACCEPTANCE: '1' }), true)
})

test('acceptance RPC carries the exact method and payload without user content', async () => {
  let request
  const value = await callAcceptanceRpc('http://127.0.0.1:3080/', 'session.list', {}, async (_url, options) => {
    request = JSON.parse(options.body)
    return {
      ok: true,
      status: 200,
      async json() { return { type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [] } } } },
    }
  })
  assert.deepEqual(value, { items: [] })
  assert.equal(request.method, 'session.list')
  assert.deepEqual(request.payload, {})
  assert.equal(Object.hasOwn(request, 'content'), false)
})

test('acceptance RPC rejects an invalid or mismatched response', async () => {
  await assert.rejects(
    () => callAcceptanceRpc('http://127.0.0.1:3080/', '../secrets', {}, async () => { throw new Error('must not fetch') }),
    /method is invalid/u,
  )
  await assert.rejects(
    () => callAcceptanceRpc('http://127.0.0.1:3080/', 'session.list', {}, async () => ({
      ok: true, status: 200, async json() { return { rpcId: 'wrong', result: { ok: true, value: {} } } },
    })),
    /acceptance RPC session\.list failed/u,
  )
})

test('interaction acceptance step telemetry never includes the synthetic draft', async () => {
  const source = await readFile(new URL('../src/interaction-acceptance.mjs', import.meta.url), 'utf8')
  assert.match(source, /onStep\('composer-wait'\)/u)
  assert.match(source, /onStep\('draft-survived'\)/u)
  assert.doesNotMatch(source, /onStep\(draft\)/u)
})
