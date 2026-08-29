# Xiaoshe Native Product Shell Phase 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver confirmation-gated plugin installation, health verification, uninstall and rollback against an inactive managed DSH Profile, with complete audit evidence and no silent third-party execution.

**Architecture:** The existing `@xiaoshe/plugin-governance` Client provider remains the read-only inventory consumer. A new Host lifecycle service resolves and hashes an exact candidate tarball without running scripts, binds that artifact to an expiring confirmation challenge, and invokes only the official DSH CLI against a managed staging Profile. Health is a sequence of dump, boot and declared functional probe; failure triggers a best-effort inverse operation and an honest residual-state report.

**Tech Stack:** TypeScript 5.9, Node standard library (`child_process`, `crypto`, `fs`, `zlib`), Vitest 3, DSH CLI/Profile/Bundle, same-origin Host API, isolated temporary `DSH_HOME` acceptance.

**Spec:** `docs/superpowers/specs/2026-08-23-xiaoshe-native-product-shell-design.md`

**Reality correction (2026-08-25):** A proof Profile whose Product Bundle is the only direct dependency is not a reproducible bootstrap source. `npm pack` preserves unpublished `workspace:*`; normal `pnpm pack` rewrites it to a version but an offline target still needs private-registry metadata. Copying the source's proof-only workspace overrides would violate the staging boundary. The isolated verifier therefore creates source-preserving temporary pack copies under its own `DSH_HOME/artifacts`, rewrites only `workspace:*` edges to the corresponding absolute local `file:` tarballs, disables lifecycle scripts, and adds every exact Product child through `dsh plugin` before adding the Product Bundle. Bootstrap can replay only locked manifest dependency specs through the same official CLI, without copying `node_modules`, workspace overrides, credentials, settings or Profile files. These absolute proof paths establish the local lifecycle mechanism only; cross-device artifact relocation remains Phase 7 work.

## Global Constraints

- No direct Profile manifest edits; every dependency mutation uses `dsh plugin --profile ... add/remove/update`.
- No candidate lifecycle script runs before a matching, unexpired confirmation challenge is consumed.
- Only Profile names matching `xiaoshe-managed-[a-z0-9-]+` are mutable; the active/current Profile is always rejected.
- A manifest or confirmation record is informed consent, not an OS sandbox. Host Bundles remain trusted in-process code.
- Missing functional probe means partial health and cannot become the last verified Profile.
- Real third-party installation remains per-candidate confirmation even after the local fixture proves the mechanism.
- Preserve all three dirty worktrees and stage only named Phase 6 files.

---

### Task 1: Move candidate audit to the authoritative Host boundary

**Files:**
- Create: `packages/plugin-governance/src/audit.ts`
- Create: `packages/plugin-governance/src/tar-manifest.ts`
- Modify: `packages/plugin-governance/src/index.ts`
- Modify: `packages/plugin-governance/src/client/index.ts`
- Modify: `packages/plugin-governance/tests/governance.test.ts`
- Create: `packages/plugin-governance/tests/tar-manifest.test.ts`

**Interfaces:**

```ts
type CandidateSource =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'tarball'; readonly path: string }
  | { readonly kind: 'registry'; readonly spec: string }

interface ResolvedCandidate {
  readonly packageName: string
  readonly version: string
  readonly tarballPath: string
  readonly sha256: string
  readonly manifestSha256: string
  readonly audit: CandidateAudit
  readonly healthPath?: string
}
```

- [x] **Step 1: Write failing manifest/tar tests**

  Use literal npm-style `.tgz` fixtures generated in the test temp directory. Cover valid `package/package.json`, PAX/long-name handling, duplicate manifest rejection, compressed/uncompressed size limits, path traversal rejection, invalid JSON, install scripts, dependency/runtime signals, DSH scope and strict health-path validation.

- [x] **Step 2: Verify RED**

  Run: `pnpm.cmd --filter @xiaoshe/plugin-governance test`

  Expected: FAIL because Host audit and tar parsing do not exist.

