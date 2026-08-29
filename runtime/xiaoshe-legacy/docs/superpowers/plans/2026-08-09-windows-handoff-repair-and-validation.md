# Windows handoff repair and validation plan

> **For the delivery team:** execute this plan in order.  Do not reset, clean,
> or broadly stage the inherited working tree; it is the current synchronized
> source package.

**Goal:** repair the reproducible Windows UTF-8 decoding failure, then complete
the handoff package's locally runnable checks and record the remaining external
or time-bound gates truthfully.

**Scope:** `tests/test_engineering_backlog.py`, new local validation evidence,
and the Windows handoff note only.  Provider secrets, `.env`, `.state`, release
status, and unrelated inherited changes are explicitly out of scope.

## Task 1 — Windows UTF-8 regression repair

**Files:**
- Modify: `tests/test_engineering_backlog.py`

1. RED (already reproduced on this Windows host):

   ```powershell
   py -3 -m unittest tests.test_engineering_backlog.EngineeringBacklogTests.test_repository_backlog_has_126_unique_auditable_items -v
   ```

   Expected before the fix: `UnicodeDecodeError` from the implicit GBK read of
   `docs/backlog/engineering-backlog-status.json`.
2. Make the smallest change: read that known UTF-8 ledger using
   `encoding="utf-8"`, matching `scripts/check_engineering_backlog.py`.
3. GREEN: rerun the exact test, then the source handoff's focused unittest
   cluster.  Do not refactor unrelated test code.
4. Review the exact diff, stage only this file, create a focused commit, and
   have a fresh reviewer rerun the exact test.

## Task 2 — locally runnable handoff acceptance checks

**Evidence directory:** `docs/evidence/windows-handoff-2026-08-09/`

1. Run the focused Python cluster stated in the handoff:

   ```powershell
   py -3 -m unittest tests.test_tasking_baseline tests.test_background_controls tests.test_project_memory tests.test_evidence_redaction tests.test_acceptance_evidence tests.test_engineering_backlog tests.test_release_governance tests.test_commercial_beta_readiness tests.test_release_gates tests.test_release_bundle -q
   ```

2. Run the local structural validators into the evidence directory, without
   converting their intentionally conservative `hold` findings into a pass:

   ```powershell
   py -3 scripts/check_engineering_backlog.py --output docs/evidence/windows-handoff-2026-08-09/engineering-backlog.json
   py -3 scripts/check_acceptance_evidence.py --output docs/evidence/windows-handoff-2026-08-09/acceptance-evidence.json
   py -3 scripts/check_release_governance.py --output docs/evidence/windows-handoff-2026-08-09/release-governance.json
   py -3 scripts/check_commercial_beta_readiness.py --allow-hold
   ```

3. Inspect `scripts/verify_windows.ps1` before execution.  Run it once and
   classify a missing symbolic-link privilege or another host limitation as
   **blocked**, with the command output retained as evidence.  It is not an
   authorization to claim native Windows acceptance.
4. Update the current Windows handoff note with a compact table: completed
   local checks, the exact Windows result, and gates that remain external or
   time-bound.  Preserve release/commercial `hold` status.
5. Review only the files created or intentionally changed for this task,
   commit the evidence/note separately from Task 1, and run the source
   handoff's focused test cluster again as final acceptance.

## Completion criteria

- The previously failing engineering-backlog test is green on this Windows
  host.
- The full focused unittest cluster is green.
- Local reports are present and parsable; any conservative gate remains
  labelled `hold` unless independent evidence has actually changed it.
- `verify_windows.ps1` is either passed with evidence or documented as blocked
  by a verified host prerequisite.
- Each batch has an isolated commit and a fresh review; no secret/config file
  is staged.

## Follow-up discovered by the required native Windows verification

The detailed full run (`2622` tests) found five independent root-cause groups.
They are deliberately separate batches so a platform prerequisite cannot hide a
code regression.

### Task 3 — Windows test-harness portability

**Files:** `tests/test_tasking_eval_contract.py`, `tests/test_path_redteam.py`,
`tests/test_workspace_recovery.py`.

- The tasking-eval test must read the UTF-8 manifest/task files explicitly as
  UTF-8.
- Symlink attack tests must skip *only* when the host reports `WinError 1314`
  while creating their test fixture.  Any other symlink error remains an error;
  hosts with privilege must still run the security checks.
- RED: reproduce the current three errors. GREEN: the eval contract passes and
  the two red-team tests either pass or are explicitly skipped for error 1314.

### Task 4 — Windows absolute path inside the active workspace

**Files:** `harness/permission.py` plus a focused regression assertion in
`tests/test_use_root_and_ids.py` only if needed to clarify the supported
contract.

The current universal rejection of a `C:\\...` input rejects even an absolute
path resolved *inside* the active `use_root` workspace.  On Windows, resolve
the drive-qualified input and then apply the same containment/sensitive checks;
outside-root drive paths must remain rejected.  On non-Windows hosts preserve
the existing hostile-input rejection.  GREEN includes the use-root and
checkpoint/checkpoint-selective modules.

### Task 5 — Undo warning timestamp normalization

**File:** `harness/checkpoint.py`.

`checkpoint.commit` writes local naive timestamps while the effects ledger uses
UTC `Z` timestamps.  The undo warning compared their strings, so a later
external action in UTC could sort before a locally recorded checkpoint.  Make
checkpoint timestamps use the same UTC `Z` representation, preserving all
other record semantics.  The existing selective checkpoint warning test is
the red regression and must turn green.

### Task 6 — Effect-display security contract alignment

**File:** `tests/test_effects_view.py`.

The ledger intentionally records command effects as the safe category
`command`, never raw command text; the older display test still expects
`npm install`.  Update only that assertion to require the safe category and
forbid raw command disclosure.  No production redaction is to be weakened.

### Task 7 — Unsupported DELETE API method contract

**File:** `harness/ui_server.py`.

For an API route that has no DELETE handler (for example `/api/state`), return
the uniform JSON `405 method_not_allowed` rather than the model-profile
DELETE branch's route-specific `404`.  Preserve model-profile DELETE behavior.
GREEN includes `ui_server.test_review_fixes.TestMiscHttpPolish` and focused
model-profile tests.

After Tasks 3–7 each receive the same red→green→scoped commit→independent
review treatment, run full Windows discovery again.  A final result may include
only explicitly justified `skip` for missing host symlink privilege; it must
not claim the security fixture ran on this account.
