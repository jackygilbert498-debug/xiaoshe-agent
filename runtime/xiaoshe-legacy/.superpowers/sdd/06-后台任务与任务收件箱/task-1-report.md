# Plan06 Task 1 report: persistent TaskQueue

## Scope

- Added the durable SQLite `queue_items` ledger and a forward-only TaskStore v11 -> v12 migration.
- Added validated `EnqueueTask`, immutable `QueueItem`, and `TaskQueue` enqueue/readiness/pause/resume/cancel operations.
- Did not modify jobs, headless, schedule, workers, leases, inboxes, task execution, secrets, or external IO.
- Preserved `TaskStatus`; queue states are constrained to `pending|leased|paused|done|failed|cancelled`.

## TDD evidence

1. **RED:** `py -X utf8 -m unittest tests.test_task_queue -v` failed with `ImportError: cannot import name 'EnqueueTask'` before queue interfaces existed.
2. **GREEN:** after the smallest interface/enqueue implementation, the same command passed its initial 1 test.
3. **RED:** after adding ordering, readiness boundary, control, reopen, CAS, cancellation, concurrency, query-plan, and v11-upgrade tests, the focused run failed because `TaskQueue` lacked `list_ready`, `pause`, and `cancel`.
4. **GREEN:** implementation of the queue CRUD/CAS methods made the focused suite pass.
5. **UTC validation regression:** the non-UTC `not_before` test failed when the validation check was removed, then passed after restoring the UTC-only validation.

## Schema and behavior

- `TaskStore.SCHEMA_VERSION` is 12.
- v11 migration creates `queue_items` and partial `queue_items_ready_order` index; the v11 fixture is a production-schema snapshot containing a retained v11 task.
- Upgrade test verifies schema version, table, index, and retained task title/status/version.
- `trigger_key` is globally unique; concurrent duplicate enqueues return the one stored item.
- Ready order is exactly priority descending, then not-before, created-at, and id ascending.  The 10,000-row query-plan test verifies use of the partial ready index rather than a full table scan.
- Pause/resume/cancel use queue item version CAS and never update task status.  Terminal/archived tasks are rejected before insertion.

## Verification

- `py -X utf8 -m unittest tests.test_task_queue tests.test_task_model tests.test_task_store -v`
  - 24 tests passed.
- `py -X utf8 -m compileall -q harness/task_queue.py harness/task_store.py harness/task_model.py`
  - passed.

`tests/test_task_store.py` had one schema-version expectation updated from 11 to 12 under the explicit task authorization.  Its existing backup and legacy-upgrade assertions remain unchanged.
