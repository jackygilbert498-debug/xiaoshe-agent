#!/usr/bin/env python3
"""Validate an externally installed DeepSeek Harness without copying or downloading it."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any, Optional, Sequence


SKILL_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_HELPERS = SKILL_ROOT / "assets" / "dsh-product-template" / "tools"
if str(RUNTIME_HELPERS) not in sys.path:
    sys.path.insert(0, str(RUNTIME_HELPERS))

from dsh_runtime import (  # noqa: E402
    DshRuntimeError,
    OFFICIAL_DSH_REPOSITORY,
    TESTED_DSH_VERSION,
    inspect_external_dsh,
)


def _source_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for relative in (
        "package.json",
        "LICENSE",
        "apps/cli/package.json",
        "apps/cli/src/args.ts",
        "apps/cli/src/bin.ts",
        "packages/bundle/base/cordis.patch.yml",
        "packages/bundle/web-app/cordis.patch.yml",
    ):
        path = root / relative
        if not path.is_file():
            continue
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _git_text(root: Path, arguments: list[str]) -> str:
    completed = subprocess.run(
        ["git", "-C", str(root), *arguments],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        return ""
    return completed.stdout.decode("utf-8", errors="replace").strip()


def _git_provenance(root: Path) -> dict[str, Any]:
    """Record immutable Git identity and dirty state without changing the checkout."""

    if _git_text(root, ["rev-parse", "--is-inside-work-tree"]) != "true":
        return {
            "isRepository": False,
            "head": None,
            "branch": None,
            "dirty": None,
            "trackedChanged": None,
            "untracked": None,
            "statusSha256": None,
            "tagsAtHead": [],
            "origin": None,
        }
    status = _git_text(root, ["status", "--porcelain=v1", "--untracked-files=all"])
    lines = [line for line in status.splitlines() if line]
    tracked_changed = sum(not line.startswith("??") for line in lines)
    untracked = sum(line.startswith("??") for line in lines)
    origin = _git_text(root, ["remote", "get-url", "origin"]) or None
    if origin:
        origin = re.sub(r"(?<=://)[^/@\s]+@", "<redacted>@", origin)
    tags = [
        value
        for value in _git_text(root, ["tag", "--points-at", "HEAD"]).splitlines()
        if value
    ]
    return {
        "isRepository": True,
        "head": _git_text(root, ["rev-parse", "HEAD"]),
        "branch": _git_text(root, ["branch", "--show-current"]) or None,
        "dirty": bool(lines),
        "trackedChanged": tracked_changed,
        "untracked": untracked,
        "statusSha256": hashlib.sha256(status.encode("utf-8")).hexdigest(),
        "tagsAtHead": sorted(tags),
        "origin": origin,
    }


def _provenance_limitations(git: dict[str, Any]) -> list[str]:
    """Explain when a successful runtime probe is not an immutable source proof."""

    if not git.get("isRepository"):
        return ["The DSH directory is not a Git checkout; commit provenance is unavailable."]
    if git.get("dirty"):
        return [
            "The DSH checkout is dirty; PASS covers the observed working tree, not an immutable reproduction of the tag alone."
        ]
    return []


def diagnose(dsh_root: Path, *, live: bool = True) -> tuple[dict[str, Any], int]:
    root = dsh_root.expanduser().resolve()
    inspection = inspect_external_dsh(root, run_config_dump=live)
    git = _git_provenance(root)
    checks = [
        {"id": "external-boundary", "status": "pass", "detail": "DSH is referenced externally and is not copied by the Builder."},
        {"id": "manifest-version", "status": "pass", "detail": f"DSH {inspection['version']} matches the tested boundary."},
        {"id": "license", "status": "pass", "detail": "MIT metadata and license file are present."},
        {"id": "node", "status": "pass", "detail": inspection["nodeVersion"]},
        {"id": "pnpm", "status": "pass", "detail": inspection["pnpmVersion"]},
        {
            "id": "config-dump",
            "status": "pass" if live else "partial",
            "detail": "Agent loop, session, model, tools, approval, and Web markers were resolved." if live else "Static mode did not invoke the DSH CLI.",
        },
        {
            "id": "git-provenance",
            "status": "pass" if git["isRepository"] else "partial",
            "detail": (
                f"HEAD {git['head'][:12]}, dirty={git['dirty']}, trackedChanged={git['trackedChanged']}, untracked={git['untracked']}."
                if git["isRepository"]
                else "The supplied DSH directory is not a Git checkout; commit identity is unavailable."
            ),
        },
    ]
    status = "PASS" if live else "PARTIAL"
    limitations = _provenance_limitations(git)
    if not live:
        limitations.append("Static mode does not prove that the DSH CLI can compose the Web Profile.")
    report = {
        "schema": "agent-workbench-dsh-doctor/v2",
        "status": status,
        "externalDependency": {
            "name": "DeepSeek Harness",
            "officialRepository": OFFICIAL_DSH_REPOSITORY,
            "testedVersion": TESTED_DSH_VERSION,
            "bundled": False,
            "downloadedByBuilder": False,
        },
        "observed": inspection,
        "sourceDigest": _source_digest(root),
        "git": git,
        "checks": checks,
        "limitations": limitations,
    }
    return report, 0 if live else 2


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        if temporary.exists():
            temporary.unlink()
        raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-root", required=True, type=Path, help="existing external DSH checkout")
    parser.add_argument("--static", action="store_true", help="inspect files only; returns PARTIAL")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parser().parse_args(argv)
    try:
        report, code = diagnose(args.dsh_root, live=not args.static)
    except (OSError, DshRuntimeError, json.JSONDecodeError) as exc:
        message = str(exc).replace(str(args.dsh_root.expanduser().resolve()), "<DSH_ROOT>")
        report = {
            "schema": "agent-workbench-dsh-doctor/v2",
            "status": "FAIL",
            "externalDependency": {
                "name": "DeepSeek Harness",
                "officialRepository": OFFICIAL_DSH_REPOSITORY,
                "testedVersion": TESTED_DSH_VERSION,
                "bundled": False,
                "downloadedByBuilder": False,
            },
            "error": {"code": "DSH_DOCTOR_FAILED", "message": message},
        }
        code = 3
    if args.output:
        _atomic_json(args.output, report)
    print(json.dumps(report, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
