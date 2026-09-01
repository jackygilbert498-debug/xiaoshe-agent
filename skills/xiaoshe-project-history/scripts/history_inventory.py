#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Sequence

from xiaoshe_history.archives import IntegrityError, ManifestError, read_manifest, read_manifests
from xiaoshe_history.config import (
    ConfigurationError,
    SourceConfig,
    build_xiaoshe_config,
    read_source_config,
    write_config,
)
from xiaoshe_history.doctor import diagnose_environment, doctor_exit_code
from xiaoshe_history.git_sources import (
    GitSourceError,
    StashSnapshot,
    scan_acceptance_reports,
    scan_stashes,
    scan_worktree,
)
from xiaoshe_history.models import EvidenceStatus, FileRecord, HistoryReport, Snapshot, SourceResult
from xiaoshe_history.pipeline import analyze_gaps, build_timeline, compare_snapshots, export_course_evidence


class HistoryArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        raise ConfigurationError(message)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def manifest_to_snapshot(
    source_id: str,
    manifest: dict[str, object],
    status: EvidenceStatus,
    title: str,
) -> Snapshot:
    records: list[FileRecord] = []
    for index, item in enumerate(manifest.get("files", [])):
        if not isinstance(item, dict):
            raise ManifestError(f"manifest file {index} must be an object")
        path = item.get("path")
        digest = item.get("sha256")
        if not isinstance(path, str) or not path:
            raise ManifestError(f"manifest file {index} has no path")
        if item.get("type", "file") == "file" and (
            not isinstance(digest, str) or re.fullmatch(r"[0-9a-fA-F]{64}", digest) is None
        ):
            raise ManifestError(f"manifest file {path} has invalid SHA-256")
        records.append(
            FileRecord(
                path=path.replace("\\", "/"),
                sha256=digest.lower() if isinstance(digest, str) else "",
                size=int(item.get("size", 0)),
                file_type=str(item.get("type", "file")),
            )
        )
    summary = manifest.get("summary", {})
    git_rows = manifest.get("git", [])
    dirty_counts = [
        int(row.get("dirtyEntryCount", 0))
        for row in git_rows
        if isinstance(row, dict)
    ]
    return Snapshot(
        source_id=source_id,
        generated_at=str(manifest.get("generatedAt", "")),
        files=tuple(records),
        details={
            "status": status.value,
            "title": title,
            "fileCount": int(summary.get("fileCount", len(records))) if isinstance(summary, dict) else len(records),
            "totalBytes": int(summary.get("totalBytes", 0)) if isinstance(summary, dict) else 0,
            "dirtyCounts": dirty_counts,
            **(
                {"commit": manifest["commit"]}
                if isinstance(manifest.get("commit"), str)
                else {}
            ),
        },
    )


def _archive_candidates(path: Path) -> list[Path]:
    candidates: list[Path] = []
    for item in path.iterdir():
        if not item.is_file() or item.name.lower().endswith(".sha256"):
            continue
        lower = item.name.lower()
        if lower.endswith((".tar.gz", ".tar", ".zip")):
            candidates.append(item)
    return sorted(candidates, key=lambda item: item.name)


