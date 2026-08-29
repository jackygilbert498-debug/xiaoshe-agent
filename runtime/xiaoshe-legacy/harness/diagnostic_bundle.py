"""Preview-first diagnostic archives with an allowlist-only data model."""
from __future__ import annotations

import hashlib
import json
import re
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

_SENSITIVE = re.compile(r"(?i)(sk-[a-z0-9_-]{8,}|api[_-]?key|token|authorization|/Users/|[A-Z]:\\Users\\|\.env)")


@dataclass(frozen=True)
class DiagnosticPreview:
    id: str
    files: tuple[str, ...]
    manifest: dict


class DiagnosticBundle:
    def __init__(self, output_dir: Path):
        self.output_dir = Path(output_dir)
        self._previews: dict[str, DiagnosticPreview] = {}

    @staticmethod
    def _safe_context(context: dict) -> dict:
        # Explicitly copy only operational aggregates; never accept free-text
        # fields (prompt, source, path, command output) from callers.
        return {key: context.get(key) for key in ("app_version", "schema_version", "platform_capability", "error_counts", "task_counts", "resource_summary") if key in context}

    def preview(self, context: dict) -> DiagnosticPreview:
        payload = self._safe_context(context)
        rendered = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        if _SENSITIVE.search(rendered):
            raise ValueError("DIAGNOSTIC_SENSITIVE_CONTENT")
        manifest = {"version": 1, "files": ["manifest.json", "summary.json"], "summary_sha256": "sha256:" + hashlib.sha256(rendered.encode()).hexdigest(), "summary": payload}
        preview = DiagnosticPreview("diag_" + uuid4().hex, tuple(manifest["files"]), manifest)
        self._previews[preview.id] = preview
        return preview

    def create(self, preview_id: str) -> Path:
        preview = self._previews[preview_id]
        self.output_dir.mkdir(parents=True, exist_ok=True)
        path = self.output_dir / f"{preview.id}.zip"
        with tempfile.NamedTemporaryFile(dir=self.output_dir, suffix=".zip", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("manifest.json", json.dumps({k: v for k, v in preview.manifest.items() if k != "summary"}, ensure_ascii=False, sort_keys=True))
                archive.writestr("summary.json", json.dumps(preview.manifest["summary"], ensure_ascii=False, sort_keys=True))
            tmp_path.replace(path)
            return path
        finally:
            tmp_path.unlink(missing_ok=True)
