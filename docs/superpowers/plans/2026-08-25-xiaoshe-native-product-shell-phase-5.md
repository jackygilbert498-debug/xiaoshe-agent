# Xiaoshe Native Product Shell Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute real background checks through DSH Jobs, recover persistent heartbeat state after restart, and make verification requirements explicit enough that no unexecuted gate can become a verified completion receipt.

**Architecture:** A small `@xiaoshe/verification-policy` plugin owns risk-to-gate policy. `@xiaoshe/heartbeat` owns persistent cross-session check/lease facts and schedules due work, but delegates every actual run to the public `ctx.jobs` registry. DSH Schedule remains a separate agent/session reminder mechanism and is never used as a name for Heartbeat timers.

**Tech Stack:** TypeScript 5.9, Vitest 3 fake timers, DSH JobRegistry structural public face, Cordis settings/effects, same-origin Host API.

**Spec:** `docs/superpowers/specs/2026-08-23-xiaoshe-native-product-shell-design.md`

**Status (2026-08-25):** 本机功能、真实 DSH Profile、进程崩溃恢复和真实浏览器验收已完成，证据见 `docs/evidence/native-shell-phase-5/acceptance.md`。真实模型成功回合因无凭据继续单独标记为 `release-held`。分任务 commit 未执行，以免吞入基准 HEAD 之后已经存在的用户/跨阶段脏工作树。

## Global Constraints

- Do not persist a second Session log; periodic lease checkpoints stay in the Heartbeat settings domain.
- A check success can be recorded only after the DSH Job outcome resolves `completed`.
- DSH Schedule records are not Heartbeat checks and are not copied into the Heartbeat store.
- On restart, a persisted active lease is interrupted evidence, not proof that the old process is still running.
- Browser status is redacted; private task labels, failure reasons, paths and model credentials remain Host-only.
- Preserve all three dirty worktrees and stage only named Phase 5 files.

---

### Task 1: Create the independent verification-policy seam

**Files:**
- Create: `packages/verification-policy/package.json`
- Create: `packages/verification-policy/tsconfig.json`
- Create: `packages/verification-policy/vitest.config.ts`
- Create: `packages/verification-policy/src/index.ts`
- Create: `packages/verification-policy/tests/policy.test.ts`

**Interfaces:**

```ts
type VerificationGate = 'typecheck' | 'test' | 'build' | 'browser' | 'windows-evidence' | 'migration-rollback' | 'profile-dump' | 'profile-start' | 'functional-probe' | 'release-confirmation'
type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'not-run' | 'blocked'

interface VerificationPlan {
  readonly risk: 'low' | 'medium' | 'high'
  readonly gates: readonly VerificationGate[]
}

interface VerificationPolicy {
  plan(input: { kind: 'code' | 'ui' | 'windows' | 'persistence' | 'plugin' | 'release'; risk?: 'low' | 'medium' | 'high' }): VerificationPlan
  evaluate(plan: VerificationPlan, results: readonly { gate: VerificationGate; status: VerificationStatus; evidence?: string }[]): 'verified' | 'partial' | 'blocked' | 'failed' | 'release-held'
}
```

- [x] **Step 1: Write failing table-driven tests**

  Hand-derive expected gates for code, UI, Windows, persistence, plugin and release changes. Assert a high-risk input contains every gate of its lower-risk form plus the stricter gate; missing/skipped gates never evaluate to verified.

- [x] **Step 2: Verify RED**

  Run: `pnpm.cmd --filter @xiaoshe/verification-policy test`

  Expected: FAIL because the package does not exist.

- [x] **Step 3: Implement the pure policy and Cordis service provider**

  Keep gate order deterministic and de-duplicated. Provide the service as `xiaosheVerificationPolicy`; it owns no worker, UI or durable state.

- [x] **Step 4: Verify GREEN**

  Run: `pnpm.cmd --filter @xiaoshe/verification-policy test`

- [ ] **Step 5: Commit the seam**

  Commit `feat(verification): add risk based gate policy`.

---

### Task 2: Upgrade Heartbeat persistence from one ledger to explicit check records

**Files:**
- Modify: `packages/heartbeat/src/service.ts`
- Create: `packages/heartbeat/src/schema.ts`
- Modify: `packages/heartbeat/tests/service.test.ts`
- Create: `packages/heartbeat/tests/recovery.test.ts`

**Interfaces:**

```ts
interface HeartbeatCheckState {
  readonly id: string
  readonly intervalMs: number
  readonly activeHours?: { readonly startHour: number; readonly endHour: number }
  readonly status: 'idle' | 'running' | 'healthy' | 'delayed' | 'lost' | 'paused' | 'backoff'
  readonly activeLease?: HeartbeatLease
  readonly lastSuccessAt?: number
  readonly lastFailureAt?: number
  readonly nextRunAt?: number
  readonly pauseReason?: string
  readonly failureCount: number
}

interface HeartbeatService {
  snapshot(): { readonly schemaVersion: 2; readonly checks: readonly HeartbeatCheckState[] }
  ensureCheck(input: { id: string; intervalMs: number; activeHours?: { startHour: number; endHour: number } }): Promise<void>
  acquire(checkId: string, leaseId: string): Promise<void>
  checkpoint(checkId: string, leaseId: string): Promise<void>
  succeed(checkId: string, leaseId: string, evidence?: string): Promise<void>
  fail(checkId: string, leaseId: string, reason: string): Promise<void>
  pause(checkId: string, reason: string): Promise<void>
  resume(checkId: string): Promise<void>
  recoverInterruptedLeases(): Promise<readonly string[]>
}
```