- [x] **Step 3: Implement bounded standard-library resolution**

  Read local directories through `realpath` and `lstat`. Convert a directory or registry spec to a private exact tarball with `npm pack --ignore-scripts --json`; resolve the npm CLI as a JavaScript entry and spawn Node with an argv array. Parse only `package/package.json` from gzip/tar, enforce limits and hash the final bytes.

- [x] **Step 4: Keep Client audit display non-authoritative**

  Client may format a Host audit result but must not approve or mutate from its own manifest parser. Remove any UI path that treats `planProfileChange().command` as executable authority.

- [x] **Step 5: Verify GREEN**

  Run the package test suite.

- [ ] **Step 6: Commit**

  Commit `refactor(plugins): move candidate audit to host` after the inherited dirty handoff is separated safely.

---

### Task 2: Add durable transaction records and expiring confirmation challenges

**Files:**
- Create: `packages/plugin-governance/src/store.ts`
- Create: `packages/plugin-governance/src/lifecycle.ts`
- Modify: `packages/plugin-governance/src/index.ts`
- Create: `packages/plugin-governance/tests/lifecycle.test.ts`
- Create: `packages/plugin-governance/tests/store.test.ts`

**Interfaces:**

```ts
type PluginAction = 'bootstrap' | 'add' | 'update' | 'remove' | 'rollback'
type TransactionState = 'prepared' | 'running' | 'healthy' | 'partial-health' | 'failed' | 'rolled-back' | 'rollback-failed'

interface ConfirmationChallenge {
  readonly id: string
  readonly token: string
  readonly expiresAt: string
  readonly action: PluginAction
  readonly profile: string
  readonly packageName: string
  readonly version: string
  readonly candidateSha256: string
  readonly manifestSha256: string
  readonly disclosures: readonly string[]
}

interface PluginLifecycleService {
  audit(source: CandidateSource): Promise<ResolvedCandidate>
  prepare(input: { action: PluginAction; profile: string; candidate?: ResolvedCandidate; packageName?: string }): Promise<ConfirmationChallenge>
  confirm(input: { challengeId: string; token: string }): Promise<PluginTransaction>
  listTransactions(): readonly PluginTransaction[]
}
```

- [x] **Step 1: Write failing state-machine tests**

  Cover exact field binding, 10-minute expiry, one-shot token consumption, changed candidate hash rejection, wrong action/profile rejection, concurrent transaction exclusion, active-profile rejection, managed-name validation, redacted persistence and bounded audit history.

- [x] **Step 2: Verify RED**

  Run focused lifecycle/store tests and confirm the missing service failure.

- [x] **Step 3: Implement confirmation and transaction persistence**

  Keep raw confirmation tokens only in process memory; persist token hashes and informed-consent facts. Serialize transaction writes. A process restart invalidates all prepared challenges and keeps prior receipts readable.

- [x] **Step 4: Verify GREEN**

  Run package tests.

- [ ] **Step 5: Commit**

  Commit `feat(plugins): add confirmation gated transactions` after the inherited dirty handoff is separated safely.

---

### Task 3: Implement the official DSH CLI runner and staging Profile bootstrap

**Files:**
- Create: `packages/plugin-governance/src/process-runner.ts`
- Create: `packages/plugin-governance/src/dsh-profile.ts`
- Modify: `packages/plugin-governance/src/lifecycle.ts`
- Create: `packages/plugin-governance/tests/process-runner.test.ts`
- Create: `packages/plugin-governance/tests/profile.test.ts`

**Interfaces:**

```ts
interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

interface DshProfileManager {
  bootstrap(profile: string, sourceProfile: string, signal: AbortSignal): Promise<ProfileReceipt>
  add(profile: string, tarballPath: string, signal: AbortSignal): Promise<ProfileReceipt>
  update(profile: string, tarballPath: string, signal: AbortSignal): Promise<ProfileReceipt>
  remove(profile: string, packageName: string, signal: AbortSignal): Promise<ProfileReceipt>
  dump(profile: string, signal: AbortSignal): Promise<string>
}
```

