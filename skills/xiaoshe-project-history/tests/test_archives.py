from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from xiaoshe_history.archives import (
    IntegrityError,
    ManifestError,
    _validate_release_member,
    detect_archive_kind,
    read_manifests,
    read_manifest,
    repair_zip_name,
    validate_manifest,
    verify_sidecar,
)
from xiaoshe_history.models import EvidenceStatus


class ArchiveReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.manifest = {
            "schema": "xiaoshe-handoff-manifest/v1",
            "generatedAt": "2026-08-30T00:00:00Z",
            "summary": {"fileCount": 1, "totalBytes": 2},
            "git": [],
            "files": [
                {
                    "path": "README.md",
                    "type": "file",
                    "size": 2,
                    "sha256": hashlib.sha256(b"ok").hexdigest(),
                }
            ],
        }
        self.manifest_bytes = json.dumps(
            self.manifest,
            ensure_ascii=False,
        ).encode("utf-8")

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def make_tar_gz(self, name: str = "handoff.tar.gz") -> Path:
        path = self.root / name
        with tarfile.open(path, "w:gz") as archive:
            info = tarfile.TarInfo("XS/交接工具/完整性清单.json")
            info.size = len(self.manifest_bytes)
            archive.addfile(info, io.BytesIO(self.manifest_bytes))
        return path

    def make_plain_tar(self, name: str = "handoff.tar") -> Path:
        path = self.root / name
        with tarfile.open(path, "w") as archive:
            info = tarfile.TarInfo("XS/交接工具/完整性清单.json")
            info.size = len(self.manifest_bytes)
            archive.addfile(info, io.BytesIO(self.manifest_bytes))
        return path

    def make_release_zip(
        self,
        *,
        windows_commit: str = "3ca964f5096abdb8290e73aeaafff789014312d2",
        macos_commit: str = "3ca964f5096abdb8290e73aeaafff789014312d2",
        extra_name: str = "src/index.ts",
    ) -> Path:
        path = self.root / "小蛇-跨设备交接-3ca964f.zip"
        prefix = "xiaoshe-agent-3ca964f/"

        def report(platform: str, commit: str, generated_at: str) -> bytes:
            return json.dumps(
                {
                    "schemaVersion": 1,
                    "platform": platform,
                    "generatedAt": generated_at,
                    "commit": commit,
                    "checks": [
                        {
                            "id": "desktop-unit-tests",
                            "state": "pass",
                            "detail": "contract tests passed",
                            "evidence": {},
                        }
                    ],
                },
                ensure_ascii=False,
            ).encode("utf-8")

        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(f"{prefix}README.md", b"release")
            archive.writestr(f"{prefix}{extra_name}", b"export const ok = true;\n")
            archive.writestr(
                f"{prefix}_验收/windows-desktop.json",
                report("windows", windows_commit, "2026-08-30T14:45:06Z"),
            )
            archive.writestr(
                f"{prefix}_验收/macos-desktop.json",
                report("macos", macos_commit, "2026-08-30T14:45:31Z"),
            )
        return path

    @staticmethod
    def write_sidecar(path: Path, digest: str | None = None) -> Path:
        digest = digest or hashlib.sha256(path.read_bytes()).hexdigest()
        sidecar = Path(f"{path}.sha256")
        sidecar.write_text(f"{digest}  {path.name}\n", encoding="ascii")
        return sidecar

    def test_zip_magic_wins_over_tar_extension(self) -> None:
        disguised = self.root / "XS.tar"
        with zipfile.ZipFile(disguised, "w") as archive:
            archive.writestr(
                "XS/交接工具/完整性清单.json",
                self.manifest_bytes,
            )

        self.assertEqual(detect_archive_kind(disguised), "zip")
        manifest, observation = read_manifest(disguised)
        self.assertEqual(manifest["summary"]["fileCount"], 1)
        self.assertEqual(
            observation.status,
            EvidenceStatus.CONTAINER_NONCANONICAL,
        )

    def test_valid_sidecar_marks_tar_verified(self) -> None:
        package = self.make_tar_gz()
        self.write_sidecar(package)

        self.assertEqual(verify_sidecar(package), EvidenceStatus.VERIFIED)
        manifest, observation = read_manifest(package)

        self.assertEqual(manifest["schema"], "xiaoshe-handoff-manifest/v1")
        self.assertEqual(observation.status, EvidenceStatus.VERIFIED)
        self.assertTrue(observation.member.endswith("完整性清单.json"))

    def test_plain_tar_is_detected_by_signature_and_read(self) -> None:
        package = self.make_plain_tar()
        self.write_sidecar(package)

        self.assertEqual(detect_archive_kind(package), "tar")
        manifest, observation = read_manifest(package)

        self.assertEqual(manifest["schema"], "xiaoshe-handoff-manifest/v1")
        self.assertEqual(observation.kind, "tar")
        self.assertEqual(observation.status, EvidenceStatus.VERIFIED)

    def test_manifest_schema_and_timestamp_are_strict(self) -> None:
        wrong_schema = dict(self.manifest, schema="xiaoshe-handoff/v1")
        with self.assertRaisesRegex(ManifestError, "schema"):
            validate_manifest(wrong_schema, origin="fixture")

        local_time = dict(self.manifest, generatedAt="2026-08-30T08:00:00")
        with self.assertRaisesRegex(ManifestError, "timezone"):
            validate_manifest(local_time, origin="fixture")

    def test_manifest_rejects_unsafe_duplicate_and_noncanonical_paths(self) -> None:
        for unsafe in ("../secret.txt", "/absolute.txt", "folder\\file.txt", "./file.txt"):
            payload = dict(self.manifest)
            payload["files"] = [dict(self.manifest["files"][0], path=unsafe)]
            with self.subTest(path=unsafe), self.assertRaisesRegex(ManifestError, "path"):
                validate_manifest(payload, origin="fixture")

        duplicate = dict(self.manifest)
        duplicate["summary"] = {"fileCount": 2, "totalBytes": 4}
        duplicate["files"] = [dict(self.manifest["files"][0]), dict(self.manifest["files"][0])]
        with self.assertRaisesRegex(ManifestError, "duplicate"):
            validate_manifest(duplicate, origin="fixture")

    def test_manifest_rejects_invalid_file_metadata_and_summary(self) -> None:
        cases = []
        cases.append(dict(self.manifest["files"][0], size=-1))
        cases.append(dict(self.manifest["files"][0], type="directory"))
        cases.append(dict(self.manifest["files"][0], sha256="abc"))
        for record in cases:
            payload = dict(self.manifest)
            payload["files"] = [record]
            with self.subTest(record=record), self.assertRaises(ManifestError):
                validate_manifest(payload, origin="fixture")

        wrong_count = dict(self.manifest)
        wrong_count["summary"] = {"fileCount": 2, "totalBytes": 2}
        with self.assertRaisesRegex(ManifestError, "fileCount"):
            validate_manifest(wrong_count, origin="fixture")

        wrong_bytes = dict(self.manifest)
        wrong_bytes["summary"] = {"fileCount": 1, "totalBytes": 99}
        with self.assertRaisesRegex(ManifestError, "totalBytes"):
            validate_manifest(wrong_bytes, origin="fixture")

    def test_zip_manifest_size_is_checked_before_read(self) -> None:
        package = self.root / "oversized.zip"
        with zipfile.ZipFile(package, "w") as archive:
            archive.writestr("XS/交接工具/完整性清单.json", self.manifest_bytes)

        with patch("xiaoshe_history.archives._MAX_MANIFEST_BYTES", len(self.manifest_bytes) - 1):
            with self.assertRaisesRegex(ManifestError, "size limit"):
                read_manifests(package)

    def test_hash_mismatch_blocks_manifest_read(self) -> None:
        package = self.make_tar_gz()
        self.write_sidecar(package, "0" * 64)

        with self.assertRaisesRegex(IntegrityError, "SHA-256 mismatch"):
            read_manifest(package)

    def test_missing_sidecar_is_readable_but_not_verified(self) -> None:
        package = self.make_tar_gz()

        manifest, observation = read_manifest(package)

        self.assertEqual(manifest["summary"]["totalBytes"], 2)
        self.assertEqual(
            observation.status,
            EvidenceStatus.READABLE_NO_SIDECAR,
        )

    def test_manifestless_release_zip_derives_bounded_snapshot_from_acceptance_reports(self) -> None:
        package = self.make_release_zip()

        manifest, observation = read_manifest(package)

        self.assertEqual(manifest["schema"], "xiaoshe-handoff-manifest/v1")
        self.assertEqual(
            manifest["commit"],
            "3ca964f5096abdb8290e73aeaafff789014312d2",
        )
        self.assertEqual(manifest["generatedAt"], "2026-08-30T14:45:31Z")
        self.assertEqual(
            {item["path"] for item in manifest["files"]},
            {
                "README.md",
                "src/index.ts",
                "_验收/windows-desktop.json",
                "_验收/macos-desktop.json",
            },
        )
        self.assertEqual(observation.status, EvidenceStatus.READABLE_NO_SIDECAR)
        self.assertTrue(observation.member.startswith("derived:"))

    def test_manifestless_release_zip_rejects_unsafe_path_and_commit_disagreement(self) -> None:
        unsafe = self.make_release_zip(extra_name="../escape.txt")
        with self.assertRaisesRegex(ManifestError, "safe relative path"):
            read_manifest(unsafe)

        unsafe.unlink()
        mismatch = self.make_release_zip(macos_commit="0" * 40)
        with self.assertRaisesRegex(ManifestError, "commit mismatch"):
            read_manifest(mismatch)

    def test_release_member_validator_rejects_encryption_and_symlinks(self) -> None:
        encrypted = zipfile.ZipInfo("release/README.md")
        encrypted.flag_bits |= 0x1
        with self.assertRaisesRegex(ManifestError, "encrypted"):
            _validate_release_member(encrypted, origin="fixture.zip")

        symlink = zipfile.ZipInfo("release/link")
        symlink.create_system = 3
        symlink.external_attr = (0o120777 << 16)
        with self.assertRaisesRegex(ManifestError, "special or symbolic"):
            _validate_release_member(symlink, origin="fixture.zip")

    def test_reader_does_not_extract_files(self) -> None:
        package = self.make_tar_gz()
        before = sorted(path.relative_to(self.root) for path in self.root.rglob("*"))

        read_manifest(package)

        after = sorted(path.relative_to(self.root) for path in self.root.rglob("*"))
        self.assertEqual(after, before)

    def test_multiple_direct_manifests_are_rejected(self) -> None:
        package = self.root / "ambiguous.zip"
        with zipfile.ZipFile(package, "w") as archive:
            archive.writestr("one/交接工具/完整性清单.json", self.manifest_bytes)
            archive.writestr("two/交接工具/完整性清单.json", self.manifest_bytes)

        with self.assertRaisesRegex(ManifestError, "multiple manifests"):
            read_manifest(package)

    def test_invalid_json_is_rejected_with_member_name(self) -> None:
        package = self.root / "invalid.zip"
        with zipfile.ZipFile(package, "w") as archive:
            archive.writestr("XS/交接工具/完整性清单.json", b"{")

        with self.assertRaisesRegex(ManifestError, "完整性清单.json"):
            read_manifest(package)

    def test_repair_zip_name_recovers_utf8_bytes_decoded_as_cp437(self) -> None:
        mojibake = "交接工具".encode("utf-8").decode("cp437")
        self.assertEqual(repair_zip_name(mojibake), "交接工具")

    def test_manifest_can_be_streamed_from_one_embedded_tar_gz(self) -> None:
        inner = io.BytesIO()
        with tarfile.open(fileobj=inner, mode="w:gz") as archive:
            info = tarfile.TarInfo("XS/交接工具/完整性清单.json")
            info.size = len(self.manifest_bytes)
            archive.addfile(info, io.BytesIO(self.manifest_bytes))
        outer = self.root / "outer.zip"
        with zipfile.ZipFile(outer, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("XS-完整交接包-20260825-220546.tar.gz", inner.getvalue())

        manifest, observation = read_manifest(outer)

        self.assertEqual(manifest["generatedAt"], "2026-08-30T00:00:00Z")
        self.assertIn("!", observation.member)
        self.assertEqual(
            observation.status,
            EvidenceStatus.READABLE_NO_SIDECAR,
        )

    def test_multi_snapshot_zip_deduplicates_direct_and_verified_inner_manifest(self) -> None:
        def inner_bytes(generated_at: str) -> bytes:
            payload = dict(self.manifest)
            payload["generatedAt"] = generated_at
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
                info = tarfile.TarInfo("XS/交接工具/完整性清单.json")
                info.size = len(raw)
                archive.addfile(info, io.BytesIO(raw))
            return buffer.getvalue()

        direct = dict(self.manifest)
        direct["generatedAt"] = "2026-08-26T13:45:37Z"
        duplicate = inner_bytes("2026-08-26T13:45:37Z")
        earlier = inner_bytes("2026-08-25T14:05:38Z")
        outer = self.root / "XS.tar"
        duplicate_name = "XS/交接工具/XS-完整交接包-20260826-214545.tar.gz"
        earlier_name = "XS/交接工具/XS-完整交接包-20260825-220546.tar.gz"
        with zipfile.ZipFile(outer, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr(
                "XS/交接工具/完整性清单.json",
                json.dumps(direct, ensure_ascii=False).encode("utf-8"),
            )
            archive.writestr(duplicate_name, duplicate)
            archive.writestr(
                f"{duplicate_name}.sha256",
                hashlib.sha256(duplicate).hexdigest(),
            )
            archive.writestr(earlier_name, earlier)

        results = read_manifests(outer)

        self.assertEqual(
            [manifest["generatedAt"] for manifest, _ in results],
            ["2026-08-25T14:05:38Z", "2026-08-26T13:45:37Z"],
        )
        self.assertEqual(
            [observation.status for _, observation in results],
            [EvidenceStatus.READABLE_NO_SIDECAR, EvidenceStatus.VERIFIED],
        )

    def test_bad_embedded_sidecar_blocks_multi_snapshot_read(self) -> None:
        inner = io.BytesIO()
        with tarfile.open(fileobj=inner, mode="w:gz") as archive:
            info = tarfile.TarInfo("XS/交接工具/完整性清单.json")
            info.size = len(self.manifest_bytes)
            archive.addfile(info, io.BytesIO(self.manifest_bytes))
        outer = self.root / "outer.zip"
        name = "XS-完整交接包-20260825-220546.tar.gz"
        with zipfile.ZipFile(outer, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr(name, inner.getvalue())
            archive.writestr(f"{name}.sha256", "0" * 64)

        with self.assertRaisesRegex(IntegrityError, "embedded SHA-256 mismatch"):
            read_manifests(outer)

    def test_unknown_magic_is_rejected(self) -> None:
        path = self.root / "not-an-archive.tar.gz"
        path.write_bytes(b"plain text")
        self.assertEqual(detect_archive_kind(path), "unknown")
        with self.assertRaisesRegex(ManifestError, "unsupported archive"):
            read_manifest(path)


if __name__ == "__main__":
    unittest.main()
