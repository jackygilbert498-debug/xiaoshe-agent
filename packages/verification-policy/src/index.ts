export type VerificationGate =
  | 'typecheck'
  | 'test'
  | 'build'
  | 'browser'
  | 'windows-evidence'
  | 'migration-rollback'
  | 'profile-dump'
  | 'profile-start'
  | 'functional-probe'
  | 'release-confirmation'

export type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'not-run' | 'blocked'
export type VerificationRisk = 'low' | 'medium' | 'high'
export type VerificationChangeKind = 'code' | 'ui' | 'windows' | 'persistence' | 'plugin' | 'release'
export type VerificationOutcome = 'verified' | 'partial' | 'blocked' | 'failed' | 'release-held'

export interface VerificationPlan {
  readonly kind: VerificationChangeKind
  readonly risk: VerificationRisk
  readonly gates: readonly VerificationGate[]
}

export interface VerificationResult {
  readonly gate: VerificationGate
  readonly status: VerificationStatus
  readonly evidence?: string
}

export interface VerificationPolicy {
  plan(input: { readonly kind: VerificationChangeKind; readonly risk?: VerificationRisk }): VerificationPlan
  evaluate(plan: VerificationPlan, results: readonly VerificationResult[]): VerificationOutcome
}

const GATE_ORDER: readonly VerificationGate[] = [
  'typecheck', 'test', 'build', 'browser', 'windows-evidence', 'migration-rollback',
  'profile-dump', 'profile-start', 'functional-probe', 'release-confirmation',
]

const BASE_GATES: Readonly<Record<VerificationChangeKind, readonly VerificationGate[]>> = {
  code: ['typecheck', 'test'],
  ui: ['typecheck', 'test', 'browser'],
  windows: ['typecheck', 'test', 'windows-evidence'],
  persistence: ['typecheck', 'test', 'migration-rollback'],
  plugin: ['typecheck', 'test', 'profile-dump', 'profile-start', 'functional-probe'],
  release: ['typecheck', 'test', 'build', 'profile-dump', 'profile-start', 'functional-probe', 'release-confirmation'],
}

const HIGH_RISK_GATE: Readonly<Record<VerificationChangeKind, VerificationGate>> = {
  code: 'functional-probe',
  ui: 'functional-probe',
  windows: 'browser',
  persistence: 'functional-probe',
  plugin: 'migration-rollback',
  release: 'migration-rollback',
}

const EVIDENCE_REQUIRED = new Set<VerificationGate>([
  'browser', 'windows-evidence', 'migration-rollback', 'profile-dump',
  'profile-start', 'functional-probe', 'release-confirmation',
])

/** Pure, deterministic verification policy. It owns neither execution nor persistence. */
export function createVerificationPolicy(): VerificationPolicy {
  return {
    plan(input) {
      const risk = input.risk ?? 'medium'
      const requested = [
        ...BASE_GATES[input.kind],
        ...(risk === 'low' ? [] : ['build'] as const),
        ...(risk === 'high' ? [HIGH_RISK_GATE[input.kind]] : []),
      ]
      const selected = new Set<VerificationGate>(requested)
      return {
        kind: input.kind,
        risk,
        gates: GATE_ORDER.filter(gate => selected.has(gate)),
      }
    },
    evaluate(plan, results) {
      const required = new Set(plan.gates)
      const applicable = results.filter(result => required.has(result.gate))
      if (applicable.some(result => result.status === 'failed')) return 'failed'
      if (applicable.some(result => result.status === 'blocked')) return 'blocked'

      let partial = false
      let releaseHeld = false
      for (const gate of plan.gates) {
        const candidates = applicable.filter(result => result.gate === gate)
        const passed = candidates.find(result => result.status === 'passed')
        const satisfied = passed !== undefined
          && (!EVIDENCE_REQUIRED.has(gate) || hasEvidence(passed.evidence))
        if (satisfied) continue
        if (gate === 'release-confirmation') releaseHeld = true
        else partial = true
      }
      if (releaseHeld) return 'release-held'
      return partial ? 'partial' : 'verified'
    },
  }
}

export const name = 'xiaoshe-verification-policy'
export const inject: readonly string[] = []

export function apply(ctx: { provide(name: string, value: unknown): unknown }): void {
  ctx.provide('xiaosheVerificationPolicy', createVerificationPolicy())
}

function hasEvidence(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '' && value.length <= 2_048
}