- [x] **Step 1: Write failing argv/process tests**

  Assert no shell invocation, exact argv order, output truncation with original byte counts, timeout termination, abort termination, Windows-hidden child processes, environment allowlist, profile-name rejection and no secrets in stored output.

- [x] **Step 2: Verify RED**

  Run focused process/profile tests and confirm missing runner failure.

- [x] **Step 3: Implement the runner**

  Reuse the current process's Node executable, Node loader arguments and DSH CLI entry. Do not interpolate a command string. Set `DSH_HOME` only to the configured absolute root and use a bounded environment allowlist.

- [x] **Step 4: Implement staging bootstrap through CLI calls**

  Read the source Profile manifest only to enumerate locked direct dependency specs. The proof source must declare each unpublished Product child as an exact packed direct dependency (added through the official CLI before the Product Bundle), rather than relying on proof-only workspace overrides. Replay the locked specs into a new managed Profile with official `dsh plugin add` calls in dependency order. Never copy `node_modules`, workspace overrides, credentials, settings or the source Profile directory.

- [x] **Step 5: Verify GREEN**

  Run package tests.

- [ ] **Step 6: Commit**

  Commit `feat(plugins): manage isolated DSH staging profiles` after the inherited dirty handoff is separated safely.

---

### Task 4: Add dump, boot, functional health and best-effort rollback gates

**Files:**
- Create: `packages/plugin-governance/src/health.ts`
- Create: `packages/plugin-governance/src/rollback.ts`
- Modify: `packages/plugin-governance/src/lifecycle.ts`
- Create: `packages/plugin-governance/tests/health.test.ts`
- Create: `packages/plugin-governance/tests/rollback.test.ts`
- Create: `packages/plugin-governance/tests/fixtures/healthy-bundle/package.json`
- Create: `packages/plugin-governance/tests/fixtures/healthy-bundle/cordis.patch.yml`
- Create: `packages/plugin-governance/tests/fixtures/healthy-bundle/index.js`
- Create: `packages/plugin-governance/tests/fixtures/failing-bundle/package.json`
- Create: `packages/plugin-governance/tests/fixtures/failing-bundle/cordis.patch.yml`
- Create: `packages/plugin-governance/tests/fixtures/failing-bundle/index.js`

**Interfaces:**
- Health gates: CLI mutation, dump membership, Profile boot, optional declared `/api/...` functional probe, clean stop.
- Rollback receipt: attempted inverse operation, restored dependency spec/hash, post-rollback dump/boot/probe, residual paths/messages.

- [x] **Step 1: Write failing health tests**

  Cover healthy bundle, missing dump row, boot crash, probe 404, malformed probe, timeout and missing declared probe producing `partial-health` rather than `healthy`.

- [x] **Step 2: Verify RED**

  Run focused health tests and confirm the missing gate failure.

- [x] **Step 3: Implement condition-based Profile startup**

  Start the target on port `0`, wait for the announced loopback URL or early process exit, fetch only the audited health path, then stop and await exit. Do not use fixed sleeps.

- [x] **Step 4: Write failing rollback tests**

  Assert failed add removes the exact candidate and restores the prior healthy boot; failed update reinstalls the locked prior spec; failed remove re-adds the prior spec; inverse failure is `rollback-failed` with residual details, never `rolled-back`.

- [x] **Step 5: Implement best-effort rollback**

  Snapshot the target dependency spec and dump hash before mutation. Run the exact inverse through DSH CLI, then repeat health gates. Never claim atomicity.

- [x] **Step 6: Verify GREEN**

  Run package tests.

- [ ] **Step 7: Commit**

  Commit `feat(plugins): verify health and rollback profile changes` after the inherited dirty handoff is separated safely.

---

### Task 5: Expose Host lifecycle API and Client service without command execution

**Files:**
- Create: `packages/plugin-governance/src/http.ts`
- Modify: `packages/plugin-governance/src/index.ts`
- Modify: `packages/plugin-governance/src/client/index.ts`
- Modify: `packages/plugin-governance/scripts/build-client.mjs`
- Create: `packages/plugin-governance/tests/http.test.ts`
- Modify: `packages/plugin-governance/tests/governance.test.ts`
- Modify: `packages/native-shell/src/client/index.ts`
- Modify: `packages/native-shell/tests/runtime-consumer.test.ts`

