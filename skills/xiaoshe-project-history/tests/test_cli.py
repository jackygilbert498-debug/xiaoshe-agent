from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "history_inventory.py"
SCRIPTS = SKILL_ROOT / "scripts"


class HistoryCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.archives = self.root / "archives"
        self.archives.mkdir()
        self.output = self.root / "report.json"

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def make_archive(
        self,
        *,
        name: str = "XS-完整交接包-20260830-000000.tar.gz",
        content: bytes = b"ok",
        good_sidecar: bool = True,
        with_sidecar: bool = True,
    ) -> Path:
        manifest = {
            "schema": "xiaoshe-handoff-manifest/v1",
            "generatedAt": "2026-08-30T00:00:00Z",
            "summary": {"fileCount": 1, "totalBytes": len(content)},
            "git": [],
            "files": [
                {
                    "path": "README.md",
                    "type": "file",
                    "size": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                }
            ],
        }
        raw = json.dumps(manifest).encode("utf-8")
        package = self.archives / name
        with tarfile.open(package, "w:gz") as archive:
            info = tarfile.TarInfo("XS/交接工具/完整性清单.json")
            info.size = len(raw)
            archive.addfile(info, io.BytesIO(raw))
        digest = hashlib.sha256(package.read_bytes()).hexdigest()
        if not good_sidecar:
            digest = "0" * 64
        if with_sidecar:
            Path(f"{package}.sha256").write_text(digest, encoding="ascii")
        return package

    def write_config(self, sources: list[dict[str, str]]) -> Path:
        config = self.root / "sources.json"
        config.write_text(
            json.dumps(
                {"schema": "xiaoshe-history-sources/v1", "sources": sources},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return config

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ)
        env["PYTHONPATH"] = str(SCRIPTS)
        env["PYTHONIOENCODING"] = "utf-8"
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
        )

    def test_no_arguments_returns_configuration_exit_code(self) -> None:
        result = self.run_cli()
        self.assertEqual(result.returncode, 3)
        self.assertIn("usage:", result.stderr.lower())

    def test_configure_generates_v2_and_refuses_implicit_overwrite(self) -> None:
        xs = self.root / "我的 XS"
        target = self.root / "local sources.json"

        first = self.run_cli(
            "configure",
            "--xs-root",
            str(xs),
            "--output",
            str(target),
        )
        before = target.read_bytes()
        second = self.run_cli(
            "configure",
            "--xs-root",
            str(xs),
            "--output",
            str(target),
        )

        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(json.loads(before)["schema"], "xiaoshe-history-sources/v2")
        self.assertEqual(second.returncode, 3)
        self.assertEqual(target.read_bytes(), before)

    def test_configure_published_layout_does_not_invent_nested_git_sources(self) -> None:
        release = self.root / "公开版"
        target = self.root / "published sources.json"

        result = self.run_cli(
            "configure",
            "--layout",
            "published",
            "--xs-root",
            str(release),
            "--handoff-directory",
            str(self.archives),
            "--output",
            str(target),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(target.read_text(encoding="utf-8"))
        self.assertEqual(
            [source["id"] for source in payload["sources"]],
            ["xiaoshe-release", "handoffs"],
        )

    def test_doctor_missing_source_returns_three_and_writes_json(self) -> None:
        config = self.write_config(
            [{"id": "missing", "kind": "git", "path": str(self.root / "missing")}]
        )

        result = self.run_cli(
            "doctor",
            "--config",
            str(config),
            "--json-output",
            str(self.output),
        )

        self.assertEqual(result.returncode, 3, result.stderr)
        payload = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(payload["schema"], "xiaoshe-history-doctor/v1")
        self.assertEqual(payload["overallStatus"], "fail")

    def test_verified_archive_directory_returns_zero_and_writes_report(self) -> None:
        self.make_archive()
        config = self.write_config(
            [{"id": "handoffs", "kind": "archive-directory", "path": str(self.archives)}]
        )

        result = self.run_cli(
            "inventory",
            "--config",
            str(config),
            "--output",
            str(self.output),
            "--pretty",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(payload["overallStatus"], "complete")
        self.assertEqual(payload["sources"][0]["status"], "verified")
        self.assertTrue(self.output.read_bytes().endswith(b"\n"))

    def test_missing_source_returns_partial_exit_code(self) -> None:
        config = self.write_config(
            [{"id": "missing", "kind": "git", "path": str(self.root / "missing")}]
        )

        result = self.run_cli(
            "inventory",
            "--config",
            str(config),
            "--output",
            str(self.output),
        )

        self.assertEqual(result.returncode, 2, result.stderr)
        payload = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(payload["sources"][0]["status"], "missing")

    def test_integrity_mismatch_returns_three_without_trusting_manifest(self) -> None:
        self.make_archive(good_sidecar=False)
        config = self.write_config(
            [{"id": "handoffs", "kind": "archive-directory", "path": str(self.archives)}]
        )

        result = self.run_cli(
            "inventory",
            "--config",
            str(config),
            "--output",
            str(self.output),
        )

        self.assertEqual(result.returncode, 3, result.stderr)
        payload = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(payload["sources"][0]["status"], "integrity-failed")
        self.assertIn("SHA-256 mismatch", payload["sources"][0]["details"]["error"])

    def test_invalid_config_does_not_replace_existing_output(self) -> None:
        self.output.write_text('{"sentinel":true}\n', encoding="utf-8")
        config = self.root / "invalid.json"
        config.write_text('{"schema":"wrong","sources":[]}', encoding="utf-8")

        result = self.run_cli(
            "inventory",
            "--config",
            str(config),
            "--output",
            str(self.output),
        )

        self.assertEqual(result.returncode, 3)
        self.assertEqual(
            self.output.read_text(encoding="utf-8"),
            '{"sentinel":true}\n',
        )

    def test_archive_directory_includes_distinct_embedded_snapshots(self) -> None:
        def manifest_bytes(generated_at: str) -> bytes:
            return json.dumps(
                {
                    "schema": "xiaoshe-handoff-manifest/v1",
                    "generatedAt": generated_at,
                    "summary": {"fileCount": 0, "totalBytes": 0},
                    "git": [],
                    "files": [],
                }
            ).encode("utf-8")

        inner = io.BytesIO()
        earlier = manifest_bytes("2026-08-25T14:05:38Z")
        with tarfile.open(fileobj=inner, mode="w:gz") as archive:
            info = tarfile.TarInfo("XS/交接工具/完整性清单.json")
            info.size = len(earlier)
            archive.addfile(info, io.BytesIO(earlier))
        outer = self.archives / "XS.tar"
        with zipfile.ZipFile(outer, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr(
                "XS/交接工具/完整性清单.json",
                manifest_bytes("2026-08-26T13:45:37Z"),
            )
            archive.writestr(
                "XS/交接工具/XS-完整交接包-20260825-220546.tar.gz",
                inner.getvalue(),
            )
        config = self.write_config(
            [{"id": "handoffs", "kind": "archive-directory", "path": str(self.archives)}]
        )

        result = self.run_cli(
            "timeline",
            "--config",
            str(config),
            "--output",
            str(self.output),
        )

        self.assertEqual(result.returncode, 2, result.stderr)
        payload = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(payload["snapshotCount"], 2)
        self.assertEqual(len(payload["timeline"]), 2)

    def test_gaps_without_stash_evidence_is_explicitly_not_evaluable(self) -> None:
        self.make_archive()
        config = self.write_config(
            [{"id": "handoffs", "kind": "archive-directory", "path": str(self.archives)}]
        )

        result = self.run_cli(
            "gaps",
            "--config",
            str(config),
            "--output",
            str(self.output),
        )

        self.assertEqual(result.returncode, 2, result.stderr)
        payload = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(payload["overallStatus"], "partial")
        self.assertEqual(
            payload["cannotEvaluate"]["missingPrerequisites"],
            ["stash-evidence"],
        )

    def test_compare_exit_code_reflects_evidence_and_content(self) -> None:
        before = self.make_archive(name="before.tar.gz", content=b"same")
        after = self.make_archive(name="after.tar.gz", content=b"same")
        equal_output = self.root / "equal.json"

        equal = self.run_cli(
            "compare",
            "--before",
            str(before),
            "--after",
            str(after),
            "--output",
            str(equal_output),
        )

        self.assertEqual(equal.returncode, 0, equal.stderr)
        equal_payload = json.loads(equal_output.read_text(encoding="utf-8"))
        self.assertEqual(equal_payload["beforeEvidenceStatus"], "verified")
        self.assertEqual(equal_payload["afterEvidenceStatus"], "verified")

        unverified = self.make_archive(
            name="unverified.tar.gz",
            content=b"same",
            with_sidecar=False,
        )
        partial_output = self.root / "partial.json"
        partial = self.run_cli(
            "compare",
            "--before",
            str(before),
            "--after",
            str(unverified),
            "--output",
            str(partial_output),
        )
        self.assertEqual(partial.returncode, 2, partial.stderr)

        changed = self.make_archive(name="changed.tar.gz", content=b"changed")
        changed_output = self.root / "changed.json"
        different = self.run_cli(
            "compare",
            "--before",
            str(before),
            "--after",
            str(changed),
            "--output",
            str(changed_output),
        )
        self.assertEqual(different.returncode, 2, different.stderr)
        different_payload = json.loads(changed_output.read_text(encoding="utf-8"))
        self.assertEqual(different_payload["changed"], ["README.md"])


if __name__ == "__main__":
    unittest.main()
