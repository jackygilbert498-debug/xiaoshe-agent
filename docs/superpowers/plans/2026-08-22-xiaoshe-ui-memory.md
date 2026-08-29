# Xiaoshe UI and Native Memory Implementation Plan

> **For Codex:** Work in the user-designated `C:\Users\example\Desktop\XS` checkout. Preserve all pre-existing dirty state in the root, `runtime/DSH`, and `runtime/xiaoshe-legacy` repositories. Follow red-green-refactor for every production behavior and run fresh verification before each completion claim.

**Goal:** Give the DSH-based Xiaoshe interface a distinctive, typography-led product identity, redesign the right workbench around current data, and add editable profile-persistent memory without reviving the legacy Agent runtime.

**Architecture:** The root XS Bundle remains an external DSH extension. A new memory service stores versioned entries through a dedicated DSH settings namespace, exposes guarded loopback routes and DSH tools, and feeds the same browser workbench. `client.js` keeps DSH as layout owner while replacing only declared brand/overlay slots. The sole image mark remains the exact legacy `snake.svg` served by the existing brand route.

**Tech Stack:** TypeScript 5.9, Vitest 3, DSH Cordis settings/tools/webServer services, dependency-light browser JavaScript and React slot contracts, PowerShell/Windows browser acceptance.

**Approved design:** `docs/superpowers/specs/2026-08-22-xiaoshe-ui-memory-design.md`

## Execution rules

- Work in place because the live 3080 composition depends on the root Bundle plus two nested runtime repositories.
- Do not modify `runtime/xiaoshe-legacy/ui/assets/snake.svg`; verify its SHA-256 before and after.
- Do not add a second copy, path, mask, morphology filter, generated image or text-shaped replacement for the Logo.
- Stage only named files. Existing mode-only root changes and dirty nested repositories stay outside these commits.
- One failing test must be observed before each production behavior group.
- The right rail may borrow information depth from the old UI but must not copy its component language or display unsupported values.

---

### Task 1: Freeze the UI and Logo baseline

**Files:**

- Create: `docs/evidence/2026-08-22-ui-memory-baseline.md`

**Steps:**

1. Record root, DSH and legacy HEAD/status counts.
2. Record the sole Logo path and SHA-256.
3. Capture current 3080 light/dark wide screenshots and one narrow screenshot.
4. Record current focused UI tests and build results.
5. Commit only the evidence file.

### Task 2: Build a versioned DSH-settings memory service

**Files:**

- Create: `src/memory-service.ts`
- Create: `tests/memory-service.test.ts`
- Modify: `src/types.ts`

**RED:** Add focused tests for empty state, global/project creation, edit-as-supersede, forget, revive, stale revision conflict, strict schema validation and configured limits. Run `pnpm.cmd vitest run tests/memory-service.test.ts` and confirm the missing implementation fails.

**GREEN:** Implement a serialized service backed by `SettingsScopeLike`, a strict callable settings schema and immutable snapshots. Use stable random IDs, ISO timestamps, bounded entry/audit history and no irreversible delete.

**VERIFY:** Re-run the focused test until all cases pass and `pnpm.cmd run typecheck` remains green.

### Task 3: Expose guarded memory HTTP routes

**Files:**

- Modify: `src/runtime-control.ts`
- Modify: `tests/runtime-control.test.ts`

**RED:** Add route tests for GET snapshots; create, edit, forget and revive POST actions; stale revisions; invalid bodies; wrong methods; and cross-origin rejection. Confirm expected failures.

**GREEN:** Mount `/xiaoshe/memory` beside the existing loopback-only routes. Reuse the trusted-request guard, strict body limit and `no-store`; return conflict as 409 and validation errors as 400.

**VERIFY:** Run `pnpm.cmd vitest run tests/runtime-control.test.ts tests/memory-service.test.ts`.

### Task 4: Register provider-neutral memory tools

**Files:**

- Modify: `src/memory-service.ts`
- Modify: `src/index.ts`
- Modify: `tests/plugin.test.ts`

**RED:** Add plugin tests proving the memory settings namespace and three tool names register, reads are available when desktop actions are off, edits create a new version, and cleanup removes registrations. Confirm the tests fail on the current eight-tool composition.

**GREEN:** Register list, remember/edit, and state-change tools over the same service. Tool descriptions must require explicit user intent for durable writes. Keep desktop approval policy unchanged.

**VERIFY:** Run `pnpm.cmd vitest run tests/plugin.test.ts tests/memory-service.test.ts` and typecheck.

### Task 5: Redesign the brand typography and remove the derived Logo contour

**Files:**

- Modify: `tests/client-theme.test.ts`
- Modify: `tests/client-plugin.test.ts`
- Modify: `client.js`

**RED:** Change tests to require separate sidebar/display typography roles, per-character hero spans, solid text color, an unfiltered exact Logo image and absence of the old SVG morphology/filter pipeline. Confirm focused client tests fail.

**GREEN:** Implement the modern sidebar signature and calligraphic hero word with optical spacing. Remove gradient text clipping and the derived outline SVG. Keep the existing brand URL and responsive DSH slots.

**VERIFY:** Run `pnpm.cmd vitest run tests/client-theme.test.ts tests/client-plugin.test.ts`.

### Task 6: Rebuild the right workbench and editable memory UI

**Files:**

- Modify: `tests/client-theme.test.ts`
- Modify: `tests/client-plugin.test.ts`
- Modify: `client.js`

**RED:** Add tests for data-driven status priority, independent workbench structure, memory scope controls, real add/edit/forget/revive actions, loading/error/empty states and responsive drawer semantics. Confirm failures before implementation.

**GREEN:** Replace generic card stacking with compact contextual sections. Fetch `/xiaoshe/memory`, preserve tab/scope state, send optimistic revisions, refresh after mutations and render only values observed from DSH or returned by XS routes.

**VERIFY:** Run focused client tests, then the complete root Vitest suite.

### Task 7: Build, restart and perform real browser acceptance

**Files:**

- Create: `docs/evidence/2026-08-22-ui-memory-validation.md`
- Create: browser screenshots under `docs/evidence/`

**Steps:**

1. Run `pnpm.cmd run typecheck`, `pnpm.cmd run test`, `pnpm.cmd run test:python`, and `pnpm.cmd run build`.
2. Restart only the XS-owned 3080 process with the existing Windows stop/start entries.
3. Verify light/dark wide layouts, collapsed rail, narrow drawer, keyboard focus and reduced-motion behavior.
4. Through the real UI: add a global memory, edit it, forget it, restore it, add a project memory and reload the page to prove persistence.
5. Verify `/xiaoshe/memory` contents and tool registration without exposing sensitive content.
6. Re-hash the Logo and confirm it is unchanged.
7. Run the handoff verification and record any unrelated pre-existing dirty state separately.

### Task 8: Self-review and final evidence

1. Review the complete diff against the approved design and this plan.
2. Check CSP compatibility, no inline event handlers, no raw memory content in logs, no unguarded write route and no inaccessible icon-only control.
3. Re-run all relevant gates after any review fix.
4. Commit implementation and evidence in scoped commits; report exact pass counts and any genuinely unverified boundary.