def scan_sources(
    source_configs: Sequence[SourceConfig],
) -> tuple[list[SourceResult], list[Snapshot], list[StashSnapshot]]:
    sources: list[SourceResult] = []
    snapshots: list[Snapshot] = []
    stashes: list[StashSnapshot] = []
    for config in source_configs:
        source_id = config.source_id
        kind = config.kind
        path = config.path
        if not path.exists():
            sources.append(
                SourceResult(
                    source_id,
                    EvidenceStatus.MISSING,
                    {"path": str(path), "error": "configured source does not exist"},
                )
            )
            continue
        if kind in {"git", "git-with-stashes"}:
            try:
                git = scan_worktree(path)
                details: dict[str, object] = {
                    "path": git.path,
                    "head": git.head,
                    "branch": git.branch,
                    "dirtyCounts": [git.tracked_dirty, git.untracked],
                    "statusSha256": git.status_sha256,
                }
                details.update(scan_acceptance_reports(path, git.head).to_details())
                if kind == "git-with-stashes":
                    stashes.extend(scan_stashes(path))
                status = EvidenceStatus.LIVE_UNARCHIVED
                if config.manifest is not None:
                    if not config.manifest.is_file():
                        details["manifestError"] = f"configured manifest does not exist: {config.manifest}"
                    else:
                        manifest = json.loads(config.manifest.read_text(encoding="utf-8-sig"))
                        from xiaoshe_history.archives import validate_manifest

                        manifest = dict(validate_manifest(manifest, origin=str(config.manifest)))
                        snapshots.append(
                            manifest_to_snapshot(
                                f"{source_id}-live",
                                manifest,
                                EvidenceStatus.LIVE_UNARCHIVED,
                                f"{source_id} live manifest",
                            )
                        )
                sources.append(SourceResult(source_id, status, details))
            except (GitSourceError, ValueError, OSError, json.JSONDecodeError, ManifestError) as exc:
                sources.append(
                    SourceResult(
                        source_id,
                        EvidenceStatus.UNREADABLE,
                        {"path": str(path), "error": str(exc)},
                    )
                )
            continue

        if not path.is_dir():
            sources.append(
                SourceResult(
                    source_id,
                    EvidenceStatus.UNREADABLE,
                    {"path": str(path), "error": "archive source is not a directory"},
                )
            )
            continue
        candidates = _archive_candidates(path)
        if not candidates:
            sources.append(
                SourceResult(
                    source_id,
                    EvidenceStatus.MISSING,
                    {"path": str(path), "error": "archive directory contains no candidates"},
                )
            )
            continue
        for archive_path in candidates:
            archive_base_id = f"{source_id}:{archive_path.name}"
            try:
                archive_results = read_manifests(archive_path)
                for index, (manifest, observation) in enumerate(archive_results):
                    archive_id = archive_base_id
                    if len(archive_results) > 1:
                        stamp = re.sub(
                            r"[^0-9TZ]+",
                            "-",
                            str(manifest.get("generatedAt", index)),
                        ).strip("-")
                        archive_id = f"{archive_base_id}!{stamp or index}"
                    summary = manifest.get("summary", {})
                    details = {
                        "path": observation.path,
                        "kind": observation.kind,
                        "member": observation.member,
                        "generatedAt": manifest.get("generatedAt"),
                        "fileCount": summary.get("fileCount") if isinstance(summary, dict) else None,
                        "totalBytes": summary.get("totalBytes") if isinstance(summary, dict) else None,
                        **(
                            {"commit": manifest["commit"]}
                            if isinstance(manifest.get("commit"), str)
                            else {}
                        ),
                    }
                    sources.append(SourceResult(archive_id, observation.status, details))
                    snapshots.append(
                        manifest_to_snapshot(
                            archive_id,
                            manifest,
                            observation.status,
                            archive_path.name,
                        )
                    )
            except IntegrityError as exc:
                sources.append(
                    SourceResult(
                        archive_base_id,
                        EvidenceStatus.INTEGRITY_FAILED,
                        {"path": str(archive_path), "error": str(exc)},
                    )
                )
            except ManifestError as exc:
                sources.append(
                    SourceResult(
                        archive_base_id,
                        EvidenceStatus.UNREADABLE,
                        {"path": str(archive_path), "error": str(exc)},
                    )
                )
    return sources, snapshots, stashes


def build_report(mode: str, configs: Sequence[SourceConfig]) -> HistoryReport:
    sources, snapshots, stashes = scan_sources(configs)
    timeline = [entry.to_dict() for entry in build_timeline(snapshots)]
    ordered = sorted(snapshots, key=lambda snapshot: (snapshot.generated_at, snapshot.source_id))
    deltas = [
        compare_snapshots(before, after).to_dict()
        for before, after in zip(ordered, ordered[1:])
    ]
    payload: dict[str, object] = {
        "snapshotCount": len(snapshots),
        "stashCount": len(stashes),
    }
    if mode in {"timeline", "course-export"}:
        payload.update({"timeline": timeline, "deltas": deltas})
    if mode in {"gaps", "course-export"}:
        usable_ids = {
            source.source_id
            for source in sources
            if source.status not in {
                EvidenceStatus.MISSING,
                EvidenceStatus.UNREADABLE,
                EvidenceStatus.INTEGRITY_FAILED,
            }
        }
        stash_configs = [config for config in configs if config.kind == "git-with-stashes"]
        stash_available = any(config.source_id in usable_ids for config in stash_configs)
        prefixes = {
            config.archive_prefix
            for config in stash_configs
            if config.source_id in usable_ids and config.archive_prefix is not None
        }
        archive_prefix = next(iter(prefixes)) if len(prefixes) == 1 else None
        analysis = analyze_gaps(
            stashes,
            snapshots,
            archive_prefix=archive_prefix,
            stash_evidence_available=stash_available,
            snapshot_evidence_available=bool(snapshots),
        )
        payload["gapsStatus"] = analysis.status
        payload["gaps"] = [gap.to_dict() for gap in analysis.gaps]
        if analysis.status == "cannotEvaluate":
            payload["cannotEvaluate"] = {
                "mode": "gaps",
                "missingPrerequisites": list(analysis.missing_prerequisites),
            }
    return HistoryReport(generated_at=utc_now(), sources=tuple(sources), payload=payload)


