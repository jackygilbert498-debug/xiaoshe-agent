#!/usr/bin/env python3
"""Build a deterministic handoff ZIP while keeping external DSH outside it."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tempfile
from typing import Any, Iterable, Optional, Sequence
import zipfile


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_ARCHIVE_BYTES = 30 * 1024 * 1024
FIXED_ZIP_TIME = (2020, 1, 1, 0, 0, 0)


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_relative(value: str) -> bool:
    path = PurePosixPath(value)
    return bool(value) and not path.is_absolute() and ".." not in path.parts and "\\" not in value


def _excluded(relative: Path) -> bool:
    if any(part in {".git", ".runtime", "_handoff", "dist", "node_modules", "work", "__pycache__"} for part in relative.parts):
        return True
    if relative.suffix in {".pyc", ".pyo"} or relative.name == ".DS_Store":
        return True
    return relative.as_posix() in {"evidence/graduation.json", "evidence/handoff.json"}


def _source_files() -> Iterable[tuple[str, Path]]:
    for path in sorted(PROJECT_ROOT.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(PROJECT_ROOT)
        if _excluded(relative):
            continue
        if path.is_symlink():
            raise RuntimeError(f"refusing symlink: {relative.as_posix()}")
        if path.is_file():
            if path.stat().st_size > MAX_FILE_BYTES:
                raise RuntimeError(f"file exceeds package limit: {relative.as_posix()}")
            yield relative.as_posix(), path


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, FIXED_ZIP_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    info.create_system = 3
    return info


def _atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        if temporary.exists():
            temporary.unlink()
        raise


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    _atomic_text(path, json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def build_package(output_dir: Path) -> dict[str, Any]:
    contract = json.loads((PROJECT_ROOT / "agent_project.json").read_text(encoding="utf-8"))
    runtime = contract.get("runtime", {})
    if runtime.get("kind") != "external-dsh" or runtime.get("bundled") is not False:
        raise RuntimeError("runtime contract must keep DSH external and unbundled")
    output = (PROJECT_ROOT / output_dir).resolve() if not output_dir.is_absolute() else output_dir.resolve()
    try:
        output.relative_to(PROJECT_ROOT)
    except ValueError as exc:
        raise RuntimeError("output directory must stay inside the project") from exc
    output.mkdir(parents=True, exist_ok=True)

    payloads = []
    members = []
    for relative, path in _source_files():
        if not _safe_relative(relative):
            raise RuntimeError(f"unsafe source path: {relative}")
        parts = PurePosixPath(relative).parts
        if "node_modules" in parts or ".runtime" in parts or ("runtime" in parts and "DSH" in parts):
            raise RuntimeError(f"external runtime material would enter handoff: {relative}")
        data = path.read_bytes()
        payloads.append((relative, data))
        members.append({"path": relative, "size": len(data), "sha256": _sha256_bytes(data)})

    manifest = {
        "schema": "agent-workbench-handoff-manifest/v4",
        "projectSlug": contract["project"]["slug"],
        "productKind": contract["project"]["kind"],
        "capabilityCount": len(contract["capabilities"]),
        "representativeScenarioCount": len(contract["acceptanceScenarios"]),
        "developmentStage": contract["development"]["stage"],
        "contractSha256": _sha256_file(PROJECT_ROOT / "agent_project.json"),
        "rollback": contract["rollback"],
        "externalDependencies": [{
            "name": "DeepSeek Harness",
            "officialRepository": runtime["officialRepository"],
            "testedVersion": runtime["testedVersion"],
            "bundled": False,
        }],
        "files": members,
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    archive_name = f"{contract['project']['slug']}-handoff.zip"
    archive_path = output / archive_name
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{archive_name}.", dir=output)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for relative, data in payloads:
                archive.writestr(_zip_info(relative), data)
            archive.writestr(_zip_info("_handoff/manifest.json"), manifest_bytes)
        if temporary.stat().st_size > MAX_ARCHIVE_BYTES:
            raise RuntimeError("handoff archive exceeds size limit")
        os.replace(temporary, archive_path)
    except Exception:
        if temporary.exists():
            temporary.unlink()
        raise

    archive_hash = _sha256_file(archive_path)
    sidecar_path = output / f"{archive_name}.sha256"
    _atomic_text(sidecar_path, f"{archive_hash}  {archive_name}\n")
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or not all(_safe_relative(name) for name in names):
            raise RuntimeError("archive contains duplicate or unsafe paths")
        loaded = json.loads(archive.read("_handoff/manifest.json"))
        if loaded["externalDependencies"][0]["bundled"] is not False:
            raise RuntimeError("handoff external dependency boundary is invalid")
        for entry in loaded["files"]:
            data = archive.read(entry["path"])
            if len(data) != entry["size"] or _sha256_bytes(data) != entry["sha256"]:
                raise RuntimeError(f"archive verification failed: {entry['path']}")

    receipt = {
        "schema": "agent-workbench-handoff/v4",
        "status": "PASS",
        "projectSlug": contract["project"]["slug"],
        "productKind": contract["project"]["kind"],
        "developmentStage": contract["development"]["stage"],
        "archive": archive_path.relative_to(PROJECT_ROOT).as_posix(),
        "sidecar": sidecar_path.relative_to(PROJECT_ROOT).as_posix(),
        "sha256": archive_hash,
        "manifestEntries": len(members),
        "archiveBytes": archive_path.stat().st_size,
        "verification": "manifest-sidecar-and-external-runtime-boundary-match",
        "externalDshBundled": False,
        "rollback": contract["rollback"],
    }
    _atomic_json(PROJECT_ROOT / "evidence/handoff.json", receipt)
    return receipt


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path("dist"))
    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parser().parse_args(argv)
    try:
        receipt = build_package(args.output_dir)
        code = 0
    except Exception as exc:
        receipt = {"schema": "agent-workbench-handoff/v4", "status": "FAIL", "error": {"code": "PACKAGE_FAILED", "message": str(exc).replace(str(PROJECT_ROOT), "<PROJECT_ROOT>")}}
        _atomic_json(PROJECT_ROOT / "evidence/handoff.json", receipt)
        code = 3
    print(json.dumps(receipt, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
