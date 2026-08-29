# Task 1 report: irreversible effects and task recovery

## P1 fourth review addendum

### RED

- `test_task_effect_does_not_execute_or_drop_its_record_inside_recovery_fence` initially exposed that the regression fixture was blocked by PlanGate rather than reaching the real tool. The fixture now supplies an approved plan revision and an in-scope file, then verifies the real call races recovery.
- `test_task_effect_keeps_pending_ledger_entry_when_completion_persistence_fails` failed before the implementation because task effects had no durable pending record or completion API.

### GREEN

- Task-bound side-effect tools now acquire the same effects JSONL fence before calling `tools.execute` and retain it through checkpoint handling and effect-ledger completion. The task-side wait is explicitly bounded at 30 seconds and returns an explicit no-execution error if the fence cannot be acquired.
- A pending, redacted ledger entry is persisted before external execution. If final completion persistence fails after the real effect, the pending entry remains and recovery presents it as `unknown` / `needs_review`; no executed effect is silently discarded.
- The threaded recovery regression confirms a real `write_file` call only runs after recovery finishes, persists its task association, and does not bypass its result acknowledgement path.
- Both new regressions pass. `tests.test_effects` passes after updating its command target assertion to the existing safe `command` category. Python compilation, JavaScript syntax, and whitespace checks pass.

### Incremental files

- `harness/agent.py`
- `harness/effects.py`
- `tests/test_workspace_recovery.py`
- `tests/test_effects.py`
- `.superpowers/sdd/05-工作树与任务级恢复/task-1-report.md`

## RED

- `py -3 -m unittest tests.test_workspace_recovery.WorkspaceRecoveryTests.test_irreversible_effect_after_checkpoint_requires_matching_acknowledgement -v`
  - Failed as expected: `RecoveryService` did not accept the task-scoped effects ledger, so recovery could not bind irreversible effects to a preview.
- `py -3 -m unittest tests.test_workspace_recovery.WorkspaceRecoveryTests.test_recovery_api_requires_explicit_boolean_effect_acknowledgement -v`
  - Failed as expected: missing acknowledgement returned `200` instead of rejecting a non-explicit acknowledgement.
- `py -3 -m unittest tests.test_workspace_recovery.WorkspaceRecoveryTests.test_task_bound_legacy_effect_is_unknown_and_requires_review -v`
  - Failed as expected: a legacy effect summary exposed its target instead of showing the item as unknown/needs-review.

## GREEN

- Focused recovery/effect tests: 20 passing after the final change.
- `node --check ui/js/tasking/workspace-recovery-view.js` passed.
- `py -3 -m compileall -q harness/effects.py harness/task_recovery.py harness/task_api.py` passed.
- Required existing suite command was run: `py -3 -m unittest tests.test_workspace_recovery tests.test_effects_irreversible -v`.
- `tests.test_effects_irreversible`: 16 passing.
  - `tests.test_workspace_recovery`: 10 passing; one pre-existing environment failure described below.

## Changed files

- `harness/effects.py`
- `harness/task_recovery.py`
- `harness/task_api.py`
- `ui/js/tasking/workspace-recovery-view.js`
- `tests/test_workspace_recovery.py`
- `.superpowers/sdd/05-工作树与任务级恢复/task-1-report.md`

## P1 second review addendum

### RED

- `test_effect_injected_after_execution_record_waits_until_manifest_recovery_finishes` failed because an effect recorded immediately after `create_recovery_execution` could complete before the manifest restore finished.

### GREEN

- `effects.recovery_guard` uses the exact same JSONL sidecar lock as `record_effect`.
- Recovery now holds that guard for the final effects comparison, execution record, every manifest file operation, and execution completion record. A late recorder therefore runs only before the final fence (causing stale) or after recovery completion.
- The threaded regression joins without a deadlock and observes its effect recorded only after recovery completion.
- Focused recovery/effects tests: 20 passing. JavaScript syntax and Python compilation checks pass.
- Required recovery/effects rerun: 32 passing; the same one Windows symlink-privilege setup failure remains.

### Incremental files

- `harness/effects.py`
- `harness/task_recovery.py`
- `tests/test_workspace_recovery.py`
- `.superpowers/sdd/05-工作树与任务级恢复/task-1-report.md`

## Commit

- `Plan05: bind irreversible effects to task recovery` (task-scoped commit).

## Concerns

- The required full workspace-recovery suite has one Windows-only baseline failure: `test_path_policy_rejects_project_overlap_and_symlink_escape` cannot create its test symlink (`WinError 1314`, current account lacks the required privilege). No recovery code runs before that failing setup operation.
- Recovery remains manifest-only: external effects are presented for acknowledgement only and are never replayed, deleted, or claimed reversible.

## P1 review addendum

### RED

- `test_effect_added_after_recovery_before_checkpoint_blocks_manifest_restore` failed because an effect injected immediately after `recovery_before` was not rechecked before the manifest write.
- `test_new_command_effect_uses_fixed_safe_summary_in_ledger_and_preview` failed because the ledger kept the command argument as `target`.
- `test_task_bound_effect_missing_success_flag_is_needs_review` failed because the incomplete task-bound record was silently omitted.

### GREEN

- The recovery service now compares the task effect summaries again after `recovery_before` and before any manifest mutation; a mismatch raises `RECOVERY_PREVIEW_STALE` while retaining the before checkpoint.
- New command and native UI text records store fixed categories only. Recovery/API/UI summaries return fixed safe categories only for complete version-2 records; old, malformed, and invalid-ID entries become `unknown` with `needs_review`.
- Focused P1 plus irreversible-effects tests: 21 passing. JavaScript syntax and Python compilation checks pass.
- Required recovery/effects rerun: 31 passing; the same one Windows symlink-privilege setup failure remains.

### Incremental files

- `harness/effects.py`
- `harness/task_recovery.py`
- `tests/test_workspace_recovery.py`
- `.superpowers/sdd/05-工作树与任务级恢复/task-1-report.md`