- [x] **Step 1: Write failing schema and migration tests**

  Cover multiple checks, strict ids/intervals/hours, bounded exponential backoff, independent pause/resume, current v1 empty/lease state migration and unknown persisted fields rejection.

- [x] **Step 2: Verify RED**

  Run: `pnpm.cmd --filter @xiaoshe/heartbeat test`

  Expected: FAIL because schema version 2 and per-check methods are absent.

- [x] **Step 3: Implement the smallest compatible v2 store**

  Store checks by id internally and return a sorted immutable array. Serialize writes, keep failure details Host-only and leave the old public API adapter only where root compatibility tests require it.

- [x] **Step 4: Implement restart recovery**

  Convert each persisted active lease to `lastFailure='interrupted by process restart'`, increment failure count and schedule bounded backoff. Never resume the old job id because DSH Jobs is process-local.

- [x] **Step 5: Verify GREEN**

  Run: `pnpm.cmd --filter @xiaoshe/heartbeat test`

- [ ] **Step 6: Commit persistence**

  Commit `feat(heartbeat): persist recoverable check state`.

---

### Task 3: Execute checks as real DSH Jobs

**Files:**
- Create: `packages/heartbeat/src/coordinator.ts`
- Modify: `packages/heartbeat/src/index.ts`
- Create: `packages/heartbeat/tests/coordinator.test.ts`
- Create: `packages/heartbeat/tests/jobs-contract.test.ts`

**Interfaces:**

```ts
interface HeartbeatCheckDefinition {
  readonly id: string
  readonly intervalMs: number
  readonly activeHours?: { readonly startHour: number; readonly endHour: number }
  run(signal: AbortSignal): Promise<{ readonly summary: string; readonly evidence?: string }>
}

interface HeartbeatCoordinator {
  register(definition: HeartbeatCheckDefinition): () => void
  runNow(id: string): Promise<{ readonly jobId: string }>
  start(): Promise<void>
  dispose(): Promise<void>
}
```

- [x] **Step 1: Write failing real-boundary tests**

  Use a behavior-complete fake JobRegistry. Assert `attachController()` occurs before start, `jobs.start()` owns the actual async run, Job completion precedes Heartbeat success, Job failure precedes backoff, abort cancels the run, duplicate due ticks do not start a second lease, and dispose kills/awaits owned active jobs.

- [x] **Step 2: Verify RED**

  Run: `pnpm.cmd --filter @xiaoshe/heartbeat exec vitest run tests/coordinator.test.ts tests/jobs-contract.test.ts`

  Expected: FAIL because the coordinator is missing.

- [x] **Step 3: Implement coordinator scheduling**

  Use one segmented `setTimeout` for the nearest due check. At the due boundary re-read the persistent snapshot and active hours. Wrap each check in an unowned DSH Job with an AbortController and first-wins settlement; write success/failure only from the resolved Job outcome.

- [x] **Step 4: Register a side-effect-free runtime readiness check**

  The Product plugin registers `xiaoshe-product-runtime` as a real Job. It verifies required Product services are mounted and returns a redacted evidence id; it performs no network, file, model or desktop mutation.

- [x] **Step 5: Verify GREEN**

  Run: `pnpm.cmd --filter @xiaoshe/heartbeat test`

- [ ] **Step 6: Commit Job execution**

  Commit `feat(heartbeat): execute checks through DSH jobs`.

---

### Task 4: Add guarded control API and truthful public projection

**Files:**
- Modify: `packages/heartbeat/src/index.ts`
- Create: `packages/heartbeat/src/http.ts`
- Modify: `packages/heartbeat/tests/service.test.ts`
- Create: `packages/heartbeat/tests/http.test.ts`
- Modify: `packages/native-shell/src/client/index.ts`
- Modify: `packages/native-shell/tests/runtime-consumer.test.ts`

**Interfaces:**
- `GET /api/xiaoshe/heartbeat`: redacted aggregate and per-check status.
- `POST /api/xiaoshe/heartbeat`: strict `run_now`, `pause`, or `resume` action for a known check.
- Public check rows include id, status, interval, active hours, timestamps, failure count and next run; they exclude labels, failure text, lease ids and evidence paths.

- [x] **Step 1: Write failing route tests**

  Cover same-origin enforcement, unknown ids/actions, mutation content type, redaction, run-now conflict, pause/resume and no background animation/status when no check is running.

- [x] **Step 2: Verify RED**

  Run: `pnpm.cmd --filter @xiaoshe/heartbeat exec vitest run tests/http.test.ts`

- [x] **Step 3: Implement Host API and minimal Shell consumption**

  Keep the existing status path stable. Native Shell renders only text backed by the public projection; visual redesign remains out of scope.

