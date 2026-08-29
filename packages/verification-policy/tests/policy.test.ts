import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  createVerificationPolicy,
  type VerificationChangeKind,
  type VerificationGate,
  type VerificationStatus,
} from '../src/index.js'

const expectedByKind: Record<VerificationChangeKind, readonly VerificationGate[]> = {
  code: ['typecheck', 'test'],
  ui: ['typecheck', 'test', 'browser'],
  windows: ['typecheck', 'test', 'windows-evidence'],
  persistence: ['typecheck', 'test', 'migration-rollback'],
  plugin: ['typecheck', 'test', 'profile-dump', 'profile-start', 'functional-probe'],
  release: ['typecheck', 'test', 'build', 'profile-dump', 'profile-start', 'functional-probe', 'release-confirmation'],
}

describe('verification policy', () => {
  const policy = createVerificationPolicy()

  it.each(Object.entries(expectedByKind) as Array<[VerificationChangeKind, readonly VerificationGate[]]>)('%s has deterministic low-risk gates', (kind, gates) => {
    expect(policy.plan({ kind, risk: 'low' })).toEqual({ kind, risk: 'low', gates })
  })

  it('adds stricter gates monotonically for medium and high risk', () => {
    for (const kind of Object.keys(expectedByKind) as VerificationChangeKind[]) {
      const low = policy.plan({ kind, risk: 'low' }).gates
      const medium = policy.plan({ kind, risk: 'medium' }).gates
      const high = policy.plan({ kind, risk: 'high' }).gates
      expect(medium).toEqual(expect.arrayContaining(low))
      expect(high).toEqual(expect.arrayContaining(medium))
      expect(new Set(high).size).toBe(high.length)
      expect(high.length).toBeGreaterThanOrEqual(low.length + 1)
    }
  })

  it.each([
    ['failed', 'failed'],
    ['blocked', 'blocked'],
    ['not-run', 'partial'],
    ['skipped', 'partial'],
  ] as Array<[VerificationStatus, string]>)('maps an unmet ordinary gate with %s to %s', (status, expected) => {
    const plan = policy.plan({ kind: 'code', risk: 'low' })
    expect(policy.evaluate(plan, [
      { gate: 'typecheck', status: 'passed', evidence: 'typecheck.log' },
      { gate: 'test', status },
    ])).toBe(expected)
  })

  it('never verifies missing gates and holds a release without explicit confirmation evidence', () => {
    const codePlan = policy.plan({ kind: 'code', risk: 'low' })
    expect(policy.evaluate(codePlan, [{ gate: 'typecheck', status: 'passed', evidence: 'typecheck.log' }])).toBe('partial')

    const releasePlan = policy.plan({ kind: 'release', risk: 'low' })
    const results = releasePlan.gates.map(gate => ({
      gate,
      status: gate === 'release-confirmation' ? 'not-run' as const : 'passed' as const,
      ...(gate === 'typecheck' || gate === 'test' || gate === 'build' ? {} : { evidence: `${gate}.json` }),
    }))
    expect(policy.evaluate(releasePlan, results)).toBe('release-held')
  })

  it('requires evidence for observational and confirmation gates', () => {
    const plan = policy.plan({ kind: 'ui', risk: 'low' })
    expect(policy.evaluate(plan, [
      { gate: 'typecheck', status: 'passed' },
      { gate: 'test', status: 'passed' },
      { gate: 'browser', status: 'passed' },
    ])).toBe('partial')
    expect(policy.evaluate(plan, [
      { gate: 'typecheck', status: 'passed' },
      { gate: 'test', status: 'passed' },
      { gate: 'browser', status: 'passed', evidence: 'browser.json' },
    ])).toBe('verified')
  })

  it('provides one stateless Cordis service', () => {
    const provide = vi.fn()
    apply({ provide })
    expect(provide).toHaveBeenCalledTimes(1)
    expect(provide.mock.calls[0]?.[0]).toBe('xiaosheVerificationPolicy')
  })
})
