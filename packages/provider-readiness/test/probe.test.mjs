import assert from 'node:assert/strict'
import test from 'node:test'

import { runProviderProbe } from '../lib/probe.js'

test('runProviderProbe consumes the whole stream and records usage without content', async () => {
  const calls = []
  const llm = {
    async resolveModelInfo(provider, model) {
      calls.push({ kind: 'resolve', provider, model })
      return { provider, id: model, name: model, context: { contextWindow: 128_000 } }
    },
    async *stream(options) {
      calls.push({ kind: 'stream', options })
      yield { type: 'text-delta', index: 0, text: 'OK secret-output' }
      yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const result = await runProviderProbe(llm, {
    provider: 'deepseek-official', model: 'deepseek-v4-pro', timeoutMs: 2_000,
  }, { now: (() => { let value = 100; return () => (value += 25) })() })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.usage.inputTokens, 10)
  assert.equal(result.usage.outputTokens, 2)
  assert.equal(result.usage.totalTokens, 12)
  assert.equal(result.finishReason, 'stop')
  assert.equal(JSON.stringify(result).includes('secret-output'), false)
  assert.equal(calls[1].options.maxTokens, 8)
  assert.equal(calls[1].options.tools, undefined)
})

test('runProviderProbe classifies a terminal provider failure', async () => {
  const llm = {
    async resolveModelInfo() { return { context: { contextWindow: 100 } } },
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'rate_limited', message: 'too many requests', status: 429 } } }
    },
  }

  const result = await runProviderProbe(llm, { provider: 'p', model: 'm', timeoutMs: 2_000 })

  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'rate_limited')
  assert.equal(result.error.message, 'too many requests')
})

test('runProviderProbe enforces bounds before calling the provider', async () => {
  const llm = { async resolveModelInfo() { throw new Error('must not run') }, async *stream() {} }

  await assert.rejects(() => runProviderProbe(llm, { provider: '', model: 'm', timeoutMs: 2_000 }), /provider/u)
  await assert.rejects(() => runProviderProbe(llm, { provider: 'p', model: 'm', timeoutMs: 10 }), /timeout/u)
})

test('runProviderProbe distinguishes timeout from an explicit cancellation', async () => {
  const llm = {
    async resolveModelInfo(_provider, _model, signal) {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    async *stream() {},
  }
  let timeoutCallback
  const timedOut = await runProviderProbe(llm, { provider: 'p', model: 'm', timeoutMs: 500 }, {
    setTimer(callback) { timeoutCallback = callback; queueMicrotask(callback); return 1 },
    clearTimer() {},
  })
  assert.equal(typeof timeoutCallback, 'function')
  assert.equal(timedOut.status, 'failed')
  assert.equal(timedOut.error.code, 'timeout')

  const controller = new AbortController()
  const cancelledPromise = runProviderProbe(llm, { provider: 'p', model: 'm', timeoutMs: 2_000 }, {
    signal: controller.signal,
  })
  controller.abort()
  const cancelled = await cancelledPromise
  assert.equal(cancelled.status, 'cancelled')
})
