# Windows Completion and Legacy Capability Migration Implementation Plan

> **For Codex:** Execute this plan sequentially in the user-designated `C:\Users\example\Desktop\XS` checkout. Preserve all pre-existing dirty state in the root, `runtime/DSH`, and `runtime/xiaoshe-legacy` repositories. Use test-driven development for every production behavior change and verification-before-completion before claiming any gate is green.

**Goal:** Finish every engineering, verification, and suitable legacy-migration task that can be completed on the current Windows device before XS is handed to another machine.

**Architecture:** Keep DSH as the only Agent Runtime and keep XS as an external Bundle. First make the existing DSH + XS + restricted Python desktop Provider reproducible and proven on Windows. Then classify legacy capabilities by user-visible contract and migrate only those that fit official DSH extension points and pass the same Windows acceptance gates.

**Tech Stack:** Node.js 24, TypeScript 5.9, Vitest 3, pnpm 11.7, Python 3 unittest, PowerShell 7/Windows PowerShell, DSH `0.1.0-rc.8`, Windows UI Automation, Git.

**Approved design:** `docs/superpowers/specs/2026-08-22-windows-completion-and-legacy-migration-design.md`

## Execution rules

- Work in place because the user explicitly designated `C:\Users\example\Desktop\XS` as the project working folder. Do not create another worktree that would separate the ignored nested runtime repositories from the product Bundle.
- Before and after every task, capture `git status --short --branch` for all three repositories. Never use `git reset`, `git clean`, checkout-based discard, or broad recursive deletion.
- Stage only files named by the current task. Existing executable-bit/platform changes and the legacy repository's large dirty state must not enter unrelated commits.
- For each behavior change: add one failing test, run it and record the expected failure, implement the smallest fix, rerun the focused test, then run the relevant broader gate.
- Keep real desktop actions limited to dedicated test windows, Calculator, and Notepad. Do not interact with the user's business applications or sensitive content.

---

### Task 1: Freeze the Windows execution baseline

**Files:**

- Create: `docs/evidence/2026-08-22-windows-baseline.md`
- Create: `docs/evidence/2026-08-22-windows-baseline.json`

**Step 1: Record immutable repository facts**

Run from `C:\Users\example\Desktop\XS`:

```powershell
git rev-parse HEAD
git status --porcelain=v1 --untracked-files=all
git -C runtime/DSH rev-parse HEAD
git -C runtime/DSH status --porcelain=v1 --untracked-files=all
git -C runtime/xiaoshe-legacy rev-parse HEAD
git -C runtime/xiaoshe-legacy status --porcelain=v1 --untracked-files=all
```

Record the exact HEAD, branch, dirty-entry count, and SHA-256 of each NUL-delimited status stream. Explicitly distinguish root mode-only changes, DSH platform artifacts, and legacy content changes.

**Step 2: Record the Windows toolchain and display facts**

Run:

```powershell
node --version
pnpm.cmd --version
python --version
py -3 --version
git --version
Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,OsBuildNumber,OsArchitecture
Get-CimInstance Win32_VideoController | Select-Object Name,CurrentHorizontalResolution,CurrentVerticalResolution
```

Record current display scaling through a read-only registry or Windows API probe. Do not change scaling yet.

**Step 3: Reproduce the known failures**

