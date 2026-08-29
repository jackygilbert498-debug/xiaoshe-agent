# Xiaoshe Brand, Status, and Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Xiaoshe's animated brand signature, truthful runtime status, balanced three-column layout, and product-level identity.

**Architecture:** Keep XS as an external DSH product layer. DSH publishes one stable semantic runtime-state attribute from its existing session snapshot; `client.js` consumes that attribute and owns only the Xiaoshe presentation. The deployment patch replaces the generic Harness opener with a Xiaoshe persona without changing DSH core defaults.

**Tech Stack:** TypeScript, React, CSS-in-JS string, Cordis Patch YAML, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-08-22-xiaoshe-brand-status-identity-design.md`

## Global Constraints

- Use only `runtime/xiaoshe-legacy/ui/assets/snake.svg` for Logo geometry.
- Keep `feMorphology radius="1.15"` while enlarging the outline canvas.
- Keep the central wordmark animation running under reduced-motion settings as explicitly requested.
- Preserve all unrelated dirty and untracked work in all three XS worktrees.
- Never store or print provider secrets.

---

### Task 1: Animated brand and panel geometry

**Files:**
- Modify: `tests/client-theme.test.ts`
- Modify: `client.js`
- Modify: `runtime/DSH/packages/client/ui-layout/tests/columns.client.spec.ts`
- Modify: `runtime/DSH/packages/client/ui-layout/src/client/columns.ts`

**Interfaces:**
- Consumes: `XIAOSHE_MARK_URL`, DSH `SIDEBAR_DEFAULT` geometry.
- Produces: 34px masked gradient mark, six-stop 9s wordmark animation, 300px outline, 248px sidebar default, 300px inspector.

- [ ] Add failing visual-contract expectations for the six gradient stops, `background-size: 280% 100%`, infinite `stage-sheen`, the reduced-motion override, 34px brand mark, 300px outline and inspector, and 248px sidebar default.
- [ ] Run focused XS and DSH layout tests and confirm they fail because the old static/size values remain.
- [ ] Implement the minimum CSS/JS and layout constant changes; use the official SVG as CSS mask and outline image only.
- [ ] Re-run focused tests and confirm they pass.

### Task 2: Authoritative runtime-state contract

**Files:**
- Modify: `runtime/DSH/packages/client/ui-conversation/tests/skeleton.client.spec.tsx`
- Modify: `runtime/DSH/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx`
- Modify: `tests/client-theme.test.ts`
- Modify: `client.js`

**Interfaces:**
- Produces: `data-session-runtime-state="idle|waiting-model|model-running|tool-running|awaiting-approval|stopped"` on the conversation root.
- Consumes: the same attribute in XS `uiSnapshot()`.

- [ ] Add failing DOM tests for all six states using real `ConversationSnapshot` fields.
- [ ] Run the focused skeleton test and confirm the semantic attribute is absent.
- [ ] Implement a pure state resolver and publish the attribute on `ConversationRoot`.
- [ ] Add failing XS expectations that reject generic active-session status and require the stable state contract.
- [ ] Update `uiSnapshot()` and status copy to use only the stable attribute, then run both focused suites.

### Task 3: Xiaoshe product identity

**Files:**
- Create: `tests/product-identity.test.ts`
- Modify: `cordis.patch.yml`

**Interfaces:**
- Produces: deployment `system-prompt` override with `includeHarnessIdentity: false` and a Xiaoshe persona.

- [ ] Add a failing test that loads the deployment patch and asserts the rendered configuration suppresses Harness identity and contains the Xiaoshe identity/capability/permission rules.
- [ ] Run the focused test and confirm the system-prompt override is missing.
- [ ] Add the product-level system-prompt row without embedding model names or secrets.
- [ ] Re-run the focused test and confirm it passes.

### Task 4: Full verification and visual acceptance

**Files:**
- Create: `docs/evidence/2026-08-22-brand-status-identity-validation.md`
- Create: browser screenshots under `docs/evidence/`

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: fresh automated and browser evidence.

- [ ] Run XS typecheck, full Vitest suite, Python tests, and build.
- [ ] Run focused DSH ui-layout and ui-conversation suites plus their package typechecks.
- [ ] Start Xiaoshe through the Windows launcher, inspect 1552×867 and narrow widths, and capture light/dark screenshots.
- [ ] Verify the wordmark background position changes over time, the outline remains 1.15px morphology, and empty hero has no false scrollbar.
- [ ] Exercise idle, running/tool or approval when available, and interrupted-state markers without inventing unavailable states.
- [ ] Run a real “你是谁” request and verify the answer identifies as 小蛇 without using DeepSeek Harness as its identity.
- [ ] Record exact commands, counts, limitations, and Logo hash in the evidence file.
