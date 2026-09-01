#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
from typing import Mapping, Sequence
import zipfile


class ReproductionError(RuntimeError):
    """Raised when a portable workflow step violates its expected contract."""


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_checked(command: Sequence[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            list(command),
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=45,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ReproductionError(f"cannot run {command[0]}: {exc}") from exc
    if result.returncode != 0:
        raise ReproductionError(
            f"command failed ({result.returncode}): {' '.join(command[:3])}\n{result.stderr}"
        )
    return result


def init_repo(path: Path, files: Mapping[str, bytes]) -> None:
    path.mkdir(parents=True, exist_ok=True)
    run_checked(("git", "init", str(path)))
    run_checked(("git", "-C", str(path), "config", "user.email", "portable@example.invalid"))
    run_checked(("git", "-C", str(path), "config", "user.name", "Portable Fixture"))
    for relative, raw in files.items():
        target = path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    run_checked(("git", "-C", str(path), "add", "."))
    run_checked(("git", "-C", str(path), "commit", "-m", "portable baseline"))


def build_manifest(records: Mapping[str, bytes]) -> dict[str, object]:
    files = [
        {
            "path": path,
            "type": "file",
            "size": len(raw),
            "sha256": sha256_bytes(raw),
        }
        for path, raw in sorted(records.items())
    ]
    return {
        "schema": "xiaoshe-handoff-manifest/v1",
        "generatedAt": "2026-08-30T00:00:00Z",
        "summary": {
            "fileCount": len(files),
            "totalBytes": sum(item["size"] for item in files),
        },
        "git": [],
        "files": files,
    }


def tar_bytes(manifest_raw: bytes) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        info = tarfile.TarInfo("XS/交接工具/完整性清单.json")
        info.size = len(manifest_raw)
        info.mtime = 0
        info.mode = 0o644
        archive.addfile(info, io.BytesIO(manifest_raw))
    return buffer.getvalue()


def write_archives(directory: Path, manifest: Mapping[str, object]) -> tuple[Path, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    manifest_raw = json.dumps(
        dict(manifest), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    plain_tar = tar_bytes(manifest_raw)

    before = directory / "before.tar.gz"
    after = directory / "after.tar.gz"
    for target in (before, after):
        with target.open("wb") as raw_stream:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw_stream, mtime=0) as stream:
                stream.write(plain_tar)
        Path(f"{target}.sha256").write_text(sha256_file(target) + "\n", encoding="ascii")

    (directory / "history.tar").write_bytes(plain_tar)
    zip_path = directory / "history.zip"
    info = zipfile.ZipInfo("XS/交接工具/完整性清单.json")
    info.date_time = (1980, 1, 1, 0, 0, 0)
    info.compress_type = zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(zip_path, "w") as archive:
        archive.writestr(info, manifest_raw)
    return before, after


def run_cli_step(
    name: str,
    command: Sequence[str],
    *,
    expected_exit: int,
) -> dict[str, object]:
    try:
        result = subprocess.run(
            list(command),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ReproductionError(f"{name} could not start: {exc}") from exc
    if result.returncode != expected_exit:
        raise ReproductionError(
            f"{name} returned {result.returncode}, expected {expected_exit}: {result.stderr}"
        )
    return {
        "name": name,
        "exitCode": result.returncode,
        "stdoutSha256": sha256_bytes(result.stdout.encode("utf-8")),
        "stderrSha256": sha256_bytes(result.stderr.encode("utf-8")),
    }


def object_contains_path(value: object, path: Path) -> bool:
    needle = str(path.resolve(strict=False))
    if isinstance(value, str):
        return needle in value
    if isinstance(value, list):
        return any(object_contains_path(item, path) for item in value)
    if isinstance(value, dict):
        return any(object_contains_path(item, path) for item in value.values())
    return False


def run_reproduction() -> dict[str, object]:
    source_skill = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="小蛇 复现 ") as temporary:
        root = Path(temporary)
        copied_skill = root / "技能 副本" / "xiaoshe-project-history"
        shutil.copytree(
            source_skill,
            copied_skill,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        cli = copied_skill / "scripts" / "history_inventory.py"

        fixture_root = root / "陌生用户 工作区"
        xs = fixture_root / "我的 XS"
        init_repo(xs, {"README.md": b"portable xs\n"})
        init_repo(xs / "runtime" / "DSH", {"README.md": b"portable dsh\n"})
        init_repo(
            xs / "runtime" / "xiaoshe-legacy",
            {"README.md": b"portable embedded legacy\n"},
        )
        desktop_legacy = fixture_root / "历史 小蛇"
        init_repo(desktop_legacy, {"docs/base.md": b"base\n"})
        (desktop_legacy / "docs" / "base.md").write_bytes(b"stashed base\n")
        (desktop_legacy / "docs" / "stashed.md").write_bytes(b"stashed only\n")
        run_checked(
            ("git", "-C", str(desktop_legacy), "stash", "push", "-u", "-m", "portable stash")
        )

        records = {
            "README.md": b"portable xs\n",
            "runtime/xiaoshe-legacy/docs/base.md": b"stashed base\n",
            "runtime/xiaoshe-legacy/docs/stashed.md": b"stashed only\n",
        }
        manifest = build_manifest(records)
        manifest_path = xs / "交接工具" / "完整性清单.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        archives = fixture_root / "往期 归档"
        before, after = write_archives(archives, manifest)

        outputs = root / "运行 输出"
        outputs.mkdir()
        config = outputs / "本地 来源.json"
        steps: list[dict[str, object]] = []
        base = (sys.executable, str(cli))
        steps.append(
            run_cli_step(
                "configure",
                (
                    *base,
                    "configure",
                    "--xs-root",
                    str(xs),
                    "--desktop-legacy-root",
                    str(desktop_legacy),
                    "--handoff-directory",
                    str(archives),
                    "--output",
                    str(config),
                ),
                expected_exit=0,
            )
        )
        doctor_output = outputs / "doctor.json"
        steps.append(
            run_cli_step(
                "doctor",
                (*base, "doctor", "--config", str(config), "--json-output", str(doctor_output)),
                expected_exit=0,
            )
        )
        generated: dict[str, Path] = {}
        for mode in ("inventory", "timeline", "gaps"):
            target = outputs / f"{mode}.json"
            generated[mode] = target
            steps.append(
                run_cli_step(
                    mode,
                    (*base, mode, "--config", str(config), "--output", str(target), "--pretty"),
                    expected_exit=2,
                )
            )
        compare_output = outputs / "compare.json"
        steps.append(
            run_cli_step(
                "compare",
                (
                    *base,
                    "compare",
                    "--before",
                    str(before),
                    "--after",
                    str(after),
                    "--output",
                    str(compare_output),
                    "--pretty",
                ),
                expected_exit=0,
            )
        )
        course_output = outputs / "course-export.json"
        steps.append(
            run_cli_step(
                "course-export",
                (
                    *base,
                    "course-export",
                    "--config",
                    str(config),
                    "--output",
                    str(course_output),
                    "--pretty",
                ),
                expected_exit=2,
            )
        )

        gap_payload = json.loads(generated["gaps"].read_text(encoding="utf-8"))
        course_payload = json.loads(course_output.read_text(encoding="utf-8"))
        return {
            "schema": "xiaoshe-history-reproduction/v1",
            "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "portableSkillUsed": cli.is_file() and copied_skill != source_skill,
            "unicodeSpacePathUsed": " " in str(copied_skill) and any(
                "\u4e00" <= character <= "\u9fff" for character in str(copied_skill)
            ),
            "courseExportContainsSourcePath": object_contains_path(course_payload, fixture_root),
            "gapsStatus": gap_payload.get("gapsStatus"),
            "steps": steps,
        }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Verify the copied Skill in an isolated fixture")
    parser.add_argument("--json-output", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = run_reproduction()
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"portable reproduction passed: {args.json_output}")
        return 0
    except ReproductionError as exc:
        print(f"portable reproduction failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
