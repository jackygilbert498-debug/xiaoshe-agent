import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveProviderReadinessFacts } from '../lib/provider-readiness.js'

const NOW = 2_000_000
const TTL = 60_000

test('provider readiness keeps five facts independent when credentials are missing', () => {
  const result = deriveProviderReadinessFacts({
    catalogued: true,
    supported: true,
    settingsConfigured: true,
    credentialRequired: true,
    credentialConfigured: false,
    routeAvailable: true,
  }, NOW, TTL)

  assert.deepEqual(result.facts, {
    catalogued: true,
    supported: true,
    configured: false,
    available: false,
    verified: false,
  })
  assert.ok(result.reasons.includes('credential_missing'))
})

test('a fresh successful explicit probe verifies exactly one available route', () => {
  const result = deriveProviderReadinessFacts({
    catalogued: true,
    supported: true,
    settingsConfigured: true,
    credentialRequired: false,
    credentialConfigured: false,
    routeAvailable: true,
    probe: {
      status: 'succeeded',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      startedAt: NOW - 1_200,
      completedAt: NOW - 200,
      latencyMs: 1_000,
      finishReason: 'stop',
      usage: { inputTokens: 8, outputTokens: 1, totalTokens: 9 },
      cost: { status: 'unavailable' },
    },
  }, NOW, TTL)

  assert.equal(result.facts.verified, true)
  assert.equal(result.reasons.length, 0)
})

test('expired and failed probes remain visible but are not verified', () => {
  const expired = deriveProviderReadinessFacts({
    catalogued: true, supported: true, settingsConfigured: true,
    credentialRequired: false, credentialConfigured: false, routeAvailable: true,
    probe: {
      status: 'succeeded', provider: 'p', model: 'm', startedAt: 1,
      completedAt: NOW - TTL - 1, latencyMs: 10, finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: { status: 'unavailable' },
    },
  }, NOW, TTL)
  const failed = deriveProviderReadinessFacts({
    catalogued: true, supported: true, settingsConfigured: true,
    credentialRequired: false, credentialConfigured: false, routeAvailable: true,
    probe: {
      status: 'failed', provider: 'p', model: 'm', startedAt: NOW - 20,
      completedAt: NOW - 10, latencyMs: 10,
      error: { code: 'rate_limited', message: '请求过多' }, cost: { status: 'unavailable' },
    },
  }, NOW, TTL)

  assert.equal(expired.facts.verified, false)
  assert.ok(expired.reasons.includes('probe_expired'))
  assert.equal(failed.facts.verified, false)
  assert.ok(failed.reasons.includes('probe_failed'))
})

test('availability never becomes true for an unsupported or unconfigured route', () => {
  const result = deriveProviderReadinessFacts({
    catalogued: true,
    supported: false,
    settingsConfigured: true,
    credentialRequired: false,
    credentialConfigured: false,
    routeAvailable: true,
  }, NOW, TTL)

  assert.deepEqual(result.facts, {
    catalogued: true,
    supported: false,
    configured: true,
    available: false,
    verified: false,
  })
})
