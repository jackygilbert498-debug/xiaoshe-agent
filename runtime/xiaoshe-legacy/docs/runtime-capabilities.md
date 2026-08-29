# Runtime capability catalogue

This file is generated from `harness.capabilities.build_core_capability_registry`. Catalogued means only that a public descriptor exists: it does not imply configuration, availability, or verification.
Credential ownership is a protected SecretStore constraint; `keys` is intentionally not a user-facing capability row.

| Capability | Owner | Version | Lifecycle | Entrypoints | Dependencies | Conflicts | Enabled | Configured | Available | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tasking | harness.task_store.TaskStore | 1.0 | process | gui, cli, headless, worker, schedule, pwa, feishu | — | — | false | false | false | false |
| planning | harness.plan_store.PlanStore | 1.0 | task | gui, cli, headless, worker, pwa, feishu | tasking | — | false | false | false | false |
| permission | harness.permission.check | 1.0 | action | gui, cli, headless, worker, schedule, pwa, feishu | — | — | false | false | false | false |
| sandbox | harness.sandbox.run_with_controls | 1.0 | runtime | gui, cli, headless, worker | permission | — | false | false | false | false |
| network | harness.netguard.child_env_for_mode | 1.0 | runtime | gui, cli, headless, worker | permission | — | false | false | false | false |
| heartbeat | harness.task_worker.TaskWorker._start_heartbeat | 1.0 | task | worker | tasking | — | false | false | false | false |
| models | harness.model_registry.ModelRegistry | 1.0 | process | gui, cli, headless, worker | — | — | false | false | false | false |
| memory | harness.project_memory.ProjectMemoryStore | 1.0 | process | gui, cli, headless, worker, pwa, feishu | tasking | — | false | false | false | false |
| effects | harness.effects | 1.0 | action | gui, cli, headless, worker | tasking, permission | — | false | false | false | false |
| verification | harness.verification.VerificationService | 1.0 | task | gui, cli, headless, worker | tasking | — | false | false | false | false |
| ui | harness.ui_server.UISession | 1.0 | runtime | gui, pwa, feishu | tasking, memory | — | false | false | false | false |
| cli | run.py | 1.0 | process | cli, headless | tasking, planning | — | false | false | false | false |
| worker | harness.task_worker.TaskWorker | 1.0 | process | worker | tasking, planning, permission, models, effects, verification, heartbeat | — | false | false | false | false |
| schedule | harness.schedule | 1.0 | process | schedule | tasking | — | false | false | false | false |
