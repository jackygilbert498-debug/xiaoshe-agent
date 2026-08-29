# Xiaoshe Native Product Shell Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Xiaoshe memory into an independently composable Product plugin, inject only traceable global/project memories through DSH, and expose typed context-budget and compaction facts without creating a second runtime or store.

**Architecture:** `@xiaoshe/memory` becomes the single implementation owner for durable memory, tools, Host API, DSH prompt-context injection and a DOM-free Client service. The Windows Bundle keeps compatibility re-exports but no second implementation. `ContextGovernance` remains a DSH projection consumer and derives explanatory values only from `contextPressure`, `contextBreakdown`, `tokenUsage` and `taskTimeline`.

**Tech Stack:** TypeScript 5.9, Vitest 3, DSH Settings/SystemPrompt/WebServer public faces, DSH Client ModuleLoader, Cordis effects, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-23-xiaoshe-native-product-shell-design.md`

**Status (2026-08-25):** 本机功能、Profile、真实浏览器和全部自动化门禁已完成，证据见 `docs/evidence/native-shell-phase-4/acceptance.md`。真实模型 compaction 因无凭据保持 `release-held`。计划中的分任务 commit 未执行，以免把基准提交之后已经存在的用户/跨阶段脏工作树混入提交。

## Global Constraints

- DSH Session Log remains the only authoritative interaction log.
- The memory content revision must not change when injection usage statistics change.
- Project memory selection uses the exact current Agent `session.header.cwd`; no path-prefix guessing.
- Unknown token capacity remains unknown; never infer a context window from the provider or model name.
- `packages/native-shell/` may consume the new service but receives no visual redesign in this phase.
- Preserve the dirty root, `runtime/DSH`, and `runtime/xiaoshe-legacy` worktrees; stage only named Phase 4 files.

---

### Task 1: Establish the single memory package and compatibility forwarding

**Files:**
- Create: `packages/memory/package.json`
- Create: `packages/memory/tsconfig.json`
- Create: `packages/memory/tsconfig.build.json`
- Create: `packages/memory/vitest.config.ts`
- Create: `packages/memory/src/service.ts`
- Create: `packages/memory/src/index.ts`
- Create: `packages/memory/tests/service.test.ts`
- Modify: `package.json`
- Modify: `src/memory-service.ts`
- Modify: `src/plugins/memory.ts`
- Test: `tests/memory-service.test.ts`
- Test: `tests/plugin-rows.test.ts`

**Interfaces:**
- Produces: `MemoryService`, `MemorySnapshot`, `MemoryEntry`, `MemoryInjection`, `createMemoryService()`, `selectMemoryInjection()`, `memorySettingsSchema`.
- Preserves: every current root export from `src/memory-service.ts` as a forwarding export from `@xiaoshe/memory/service`.

- [x] **Step 1: Write the failing package-boundary test**

  Add a test importing `createMemoryService` and `selectMemoryInjection` from `../src/service.js`. Assert one global and one exact-project active memory are selected, while forgotten and another-project entries are excluded. This catches a duplicated or missing Product memory implementation.

- [x] **Step 2: Verify RED**

  Run: `pnpm.cmd --filter @xiaoshe/memory test`

  Expected: FAIL because `packages/memory/src/service.ts` and its exports do not exist.

- [x] **Step 3: Move the implementation once and forward compatibility imports**

  Move the production implementation currently in `src/memory-service.ts` to `packages/memory/src/service.ts`. Replace the root file with forwarding exports:

  ```ts
  export * from '@xiaoshe/memory/service'
  ```

  Make `src/plugins/memory.ts` forward the Host plugin from `@xiaoshe/memory`; do not retain a second settings registration or tool loop in the root package.

- [x] **Step 4: Verify GREEN and compatibility**

  Run:

  ```powershell
  pnpm.cmd install --lockfile-only=false
  pnpm.cmd --filter @xiaoshe/memory test
  pnpm.cmd vitest run tests/memory-service.test.ts tests/plugin-rows.test.ts tests/plugin.test.ts
  pnpm.cmd run typecheck
  ```

  Expected: direct package tests and all root compatibility tests PASS.

- [ ] **Step 5: Commit only the extraction boundary**

  Stage only Task 1 files and commit `refactor(memory): extract product memory provider`.

---

### Task 2: Add traceable injection and usage audit without revision churn

**Files:**
- Modify: `packages/memory/src/service.ts`
- Create: `packages/memory/src/injection.ts`
- Modify: `packages/memory/src/index.ts`
- Modify: `packages/memory/tests/service.test.ts`
- Create: `packages/memory/tests/provider.test.ts`

**Interfaces:**
- Produces:

  ```ts
  interface MemoryInjectionItem {
    readonly id: string
    readonly version: number
    readonly scope: 'global' | 'project'
    readonly reason: 'global-preference' | 'project-context'
  }

  interface MemoryInjection {
    readonly project?: string
    readonly items: readonly MemoryInjectionItem[]
    readonly text: string
  }

  interface MemoryService {
    snapshot(query?: MemoryQuery): MemorySnapshot
    remember(input: RememberMemoryInput, expectedRevision: number): Promise<MemorySnapshot>
    setState(id: string, state: 'active' | 'forgotten', expectedRevision: number): Promise<MemorySnapshot>
    injection(project?: string): MemoryInjection
    recordInjection(input: { sessionId: string; project?: string; itemIds: readonly string[]; at?: string }): Promise<void>
  }
  ```

- [x] **Step 1: Write failing injection/audit tests**

  Test exact-project selection, stable order, escaped prompt framing, content revision remaining unchanged after `recordInjection()`, usage count increment, last-used timestamp, and no usage record for an empty injection.

- [x] **Step 2: Verify RED**

  Run: `pnpm.cmd --filter @xiaoshe/memory test`

  Expected: FAIL because injection and usage APIs are absent.

- [x] **Step 3: Implement minimal injection selection and separate usage state**

  Add a bounded `usage` collection to the persisted schema. Serialize usage writes through the existing write queue, but do not increment the content `revision`. Render memory text with ids, versions, scopes and reasons so every injected item is traceable.

- [x] **Step 4: Register DSH dynamic context and audit the actual assembly**

  In the Host plugin, register `systemPrompt.context({ name: 'xiaoshe:memory', order: 40, text })`. Read `context.agent?.session.header.cwd` and `context.agent?.id`; return an empty string for diagnostic assemblies without an Agent. Observe `system-prompt/assemble` through an async Cordis effect and persist the same selected ids after successful assembly.

- [x] **Step 5: Verify GREEN and lifecycle cleanup**

  Run: `pnpm.cmd --filter @xiaoshe/memory test`

  Expected: injection, usage, service registration, tool registration and disposer tests PASS with no timers/listeners left after unmount.

- [ ] **Step 6: Commit the injection boundary**

  Commit `feat(memory): inject traceable product memories` with only Task 2 files.

---

### Task 3: Expose guarded Host API and a DOM-free Client consumer

**Files:**
- Create: `packages/memory/src/http.ts`
- Create: `packages/memory/src/client/index.ts`
- Create: `packages/memory/scripts/build-client.mjs`
- Modify: `packages/memory/src/index.ts`
- Modify: `packages/memory/package.json`
- Modify: `packages/memory/tsconfig.json`
- Modify: `packages/memory/tsconfig.build.json`
- Create: `packages/memory/tests/http.test.ts`
- Create: `packages/memory/tests/client.test.ts`
- Create: `packages/memory/tests/artifact.test.ts`

**Interfaces:**
- Host route: `GET|POST /api/xiaoshe/memory` with loopback/same-origin enforcement, `no-store`, strict fields and 16 KiB JSON limit.
- Client service: `memoryLifecycle.getSnapshot()`, `subscribe()`, `refresh(query)`, `remember()`, `setState()`, `dispose()`.

- [x] **Step 1: Write failing Host route tests**

  Cover GET filtering, create/edit/forget/restore, stale revision 409, unknown fields 400, wrong content type 415, wrong method 405, cross-origin 403 and oversize request rejection.

- [x] **Step 2: Verify Host RED**

  Run: `pnpm.cmd --filter @xiaoshe/memory exec vitest run tests/http.test.ts`

  Expected: FAIL because the Product memory route is absent.

- [x] **Step 3: Implement the guarded route**

  Use Node request/response structural types and argv-free standard-library parsing. Never log memory text or return settings internals. Map `MemoryRevisionConflictError` to 409 and validation errors to 400.

- [x] **Step 4: Write and verify failing Client service tests**

  Use a specific fake `fetch` boundary and assert real service behavior: immutable snapshot replacement, retained snapshot identity between updates, mutation refresh, error state and disposal. Run `tests/client.test.ts` and confirm missing Client provider failure.

- [x] **Step 5: Implement the Client service and ModuleLoader artifact**

  Build one Client row that provides `memoryLifecycle` and touches no DOM. Its disposer aborts in-flight requests, clears listeners and prevents late publication.

- [x] **Step 6: Verify GREEN**

  Run:

  ```powershell
  pnpm.cmd --filter @xiaoshe/memory test
  pnpm.cmd --filter @xiaoshe/memory build
  ```

  Expected: Host, Client, artifact and type tests PASS.

- [ ] **Step 7: Commit Product access surfaces**

  Commit `feat(memory): expose guarded product memory lifecycle`.

---

### Task 4: Turn raw DSH context facts into a typed explanatory projection

**Files:**
- Modify: `packages/runtime-contract/src/context.ts`
- Modify: `packages/runtime-contract/src/index.ts`
- Modify: `packages/runtime-contract/tests/context.test.ts`
- Modify: `packages/runtime-dsh-provider/src/client/index.ts`
- Modify: `packages/runtime-dsh-provider/tests/provider.client.test.ts`

**Interfaces:**
- Produces:

  ```ts
  interface ContextBudget {
    readonly source: 'dsh-token-meter'
    readonly usedTokens?: number
    readonly capacityTokens?: number
    readonly ratio?: number
    readonly level: 'unknown' | 'normal' | 'elevated' | 'critical'
  }

  interface CompactionCheckpoint {
    readonly key: string
    readonly seq: number
    readonly summary: string
  }
  ```

- [x] **Step 1: Write failing contract tests**

  Assert `projectedTokens` wins over `pressureTokens`, ratio is clamped only for presentation level (raw values remain intact), 70% is elevated, 90% is critical, missing numerator/capacity is unknown, and compaction rows come only from canonical `taskTimeline` items.

- [x] **Step 2: Verify RED**

  Run: `pnpm.cmd --filter @xiaoshe/runtime-contract test`

  Expected: FAIL because typed budgets/checkpoints do not exist.

- [x] **Step 3: Implement pure projection helpers**

  Preserve the original `pressure`, `breakdown` and `usage` payloads. Derive only finite non-negative numeric fields documented by DSH. Do not import DSH source or copy its token meter.

- [x] **Step 4: Wire the DSH Client provider**

  Build each session entry from `projectionValues.contextPressure`, `contextBreakdown`, `tokenUsage` and `taskTimeline`; continue caching the complete snapshot so `useSyncExternalStore` receives a stable reference.

- [x] **Step 5: Verify GREEN**

  Run:

  ```powershell
  pnpm.cmd --filter @xiaoshe/runtime-contract test
  pnpm.cmd --filter @xiaoshe/runtime-dsh-provider test
  ```

- [ ] **Step 6: Commit context projection**

  Commit `feat(context): project DSH budget and compaction facts`.

---

### Task 5: Compose memory into Product Bundle and keep Windows capability independent

**Files:**
- Modify: `packages/product-bundle/package.json`
- Modify: `packages/product-bundle/cordis.patch.yml`
- Modify: `packages/product-bundle/tests/manifest.test.ts`
- Modify: `packages/native-shell/src/client/index.ts`
- Modify: `packages/native-shell/tests/fixture.ts`
- Modify: `packages/native-shell/tests/runtime-consumer.test.ts`
- Modify: `cordis.patch.yml`
- Modify: `tests/product-identity.test.ts`
- Modify: `scripts/verify-native-shell-profile.mjs`
- Modify: `tests/native-shell-profile.test.ts`

**Interfaces:**
- Product Bundle owns the `@xiaoshe/memory` row before Native Shell.
- Windows Bundle composes `desktop-capability`, `product-identity` and `runtime-routes` subpath rows; it does not mount the compatibility aggregate or a second memory owner.
- Native Shell consumes `memoryLifecycle` and shows only functional counts/source state; visual redesign remains deferred.

- [x] **Step 1: Write failing composition tests**

  Require Product Bundle dependency/order, memory Client injection, Product memory route/client roster, and absence of a second memory row in the Windows patch.

- [x] **Step 2: Verify RED**

  Run:

  ```powershell
  pnpm.cmd --filter @xiaoshe/product-bundle test
  pnpm.cmd --filter @xiaoshe/native-shell test
  pnpm.cmd vitest run tests/product-identity.test.ts tests/native-shell-profile.test.ts
  ```

  Expected: focused assertions FAIL because Product Bundle does not yet contain memory.

- [x] **Step 3: Implement bundle and compatibility composition**

  Insert `@xiaoshe/memory` before runtime and Shell consumers. Update the Profile verifier to build/pack/override the memory tarball and probe `/api/xiaoshe/memory` plus its Client artifact. Removing Product Bundle must return both endpoints to 404 while the generic DSH root and session sentinel remain unchanged.

- [x] **Step 4: Verify GREEN**

  Run the focused commands again. Expected: package tests and real Profile add/start/remove/restart proof PASS.

- [ ] **Step 5: Commit composition**

  Commit `feat(product): compose independent memory lifecycle`.

---

### Task 6: Phase 4 verification and evidence

**Files:**
- Create: `docs/evidence/native-shell-phase-4/acceptance.md`
- Modify: `docs/superpowers/plans/2026-08-23-xiaoshe-native-product-shell.md`
- Modify: `交接工具/当前状态.md`

- [x] **Step 1: Run complete Phase 4 gates**

  ```powershell
  pnpm.cmd --filter @xiaoshe/memory test
  pnpm.cmd --filter @xiaoshe/memory build
  pnpm.cmd --filter @xiaoshe/runtime-contract test
  pnpm.cmd --filter @xiaoshe/runtime-dsh-provider test
  pnpm.cmd --filter @xiaoshe/native-shell test
  pnpm.cmd --filter @xiaoshe/product-bundle test
  pnpm.cmd test
  pnpm.cmd run typecheck
  pnpm.cmd run build
  ```

- [x] **Step 2: Perform real browser acceptance**

  In an isolated DSH Profile, create, edit, forget and restore one test memory through the Product API; refresh the browser; verify active global/project selection, provenance, context budget and compaction rows; confirm zero console errors. Delete only the isolated test Profile after evidence is saved.

- [x] **Step 3: Record honest result**

  Write commands, counts, Profile name, evidence hashes and external limitations. Mark Phase 4 complete only when every local gate above passes; real-model compaction remains separately labeled if credentials are unavailable.

- [ ] **Step 4: Commit evidence and status**

  Commit `docs: record native shell phase 4 acceptance`.
