from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
from typing import Mapping


class ConfigurationError(ValueError):
    """Raised when source configuration is malformed or unsafe."""


@dataclass(frozen=True)
class SourceConfig:
    """One normalized read-only history source."""

    source_id: str
    kind: str
    path: Path
    manifest: Path | None = None
    archive_prefix: str | None = None


_SUPPORTED_SCHEMAS = {
    "xiaoshe-history-sources/v1",
    "xiaoshe-history-sources/v2",
}
_SUPPORTED_KINDS = {"git", "git-with-stashes", "archive-directory"}


def _resolve_path(raw: str, config_dir: Path) -> Path:
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = config_dir / candidate
    return candidate.resolve(strict=False)


def _normalize_archive_prefix(raw: str) -> str:
    replaced = raw.replace("\\", "/")
    path = PurePosixPath(replaced)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise ConfigurationError("archivePrefix must be a safe relative path")
    return "/".join(path.parts) + "/"


def read_source_config(path: Path) -> tuple[SourceConfig, ...]:
    """Read v1/v2 source JSON and resolve relative paths beside the config."""

    path = Path(path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ConfigurationError(f"cannot read config {path}: {exc}") from exc
    if not isinstance(payload, dict) or payload.get("schema") not in _SUPPORTED_SCHEMAS:
        raise ConfigurationError(
            "config schema must be xiaoshe-history-sources/v1 or xiaoshe-history-sources/v2"
        )
    schema = payload["schema"]
    if set(payload) - {"schema", "sources"}:
        raise ConfigurationError("config root has unknown fields")
    sources = payload.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ConfigurationError("config sources must be a non-empty array")

    normalized: list[SourceConfig] = []
    seen: set[str] = set()
    for index, source in enumerate(sources):
        if not isinstance(source, dict):
            raise ConfigurationError(f"source {index} must be an object")
        allowed = {"id", "kind", "path", "manifest"}
        if schema.endswith("/v2"):
            allowed.add("archivePrefix")
        unknown = set(source) - allowed
        if unknown:
            raise ConfigurationError(f"source {index} has unknown fields: {sorted(unknown)}")
        source_id = source.get("id")
        kind = source.get("kind")
        raw_path = source.get("path")
        if not all(isinstance(value, str) and value.strip() for value in (source_id, kind, raw_path)):
            raise ConfigurationError(f"source {index} requires non-empty id, kind and path")
        assert isinstance(source_id, str) and isinstance(kind, str) and isinstance(raw_path, str)
        if source_id in seen:
            raise ConfigurationError(f"duplicate source id: {source_id}")
        if kind not in _SUPPORTED_KINDS:
            raise ConfigurationError(f"unsupported source kind: {kind}")
        seen.add(source_id)

        manifest: Path | None = None
        raw_manifest = source.get("manifest")
        if raw_manifest is not None:
            if not isinstance(raw_manifest, str) or not raw_manifest.strip():
                raise ConfigurationError(f"source {source_id} manifest must be a path string")
            manifest = _resolve_path(raw_manifest, path.parent)

        archive_prefix: str | None = None
        raw_prefix = source.get("archivePrefix")
        if raw_prefix is not None:
            if schema.endswith("/v1"):
                raise ConfigurationError("archivePrefix requires config schema v2")
            if kind != "git-with-stashes" or not isinstance(raw_prefix, str):
                raise ConfigurationError(
                    f"source {source_id} archivePrefix is only valid for git-with-stashes"
                )
            archive_prefix = _normalize_archive_prefix(raw_prefix)

        normalized.append(
            SourceConfig(
                source_id=source_id,
                kind=kind,
                path=_resolve_path(raw_path, path.parent),
                manifest=manifest,
                archive_prefix=archive_prefix,
            )
        )
    return tuple(normalized)


def build_xiaoshe_config(
    *,
    xs_root: Path,
    dsh_root: Path | None,
    embedded_legacy_root: Path | None,
    desktop_legacy_root: Path | None,
    handoff_directory: Path | None,
    layout: str = "workspace",
) -> dict[str, object]:
    """Build a v2 config for either a historical workspace or one published repo."""

    xs = Path(xs_root).expanduser().resolve(strict=False)
    if layout not in {"workspace", "published"}:
        raise ConfigurationError("layout must be workspace or published")
    if layout == "published":
        if any(
            root is not None
            for root in (dsh_root, embedded_legacy_root, desktop_legacy_root)
        ):
            raise ConfigurationError(
                "published layout accepts only --xs-root and optional --handoff-directory"
            )
        published_sources: list[dict[str, str]] = [
            {"id": "xiaoshe-release", "kind": "git", "path": str(xs)}
        ]
        if handoff_directory is not None:
            published_sources.append(
                {
                    "id": "handoffs",
                    "kind": "archive-directory",
                    "path": str(
                        Path(handoff_directory).expanduser().resolve(strict=False)
                    ),
                }
            )
        return {
            "schema": "xiaoshe-history-sources/v2",
            "sources": published_sources,
        }

    dsh = Path(dsh_root).expanduser().resolve(strict=False) if dsh_root else xs / "runtime" / "DSH"
    embedded = (
        Path(embedded_legacy_root).expanduser().resolve(strict=False)
        if embedded_legacy_root
        else xs / "runtime" / "xiaoshe-legacy"
    )
    sources: list[dict[str, str]] = [
        {
            "id": "xs",
            "kind": "git",
            "path": str(xs),
            "manifest": str(xs / "交接工具" / "完整性清单.json"),
        },
        {"id": "dsh", "kind": "git", "path": str(dsh)},
        {"id": "embedded-legacy", "kind": "git", "path": str(embedded)},
    ]
    if desktop_legacy_root is not None:
        sources.append(
            {
                "id": "desktop-legacy",
                "kind": "git-with-stashes",
                "path": str(Path(desktop_legacy_root).expanduser().resolve(strict=False)),
                "archivePrefix": "runtime/xiaoshe-legacy/",
            }
        )
    if handoff_directory is not None:
        sources.append(
            {
                "id": "handoffs",
                "kind": "archive-directory",
                "path": str(Path(handoff_directory).expanduser().resolve(strict=False)),
            }
        )
    return {"schema": "xiaoshe-history-sources/v2", "sources": sources}


def write_config(path: Path, payload: Mapping[str, object], *, overwrite: bool) -> None:
    """Atomically write a generated config and never overwrite implicitly."""

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not overwrite:
        raise ConfigurationError(f"config already exists: {path}; pass --overwrite to replace it")
    raw = json.dumps(dict(payload), ensure_ascii=False, indent=2) + "\n"
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
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
