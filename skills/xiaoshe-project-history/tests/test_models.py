from __future__ import annotations

import unittest

from xiaoshe_history.models import EvidenceStatus, HistoryReport, SourceResult


class HistoryReportModelTests(unittest.TestCase):
    def test_report_serializes_schema_and_partial_state(self) -> None:
        report = HistoryReport(
            generated_at="2026-08-30T00:00:00Z",
            sources=(
                SourceResult(
                    source_id="handoff-25",
                    status=EvidenceStatus.READABLE_NO_SIDECAR,
                ),
            ),
        )

        payload = report.to_dict()

        self.assertEqual(payload["schema"], "xiaoshe-history/v1")
        self.assertEqual(payload["overallStatus"], "partial")
        self.assertEqual(
            payload["sources"][0]["status"],
            "readable-no-sidecar",
        )

    def test_integrity_failure_marks_report_failed(self) -> None:
        report = HistoryReport(
            generated_at="2026-08-30T00:00:00Z",
            sources=(
                SourceResult(
                    source_id="broken",
                    status=EvidenceStatus.INTEGRITY_FAILED,
                    details={"reason": "SHA-256 mismatch"},
                ),
            ),
        )

        self.assertEqual(report.to_dict()["overallStatus"], "failed")

    def test_live_source_keeps_report_partial_until_frozen(self) -> None:
        report = HistoryReport(
            generated_at="2026-08-30T00:00:00Z",
            sources=(
                SourceResult("archive", EvidenceStatus.VERIFIED),
                SourceResult("live", EvidenceStatus.LIVE_UNARCHIVED),
            ),
        )

        self.assertEqual(report.to_dict()["overallStatus"], "partial")

    def test_unreadable_source_is_partial_and_distinct_from_missing(self) -> None:
        report = HistoryReport(
            generated_at="2026-08-30T00:00:00Z",
            sources=(SourceResult("broken-git", EvidenceStatus.UNREADABLE),),
        )

        self.assertEqual(report.overall_status, "partial")
        self.assertEqual(report.to_dict()["sources"][0]["status"], "unreadable")

    def test_cannot_evaluate_payload_keeps_verified_sources_partial(self) -> None:
        report = HistoryReport(
            generated_at="2026-08-30T00:00:00Z",
            sources=(SourceResult("archive", EvidenceStatus.VERIFIED),),
            payload={
                "cannotEvaluate": {
                    "mode": "gaps",
                    "missingPrerequisites": ["stash-evidence"],
                }
            },
        )

        self.assertEqual(report.overall_status, "partial")


if __name__ == "__main__":
    unittest.main()
