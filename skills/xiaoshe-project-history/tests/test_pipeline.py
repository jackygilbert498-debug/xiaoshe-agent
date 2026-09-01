from __future__ import annotations

import json
import unittest

from xiaoshe_history.git_sources import GitFileRecord, StashSnapshot
from xiaoshe_history.models import (
    EvidenceStatus,
    FileRecord,
    HistoryReport,
    Snapshot,
    SourceResult,
)
from xiaoshe_history.pipeline import (
    analyze_gaps,
    build_timeline,
    compare_snapshots,
    export_course_evidence,
    find_gaps,
)


class PipelineTests(unittest.TestCase):
    @staticmethod
    def snapshot(source_id: str, files: dict[str, str], generated_at: str = "2026-08-30T00:00:00Z") -> Snapshot:
        return Snapshot(
            source_id=source_id,
            generated_at=generated_at,
            files=tuple(
                FileRecord(path=path, sha256=digest)
                for path, digest in files.items()
            ),
        )

    def test_compare_uses_hashes_not_mtime(self) -> None:
        before = self.snapshot("before", {"a.md": "sha-a", "gone.md": "sha-g"})
        after = self.snapshot("after", {"a.md": "sha-b", "new.md": "sha-n"})

        delta = compare_snapshots(before, after)

        self.assertEqual(delta.added, ("new.md",))
        self.assertEqual(delta.removed, ("gone.md",))
        self.assertEqual(delta.changed, ("a.md",))

    def test_gap_distinguishes_absent_from_changed_content(self) -> None:
        stash = StashSnapshot(
            ref="stash@{1}",
            commit="a" * 40,
            subject="history fixture",
            tracked_files={
                "harness/tools.py": GitFileRecord(
                    "harness/tools.py",
                    "stash-tools",
                    "tracked",
                )
            },
            untracked_files={
                "docs/only-in-stash.md": GitFileRecord(
                    "docs/only-in-stash.md",
                    "stash-only",
                    "untracked",
                )
            },
        )
        archive = self.snapshot(
            "handoff",
            {"runtime/xiaoshe-legacy/harness/tools.py": "newer-tools"},
        )

        gaps = find_gaps(
            (stash,),
            (archive,),
            archive_prefix="runtime/xiaoshe-legacy/",
        )

        self.assertEqual(
            [(gap.path, gap.reason) for gap in gaps],
            [
                ("docs/only-in-stash.md", "path-absent"),
                ("harness/tools.py", "same-path-different-content"),
            ],
        )

    def test_exact_stash_blob_is_not_reported_as_gap(self) -> None:
        stash = StashSnapshot(
            ref="stash@{2}",
            commit="b" * 40,
            subject="preserved",
            untracked_files={
                "docs/preserved.md": GitFileRecord(
                    "docs/preserved.md",
                    "same-sha",
                    "untracked",
                )
            },
        )
        archive = self.snapshot(
            "handoff",
            {"runtime/xiaoshe-legacy/docs/preserved.md": "same-sha"},
        )

        self.assertEqual(
            find_gaps(
                (stash,),
                (archive,),
                archive_prefix="runtime/xiaoshe-legacy/",
            ),
            (),
        )

    def test_gaps_cannot_be_evaluated_without_both_evidence_classes(self) -> None:
        archive = self.snapshot("handoff", {"legacy/a.md": "same"})

        no_stashes = analyze_gaps((), (archive,), archive_prefix="legacy/")
        no_snapshots = analyze_gaps(
            (
                StashSnapshot(
                    ref="stash@{0}",
                    commit="c" * 40,
                    subject="fixture",
                ),
            ),
            (),
            archive_prefix="legacy/",
        )

        self.assertEqual(no_stashes.status, "cannotEvaluate")
        self.assertEqual(no_stashes.missing_prerequisites, ("stash-evidence",))
        self.assertEqual(no_snapshots.status, "cannotEvaluate")
        self.assertEqual(no_snapshots.missing_prerequisites, ("snapshot-evidence",))

    def test_gap_mapping_uses_caller_archive_prefix(self) -> None:
        stash = StashSnapshot(
            ref="stash@{0}",
            commit="d" * 40,
            subject="prefix fixture",
            tracked_files={"src/a.py": GitFileRecord("src/a.py", "same", "tracked")},
        )
        archive = self.snapshot("handoff", {"custom/location/src/a.py": "same"})

        analysis = analyze_gaps(
            (stash,),
            (archive,),
            archive_prefix="custom/location/",
        )

        self.assertEqual(analysis.status, "evaluated")
        self.assertEqual(analysis.gaps, ())

    def test_timeline_is_sorted_and_has_stable_evidence_ids(self) -> None:
        late = self.snapshot("handoff-20260830", {}, "2026-08-29T17:37:04Z")
        early = self.snapshot("handoff-20260825", {}, "2026-08-25T14:05:38Z")

        timeline = build_timeline((late, early))

        self.assertEqual(
            [entry.source_id for entry in timeline],
            ["handoff-20260825", "handoff-20260830"],
        )
        self.assertEqual(timeline[0].evidence_id, "EV-SNAPSHOT-HANDOFF-20260825")

    def test_compare_rejects_parent_traversal_in_manual_snapshot(self) -> None:
        unsafe = self.snapshot("unsafe", {"../secret": "sha"})
        safe = self.snapshot("safe", {"secret": "sha"})

        with self.assertRaisesRegex(ValueError, "relative path"):
            compare_snapshots(unsafe, safe)

    def test_course_export_removes_absolute_source_paths(self) -> None:
        report = HistoryReport(
            generated_at="2026-08-30T00:00:00Z",
            sources=(
                SourceResult(
                    "xs",
                    EvidenceStatus.LIVE_UNARCHIVED,
                    {
                        "path": r"C:\Users\someone\Desktop\XS",
                        "head": "a" * 40,
                        "commit": "b" * 40,
                        "acceptanceAlignment": "stale",
                        "acceptanceReports": [
                            {
                                "platform": "macos",
                                "commit": "c" * 40,
                                "headMatch": False,
                            }
                        ],
                    },
                ),
            ),
            payload={
                "timeline": [
                    {
                        "evidenceId": "EV-SNAPSHOT-XS",
                        "sourceId": "xs",
                        "observedAt": "2026-08-30T00:00:00Z",
                        "title": "Current XS",
                        "status": "live-unarchived",
                    }
                ],
                "deltas": [
                    {
                        "beforeId": "old",
                        "afterId": "new",
                        "added": ["docs/new.md"],
                        "removed": [],
                        "changed": [],
                    }
                ],
                "gaps": [],
            },
        )

        exported = export_course_evidence(report)
        encoded = json.dumps(exported, ensure_ascii=False)

        self.assertNotIn("C:\\Users", encoded)
        self.assertEqual(exported["schema"], "agent-workbench-evidence/v1")
        self.assertEqual(exported["sources"][0]["sourceId"], "xs")
        self.assertEqual(exported["sources"][0]["commit"], "b" * 40)
        self.assertEqual(exported["sources"][0]["acceptanceAlignment"], "stale")
        self.assertFalse(exported["sources"][0]["acceptanceReports"][0]["headMatch"])
        self.assertTrue(exported["sources"][0]["limitations"])
        self.assertEqual(exported["deltas"][0]["added"], ["docs/new.md"])


if __name__ == "__main__":
    unittest.main()