def atomic_write_json(path: Path, payload: dict[str, object], pretty: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    indent = 2 if pretty else None
    text = json.dumps(payload, ensure_ascii=False, indent=indent, sort_keys=False) + "\n"
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def build_parser() -> HistoryArgumentParser:
    parser = HistoryArgumentParser(
        description="Read-only Xiaoshe/XS/DSH history reconstruction",
    )
    subparsers = parser.add_subparsers(dest="mode", required=True)
    configure = subparsers.add_parser("configure")
    configure.add_argument(
        "--layout",
        choices=("workspace", "published"),
        default="workspace",
        help="workspace scans nested historical repos; published scans one public repo",
    )
    configure.add_argument("--xs-root", required=True, type=Path)
    configure.add_argument("--dsh-root", type=Path)
    configure.add_argument("--embedded-legacy-root", type=Path)
    configure.add_argument("--desktop-legacy-root", type=Path)
    configure.add_argument("--handoff-directory", type=Path)
    configure.add_argument("--output", required=True, type=Path)
    configure.add_argument("--overwrite", action="store_true")
    doctor = subparsers.add_parser("doctor")
    doctor.add_argument("--config", required=True, type=Path)
    doctor.add_argument("--json-output", type=Path)
    for mode in ("inventory", "timeline", "gaps", "course-export"):
        subparser = subparsers.add_parser(mode)
        subparser.add_argument("--config", required=True, type=Path)
        subparser.add_argument("--output", required=True, type=Path)
        subparser.add_argument("--pretty", action="store_true")
    compare = subparsers.add_parser("compare")
    compare.add_argument("--before", required=True, type=Path)
    compare.add_argument("--after", required=True, type=Path)
    compare.add_argument("--output", required=True, type=Path)
    compare.add_argument("--pretty", action="store_true")
    return parser


def exit_code(report: HistoryReport) -> int:
    if report.overall_status == "failed":
        return 3
    if report.overall_status == "partial":
        return 2
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        if args.mode == "configure":
            payload = build_xiaoshe_config(
                xs_root=args.xs_root,
                dsh_root=args.dsh_root,
                embedded_legacy_root=args.embedded_legacy_root,
                desktop_legacy_root=args.desktop_legacy_root,
                handoff_directory=args.handoff_directory,
                layout=args.layout,
            )
            write_config(args.output, payload, overwrite=args.overwrite)
            return 0
        if args.mode == "doctor":
            checks = diagnose_environment(args.config)
            code = doctor_exit_code(checks)
            payload = {
                "schema": "xiaoshe-history-doctor/v1",
                "generatedAt": utc_now(),
                "overallStatus": "fail" if code == 3 else "warn" if code == 2 else "pass",
                "checks": [check.to_dict() for check in checks],
            }
            if args.json_output is not None:
                atomic_write_json(args.json_output, payload, True)
            for check in checks:
                print(f"[{check.status.upper()}] {check.check_id}: {check.message}")
            return code
        if args.mode == "compare":
            before_manifest, before_observation = read_manifest(args.before)
            after_manifest, after_observation = read_manifest(args.after)
            before = manifest_to_snapshot(
                "before",
                before_manifest,
                before_observation.status,
                args.before.name,
            )
            after = manifest_to_snapshot(
                "after",
                after_manifest,
                after_observation.status,
                args.after.name,
            )
            payload = {
                "schema": "xiaoshe-history-compare/v1",
                "generatedAt": utc_now(),
                **compare_snapshots(before, after).to_dict(),
            }
            atomic_write_json(args.output, payload, args.pretty)
            verified = {
                payload["beforeEvidenceStatus"],
                payload["afterEvidenceStatus"],
            } == {EvidenceStatus.VERIFIED.value}
            has_changes = any(payload[key] for key in ("added", "removed", "changed"))
            return 0 if verified and not has_changes else 2
        configs = read_source_config(args.config)
        report = build_report(args.mode, configs)
        payload = export_course_evidence(report) if args.mode == "course-export" else report.to_dict()
        atomic_write_json(args.output, payload, args.pretty)
        return exit_code(report)
    except ConfigurationError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 3
    except IntegrityError as exc:
        print(f"integrity error: {exc}", file=sys.stderr)
        return 3
    except (ManifestError, GitSourceError, OSError, ValueError) as exc:
        print(f"input error: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
