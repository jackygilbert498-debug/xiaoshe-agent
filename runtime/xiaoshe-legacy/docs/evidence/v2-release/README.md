# Xiaoshe v2 release evidence

This directory binds release evidence to one immutable functional commit. The
validator reads only the two fixed evidence JSON files, the fixed G12 status
file, Git metadata, and two allowlisted release artifacts. It rejects a
non-top-level root and any symlink or junction before reading. It never follows
record-supplied paths or reads session content, SecretStore, `.state`, model
responses, or raw logs.

Run:

```powershell
py -3 -X utf8 scripts/validate_v2_release.py --candidate docs/evidence/v2-release/candidate.json --observation docs/evidence/v2-release/observation-summary.json
```

`structural_pass: true` means only that the record is well formed. `action`
remains `hold` until the repository is clean, the strict full suite passes,
and every external gate is genuinely completed against the same functional
HEAD and exact benchmark/Windows-launcher artifact set. The G12 status must
self-hash and bind the candidate hash, observation hash, action, and blocker
hash. `not_run` and `partial` are deliberate facts, not
placeholders. Never replace them with estimates, unit-test counts, or mock
results.

The current candidate is held because the inherited worktree is dirty, the
strict Python suite is not green, and the time/device/user/independent-review
gates have not been run. The full-suite log is represented only by its digest;
the log itself is not committed.