Run the existing root gates without editing source and record exact counts:

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test
pnpm.cmd run test:python
pnpm.cmd run build
node scripts/handoff-manifest.mjs verify
```

Expected baseline: typecheck/build pass; Windows-path, process, Python mode, or handoff checks fail as already observed. If the actual result differs, update evidence before proceeding.

**Step 4: Commit only baseline evidence**

```powershell
git add docs/evidence/2026-08-22-windows-baseline.md docs/evidence/2026-08-22-windows-baseline.json
git diff --cached --check
git commit -m "docs: freeze Windows execution baseline"
```

---

### Task 2: Make Python discovery and tests genuinely cross-platform

**Files:**

- Create: `tests/config.test.ts`
- Modify: `src/config.ts`
- Modify: `scripts/test-python.mjs`
- Modify: `tests/bridge-client.test.ts`
- Modify: `tests/tools.test.ts`
- Modify: `tests/launcher.test.ts`

**Step 1: Add failing Windows-default tests**

Add tests that prove:

- an explicit `pythonExecutable` always wins;
- macOS may prefer `/opt/miniconda3/bin/python3` when it exists;
- Windows defaults to an executable that is actually part of the supported installer contract, not the `python3` Store alias;
- test fixtures discover the same interpreter as the product instead of hardcoding `/opt/miniconda3/bin/python3`;
- shell-only launcher execution is skipped or isolated on Windows while static launcher contracts still run.

Run:

```powershell
pnpm.cmd vitest run tests/config.test.ts tests/bridge-client.test.ts tests/tools.test.ts tests/launcher.test.ts
```

Expected: FAIL on the Windows default and hardcoded interpreter/shell assumptions.

**Step 2: Implement one shared interpreter policy**

Expose a small, dependency-injectable helper in `src/config.ts` so platform and executable existence can be tested without mutating `process.platform`. Update `scripts/test-python.mjs` to use the same documented order semantically: `XIAOSHE_PYTHON`, supported platform default, then explicit failure with remediation.

Use `python` as the Windows command promised by `接收并安装-Windows.ps1`; do not silently fall through to the Store alias. Keep `py -3` as installer diagnostics/fallback guidance unless the command model is deliberately expanded to support executable arguments.

**Step 3: Remove host-specific fixture paths**

Resolve the interpreter once in tests from `XIAOSHE_PYTHON` or the platform default. Keep fixture paths and `xiaosheRoot` portable with `resolve()`/`fileURLToPath()`.

**Step 4: Run focused and broad gates**

```powershell
pnpm.cmd vitest run tests/config.test.ts tests/bridge-client.test.ts tests/tools.test.ts tests/launcher.test.ts
pnpm.cmd run typecheck
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add src/config.ts scripts/test-python.mjs tests/config.test.ts tests/bridge-client.test.ts tests/tools.test.ts tests/launcher.test.ts
git diff --cached --check
git commit -m "fix: make Python discovery portable on Windows"
```

---

### Task 3: Force UTF-8 inside isolated Python and close process races

**Files:**

- Modify: `tests/fixtures/rpc_fixture.py`
- Modify: `tests/bridge-client.test.ts`
- Modify: `src/bridge-client.ts`

**Step 1: Add failing UTF-8 and termination tests**

Extend the fixture with methods that return `sys.stdin.encoding`, `sys.stdout.encoding`, `sys.flags.utf8_mode`, and a non-ASCII payload. Add a rapid-exit/abort case that observes unhandled rejections and proves disposal is idempotent.

Run:

```powershell
pnpm.cmd vitest run tests/bridge-client.test.ts
```

Expected: FAIL because `-I -u` does not enable UTF-8 on this Windows machine and the termination race may emit `kill EINVAL`.

**Step 2: Enable Python UTF-8 independently of environment variables**

Launch the bridge with Python's own `-X utf8` option while retaining `-I` and `-u`. Keep the environment allowlist; do not reintroduce credentials. Tests should assert UTF-8 mode and exact Chinese round trips rather than only asserting `PYTHONUTF8` is present.

**Step 3: Handle only proven already-exited Windows races**

Refactor process termination into a testable helper. Ignore `ESRCH`; on Windows ignore `EINVAL` only when the child is already exited or the kill operation reports the known unsupported-signal race. Preserve failures for live-process permission errors and unexpected codes.

**Step 4: Verify**

```powershell
pnpm.cmd vitest run tests/bridge-client.test.ts
pnpm.cmd run typecheck
```

Expected: PASS with no unhandled rejection.

**Step 5: Commit**

```powershell
git add src/bridge-client.ts tests/bridge-client.test.ts tests/fixtures/rpc_fixture.py
git diff --cached --check
git commit -m "fix: harden Windows bridge encoding and shutdown"
```

---

### Task 4: Implement private Windows screenshot storage semantics

**Files:**

- Modify: `python/xiaoshe_desktop_bridge.py`
- Modify: `python/tests/test_bridge.py`
- Modify: `src/runtime-control.ts`
- Modify: `tests/runtime-control.test.ts`
- Create: `scripts/check-private-path-windows.ps1`

**Step 1: Replace the POSIX-only assertion with a failing platform contract**

Update Python tests so POSIX still requires directory `0700` and files `0600`, while Windows requires ownership by the current identity and no access grant to broad principals such as Everyone/Users through inherited ACLs.

Add runtime-control tests proving the preview route accepts a bridge-owned Windows-private path and rejects a path that fails the privacy probe.

Run:

```powershell
pnpm.cmd run test:python
pnpm.cmd vitest run tests/runtime-control.test.ts
```

Expected: FAIL until Windows ACL semantics exist.

**Step 2: Create and verify a Windows-private directory**

Keep `tempfile.mkdtemp` ownership. On Windows, use a bounded system API or `icacls.exe` invocation to disable unsafe inheritance and grant only the current identity plus required system/administrator principals. Make failure explicit; do not continue with screenshots if private storage cannot be established.

The PowerShell probe must output structured JSON and remain read-only when checking an existing path.

**Step 3: Align preview privacy checks**

Make `src/runtime-control.ts` select the platform privacy verifier: mode bits on POSIX, ACL/ownership evidence on Windows. Preserve canonical-path, temp-root, symlink, size, token, and one-time-read protections.

**Step 4: Verify**

```powershell
pnpm.cmd run test:python
pnpm.cmd vitest run tests/runtime-control.test.ts
pnpm.cmd run typecheck
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add python/xiaoshe_desktop_bridge.py python/tests/test_bridge.py src/runtime-control.ts tests/runtime-control.test.ts scripts/check-private-path-windows.ps1
git diff --cached --check
git commit -m "fix: enforce private screenshot storage on Windows"
```

---

### Task 5: Make the Windows installer and lifecycle owner complete

**Files:**

- Create: `tests/windows-launcher.test.ts`
- Create: `scripts/windows-process-owner.mjs`
- Modify: `启动小蛇.ps1`
- Modify: `停止小蛇.ps1`
- Modify: `交接工具/接收并安装-Windows.ps1`
- Modify: `交接工具/验证交接-Windows.ps1`
- Modify: `package.json`

**Step 1: Add failing launcher contract tests**

Test that the Windows entrypoints:

- prefer the project-local pnpm installed by the receiver;
- export `XIAOSHE_PYTHON`, `XIAOSHE_DSH_ROOT`, and `XIAOSHE_LEGACY_ROOT`;
- rebuild when platform-incompatible dependencies or missing DSH output are detected;
- wait for `/xiaoshe/desktop/status` before opening the browser;
- reuse an owned healthy instance;
- reject an unrelated listener without killing it;
- persist exact ownership metadata and stop only the owned process tree;
- confirm port and Bridge cleanup before reporting success.

Run:

```powershell
pnpm.cmd vitest run tests/windows-launcher.test.ts
```

Expected: FAIL against the current minimal PowerShell scripts.

**Step 2: Add a narrow process-ownership helper**

Implement structured state under the current user's local app-data directory. Store XS root, DSH root, PID, port, process creation identity, and schema version. Validate the state before reuse or termination. Never select a process only because it owns port 3080.

**Step 3: Harden install and dependency rebuild**

The receiver must use its pinned project-local pnpm 11.7.0, verify Node and Python, set `XIAOSHE_PYTHON`, and rebuild root/DSH dependencies when they were transported from another platform. Limit removal/recreation to the two verified `node_modules` directories inside XS and document the action before it occurs.

**Step 4: Harden start and stop**

Start the final DSH process hidden, stream logs to a user-local Xiaoshe log directory, wait for health, then open the browser. Stop through verified ownership state and wait for the listener and owned descendants to exit. Preserve the current refusal behavior for unrelated port owners.

**Step 5: Verify launcher contracts**

```powershell
pnpm.cmd vitest run tests/windows-launcher.test.ts tests/launcher.test.ts
pnpm.cmd run typecheck
```

Expected: PASS.

**Step 6: Commit**

```powershell
git add package.json scripts/windows-process-owner.mjs tests/windows-launcher.test.ts 启动小蛇.ps1 停止小蛇.ps1 交接工具/接收并安装-Windows.ps1 交接工具/验证交接-Windows.ps1
git diff --cached --check
git commit -m "feat: complete owned Windows install and lifecycle"
```

---

### Task 6: Make handoff verification platform-semantic

**Files:**

- Modify: `scripts/handoff-manifest.mjs`
- Modify: `tests/handoff-manifest.test.ts`
- Modify: `交接工具/验证交接-Windows.ps1`
- Modify: `交接工具/当前状态.md`

**Step 1: Add failing cross-platform fixtures**

Create fixture repositories containing a Git symlink entry and executable-bit entry. Materialize them once with POSIX metadata and once as a Windows checkout representation. Assert that identical Git content passes while file-content tampering, target tampering, HEAD drift, and true dirty-state drift still fail.

Run:

```powershell
pnpm.cmd vitest run tests/handoff-manifest.test.ts
```

Expected: FAIL because the current verifier hashes only the materialized filesystem type/content.

**Step 2: Separate source identity from checkout representation**

For tracked files, derive portable identity from Git index/tree metadata and content blobs where necessary. Keep filesystem hashes for untracked payload content. Record platform representation warnings separately from integrity failures.

Do not weaken the three-repository HEAD, `git fsck`, file-content, missing-file, extra-file, and dirty-worktree checks.

**Step 3: Verify generated dependency/build exclusions**

Prove root/DSH `node_modules`, DSH `lib`, root `dist`, logs, and caches do not drift the manifest, while source edits do.

**Step 4: Run focused test and live verifier**

```powershell
pnpm.cmd vitest run tests/handoff-manifest.test.ts
node scripts/handoff-manifest.mjs verify
```

If the live manifest represents a different frozen baseline, regenerate only after comparing and documenting every difference. Do not regenerate merely to silence a failure.

**Step 5: Commit**

```powershell
git add scripts/handoff-manifest.mjs tests/handoff-manifest.test.ts 交接工具/验证交接-Windows.ps1 交接工具/当前状态.md
git diff --cached --check
git commit -m "fix: verify handoff content across platforms"
```

---

### Task 7: Restore the complete automated Windows gate

**Files:**

- Modify as required by failures: `src/**`, `tests/**`, `python/**`, `scripts/**`
- Create: `docs/evidence/2026-08-22-windows-automated-gates.md`

**Step 1: Run the root gate from rebuilt dependencies**

Use the pinned receiver pnpm, not the transported dependency tree:

```powershell
./交接工具/接收并安装-Windows.ps1
pnpm.cmd run check
```

Expected: all TypeScript/Vitest/Python/build gates pass with zero unhandled errors.

**Step 2: Run the DSH gate relevant to the integrated profile**

Read `runtime/DSH/AGENTS.md` before any DSH change. Prefer no DSH source edits. Run its documented typecheck/test/build/profile-parse commands required for the web profile and record exact results.

**Step 3: Fix any new failure through its own red-green cycle**

Do not batch unrelated failures. Add the smallest regression test in the owning repository, prove red, fix, prove green, and commit in that repository only.

**Step 4: Record evidence and commit**

```powershell
git add docs/evidence/2026-08-22-windows-automated-gates.md
git diff --cached --check
git commit -m "docs: record Windows automated gates"
```

---

### Task 8: Complete real Windows DSH, UIA, action, and DPI acceptance

**Files:**

- Create: `scripts/run-windows-screen-smoke.ps1`
- Create: `docs/evidence/2026-08-22-windows-screen-validation.md`
- Create: `docs/evidence/2026-08-22-windows-screen-validation.json`
- Modify: `docs/ACCEPTANCE.md`
- Modify: `docs/IMPLEMENTATION_PLAN.md`

**Step 1: Build a safe, repeatable acceptance harness**

The script opens a dedicated Notepad document containing synthetic Chinese text and optionally Calculator. It records target process/window identity, current display scaling, logical and physical screen dimensions, and cleanup instructions. It must never enumerate or interact with unrelated application contents.

**Step 2: Start the real product combination**

```powershell
./启动小蛇.ps1
```

Confirm the health endpoint reports Bridge readiness and that the browser uses the intended DSH web Profile with XS and ModLens loaded.

**Step 3: Exercise real observation and approval paths**

Through the real DSH session:

1. call `screen_observe` and retain the actual PNG/UIA result;
2. click the dedicated safe target through `approval/asked` then `allowed-once`;
3. type Chinese text only after approval;
4. send a harmless key sequence only after approval;
5. verify screenshot/UIA changes after each action;
6. reuse an old viewport and prove rejection without an input event;
7. disable desktop actions and prove action tools disappear/fail closed.

**Step 4: Exercise available DPI settings**

Test the current scaling first. For 125%, 150%, and 200%, change settings only when Windows permits it without risking the user's session. Re-observe and verify logical-to-physical coordinate mapping after each available change. Restore the original setting. Mark an unavailable scale as externally constrained with the exact reason; never fabricate a pass.

**Step 5: Stop and prove static state**

```powershell
./停止小蛇.ps1
```

Confirm the owned DSH listener, process tree, and Python Bridge have exited.

**Step 6: Update acceptance truthfully and commit**

Move Windows items out of “尚需外部设备” only when evidence exists. Keep each unavailable DPI or hardware combination explicit.

```powershell
git add scripts/run-windows-screen-smoke.ps1 docs/evidence/2026-08-22-windows-screen-validation.md docs/evidence/2026-08-22-windows-screen-validation.json docs/ACCEPTANCE.md docs/IMPLEMENTATION_PLAN.md
git diff --cached --check
git commit -m "test: close the Windows desktop acceptance loop"
```

---

### Task 9: Build an evidence-backed legacy capability ledger

**Files:**

- Create: `scripts/audit-legacy-capabilities.mjs`
- Create: `tests/legacy-capability-ledger.test.ts`
- Create: `docs/LEGACY_CAPABILITY_LEDGER.md`
- Create: `docs/evidence/2026-08-22-legacy-capability-inventory.json`

**Step 1: Add a failing completeness test**

Define the ledger schema with capability ID, user value, old implementation references, old tests, DSH/XS replacement, classification, Windows verification, migration cost, and decision rationale. The test must fail if a discovered public legacy command/tool/capability has no ledger entry or an invalid status.

Run:

```powershell
pnpm.cmd vitest run tests/legacy-capability-ledger.test.ts
```

Expected: FAIL because no ledger exists.

**Step 2: Generate a bounded inventory**

Inspect legacy public registrations and contracts, not every helper file. At minimum cover:

- Agent/runtime/session/model and approval surfaces;
- task, plan, subagent, background, workflow, checkpoint, review, and completion;
- memory, project memory, skills, tools, MCP, inbox, schedules, notifications, artifacts, verification, workspace/Git, desktop/UIA/vision, providers, and the old `s` CLI;
- DSH code-preset and installed Profile capabilities that already replace them.

Do not modify `runtime/xiaoshe-legacy` during inventory.

**Step 3: Classify every capability**

Use only the approved statuses: `DSH 已提供`, `XS 已提供`, `应迁移`, `暂留 Provider`, `淘汰`, `外部阻塞`. Include specific evidence and avoid classifying a module name as a user capability without tracing its public surface.

**Step 4: Verify completeness**

```powershell
pnpm.cmd vitest run tests/legacy-capability-ledger.test.ts
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add scripts/audit-legacy-capabilities.mjs tests/legacy-capability-ledger.test.ts docs/LEGACY_CAPABILITY_LEDGER.md docs/evidence/2026-08-22-legacy-capability-inventory.json
git diff --cached --check
git commit -m "docs: classify legacy capabilities for DSH migration"
```

---

### Task 10: Migrate the Windows-verifiable legacy capability wave

**Files:**

- Modify according to ledger decision: `src/**`, `client.js`, `scripts/**`, `tests/**`, `cordis.patch.yml`
- Modify only if a Provider contract must change: `python/xiaoshe_desktop_bridge.py`, `python/tests/test_bridge.py`
- Modify only with a separately documented need: `runtime/DSH/**`
- Modify: `docs/LEGACY_CAPABILITY_LEDGER.md`
- Create: `docs/evidence/2026-08-22-legacy-migration-wave-1.md`

**Step 1: Select only entries marked `应迁移`**

Prioritize Windows-verifiable gaps with high user value: the old `s` entry's useful behavior mapped to the shared DSH Runtime, Provider readiness/doctor information not already visible, desktop evidence persistence boundaries, and multi-display selection if the current hardware can verify it.

Do not migrate old Agent loops, model routers, sessions, approvals, plan/task stores, or other features already owned by DSH.

**Step 2: Create one failing contract test per selected capability**

Place the test in the owning repository and run only that test. Record the failure showing the user-visible gap, not an implementation detail.

**Step 3: Implement through official boundaries**

Prefer XS tools, routes, settings, client slots, and scripts. Use DSH changes only if no external extension point can express the accepted contract and after reading `runtime/DSH/AGENTS.md`. Keep dangerous actions behind the existing DSH approval pipeline.

**Step 4: Prove parity and Windows behavior**

Run the new contract test, root `pnpm.cmd run check`, affected DSH gates, and a real Windows interaction when the capability is user-visible or desktop-related.

**Step 5: Update ledger state and commit per capability**

Each capability receives its own commit. Change `应迁移` to `XS 已提供` or `DSH 已提供` only after the same acceptance set passes. Leave partially implemented items explicit.

---

### Task 11: Final clean-room verification and handoff closure

**Files:**

- Create: `docs/evidence/2026-08-22-windows-final-verification.md`
- Create: `docs/evidence/2026-08-22-windows-final-verification.json`
- Modify: `README.md`
- Modify: `docs/ACCEPTANCE.md`
- Modify: `docs/IMPLEMENTATION_PLAN.md`
- Modify: `交接工具/从这里开始.md`
- Modify: `交接工具/当前状态.md`
- Regenerate after explicit comparison: `交接工具/完整性清单.json`

**Step 1: Re-run every automated gate from the receiver path**

```powershell
./交接工具/验证交接-Windows.ps1 -Full
pnpm.cmd run check
pnpm.cmd --dir runtime/DSH dsh web --dump-config
```

Record exact versions, counts, durations, and hashes.

**Step 2: Re-run the real Windows smoke**

Repeat start, health, observe, approved safe action, verification, stale rejection, and stop. Confirm no orphan process remains.

**Step 3: Audit the three worktrees**

Compare final status with Task 1. Explain every intentional new commit and every preserved pre-existing change. Run `git fsck --full --no-dangling` in all three repositories.

**Step 4: Regenerate and immediately verify the handoff manifest**

Only after reviewing the diff between the frozen and final source states:

```powershell
node scripts/handoff-manifest.mjs generate
node scripts/handoff-manifest.mjs verify
```

**Step 5: Publish the four-state handoff report**

List:

- completed and verified on Windows;
- implemented but blocked from real verification by an exact external condition;
- audited and intentionally not migrated;
- possible only on the other device/macOS.

Do not call the project complete if a required Windows gate remains red.

**Step 6: Commit documentation without staging unrelated state**

```powershell
git add README.md docs/ACCEPTANCE.md docs/IMPLEMENTATION_PLAN.md docs/evidence/2026-08-22-windows-final-verification.md docs/evidence/2026-08-22-windows-final-verification.json 交接工具/从这里开始.md 交接工具/当前状态.md
git diff --cached --check
git commit -m "docs: close Windows delivery and handoff boundary"
```

If `交接工具/完整性清单.json` is intentionally ignored/generated, keep it out of Git while including its hash and successful verification in the final evidence.