**Interfaces:**
- `GET /api/xiaoshe/plugins/transactions` returns redacted receipts.
- `POST /api/xiaoshe/plugins/audit|prepare|confirm` uses strict JSON, same-origin loopback guard and bounded bodies.
- Client `pluginGovernance` combines authoritative Remote inventory with Host audit/lifecycle endpoints; it exposes consent, Service-enforced constraints and `osSandboxEnforced: false` as separate facts.

- [x] **Step 1: Write failing API/Client tests**

  Cover cross-origin rejection, exact content type, unknown fields, challenge mismatch, token non-disclosure, in-flight abort, immutable snapshots, disposal and the absence of any browser-side process/command executor.

- [x] **Step 2: Verify RED**

  Run the plugin-governance suite and Native Shell focused tests.

- [x] **Step 3: Implement guarded Host API and DOM-free Client service**

  Native Shell may show functional counts and transaction states only. Formal visual plugin management is deferred to the separate UI candidate.

- [x] **Step 4: Verify GREEN**

  Run package/client/artifact tests.

- [ ] **Step 5: Commit**

  Commit `feat(plugins): expose governed lifecycle service` after the inherited dirty handoff is separated safely.

---

### Task 6: Prove install, uninstall and rollback in a temporary real DSH_HOME

**Files:**
- Create: `scripts/verify-plugin-governance-profile.mjs`
- Create: `tests/plugin-governance-profile.test.ts`
- Modify: `scripts/verify-native-shell-profile.mjs`
- Modify: `packages/product-bundle/tests/manifest.test.ts`

- [x] **Step 1: Write the failing real Profile test**

  Require this sequence: initialize source Product Profile; bootstrap managed staging; audit/confirm/install the healthy local Bundle; pass dump/boot/probe; confirm/uninstall and verify absence; confirm rollback and restore health; install failing Bundle and verify old healthy Profile remains bootable with a truthful rollback receipt.

- [x] **Step 2: Verify RED**

  Run: `pnpm.cmd vitest run tests/plugin-governance-profile.test.ts`

  Expected: FAIL because the verifier and Host lifecycle are absent.

- [x] **Step 3: Implement the isolated verifier**

  Create a temporary `DSH_HOME`, pack fixtures with scripts ignored, use one exact confirmation token per action, record no credentials, and clean only that resolved temporary directory in `finally`.

- [x] **Step 4: Verify GREEN**

  Run the focused real Profile test twice to prove rerunnability and absence of fixed ports/profile collisions.

- [ ] **Step 5: Commit the proof**

  Commit `test(plugins): prove governed profile lifecycle`.

---

### Task 7: Phase 6 full verification and evidence

**Files:**
- Create: `docs/evidence/native-shell-phase-6/acceptance.md`
- Modify: `docs/superpowers/plans/2026-08-23-xiaoshe-native-product-shell.md`
- Modify: `交接工具/当前状态.md`

- [x] **Step 1: Run all Phase 6 gates**

  ```powershell
  pnpm.cmd --filter @xiaoshe/plugin-governance test
  pnpm.cmd --filter @xiaoshe/plugin-governance build
  pnpm.cmd --filter @xiaoshe/product-bundle test
  pnpm.cmd vitest run tests/plugin-governance-profile.test.ts
  pnpm.cmd run typecheck
  pnpm.cmd run build
  ```

- [x] **Step 2: Browser acceptance**

  In the real Product Profile, verify inventory, audit disclosure, explicit consent state, install progress, healthy, partial-health, failed, rolled-back and rollback-failed presentation using only local controlled fixtures. Confirm no command is executed before confirmation and console has no errors.

- [x] **Step 3: Record honest limits**

  State that the mechanism is verified with local fixtures. List real third-party candidates as uninstalled until individually selected and confirmed; list OS process isolation as not enforced.

- [ ] **Step 4: Commit evidence**

  Commit `docs: record native shell phase 6 acceptance` after fresh gates pass.