- [x] **Step 4: Verify GREEN**

  Run:

  ```powershell
  pnpm.cmd --filter @xiaoshe/heartbeat test
  pnpm.cmd --filter @xiaoshe/native-shell test
  ```

- [ ] **Step 5: Commit API**

  Commit `feat(heartbeat): expose truthful background status`.

---

### Task 5: Apply verification policy to completion receipts and background results

**Files:**
- Modify: `packages/completion-receipt/package.json`
- Modify: `packages/completion-receipt/src/index.ts`
- Modify: `packages/completion-receipt/tests/receipt.test.ts`
- Modify: `packages/heartbeat/package.json`
- Modify: `packages/heartbeat/src/coordinator.ts`
- Modify: `packages/heartbeat/tests/coordinator.test.ts`

**Interfaces:**
- Completion receipts add `requirements` and `verificationResults` while preserving schema-v1 read compatibility or performing an explicit schema bump with a parser for v1.
- Tool-result metadata may contribute only validated gate/status/evidence records; arbitrary text cannot mark a gate passed.

- [x] **Step 1: Write failing receipt-policy tests**

  Assert code mutation without test/build evidence is partial, UI mutation without browser evidence is partial, failed gates produce failed/partial as specified, release work without explicit confirmation is release-held, and all required passed gates can be verified.

- [x] **Step 2: Verify RED**

  Run: `pnpm.cmd --filter @xiaoshe/completion-receipt test`

- [x] **Step 3: Implement policy-backed folding**

  Derive the plan from canonical tool calls and validated result metadata. Preserve unknown tool outcomes as `needs_verification`; never synthesize a passed gate from a successful process exit alone when the gate requires browser, rollback or release confirmation.

- [x] **Step 4: Verify GREEN across consumers**

  Run:

  ```powershell
  pnpm.cmd --filter @xiaoshe/verification-policy test
  pnpm.cmd --filter @xiaoshe/completion-receipt test
  pnpm.cmd --filter @xiaoshe/heartbeat test
  pnpm.cmd --filter @xiaoshe/runtime-dsh-provider test
  pnpm.cmd --filter @xiaoshe/native-shell test
  ```

- [ ] **Step 5: Commit verification routing**

  Commit `feat(receipts): enforce explicit verification gates`.

---

### Task 6: Compose and prove the real Profile lifecycle

**Files:**
- Modify: `packages/product-bundle/package.json`
- Modify: `packages/product-bundle/cordis.patch.yml`
- Modify: `packages/product-bundle/tests/manifest.test.ts`
- Modify: `scripts/verify-native-shell-profile.mjs`
- Modify: `tests/native-shell-profile.test.ts`

- [x] **Step 1: Write failing Product composition assertions**

  Require verification policy before Heartbeat and Completion Receipt, require Heartbeat to inject `jobs`, and require installed Profile proof to expose at least one registered check with idle/running/healthy transitions.

- [x] **Step 2: Verify RED**

  Run: `pnpm.cmd --filter @xiaoshe/product-bundle test` and the real Profile verifier test.

- [x] **Step 3: Pack every new dependency into the isolated Profile**

  Extend the verifier's offline overrides for `@xiaoshe/verification-policy`. Start the Profile, POST `run_now` for `xiaoshe-product-runtime`, wait by condition until the check settles, restart the Profile and verify the persisted result plus clean recovery. Remove Product Bundle and verify Heartbeat endpoints and timers disappear while the generic DSH root and session sentinel remain.

- [x] **Step 4: Verify GREEN**

  Run: `pnpm.cmd vitest run tests/native-shell-profile.test.ts`.

- [ ] **Step 5: Commit composition proof**

  Commit `test(profile): prove real heartbeat job execution`.

---

### Task 7: Phase 5 verification and evidence

**Files:**
- Create: `docs/evidence/native-shell-phase-5/acceptance.md`
- Modify: `docs/superpowers/plans/2026-08-23-xiaoshe-native-product-shell.md`
- Modify: `交接工具/当前状态.md`

- [x] **Step 1: Run complete local gates**

  ```powershell
  pnpm.cmd --filter @xiaoshe/verification-policy test
  pnpm.cmd --filter @xiaoshe/heartbeat test
  pnpm.cmd --filter @xiaoshe/completion-receipt test
  pnpm.cmd --filter @xiaoshe/product-bundle test
  pnpm.cmd vitest run tests/native-shell-profile.test.ts
  pnpm.cmd run typecheck
  pnpm.cmd run build
  ```

- [x] **Step 2: Browser acceptance**

  Observe idle, manual run, healthy, forced failure/backoff, pause, resume and restart recovery through the real Product API and browser. Confirm console has no errors and the foreground session remains usable after a failed background check.

- [x] **Step 3a: Record evidence**

  Evidence is recorded in `docs/evidence/native-shell-phase-5/acceptance.md`.

- [ ] **Step 3b: Commit evidence**

  Record commands, state transitions, Profile name, hashes and external limitations. Commit `docs: record native shell phase 5 acceptance` only after fresh gates pass.
