"""Compatibility evaluation and verified SQLite backups for forward migrations."""
from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path


@dataclass(frozen=True)
class VersionDecision:
    mode: str
    code: str


class VersionMatrix:
    def __init__(self, schema_version: int, api_version: int = 2, ui_version: int = 2):
        self.schema_version, self.api_version, self.ui_version = schema_version, api_version, ui_version

    def evaluate(self, *, db_schema: int, api: int, ui: int) -> VersionDecision:
        if db_schema > self.schema_version:
            return VersionDecision("read_only", "TASK_SCHEMA_TOO_NEW")
        if api != self.api_version or ui != self.ui_version:
            return VersionDecision("upgrade_required", "TASK_VERSION_MISMATCH")
        return VersionDecision("compatible", "TASK_VERSION_COMPATIBLE")


class MigrationManager:
    def __init__(self, db_path: Path): self.db_path = Path(db_path)

    def backup(self, old_version: int) -> Path:
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        target = self.db_path.parent / "backups" / f"{stamp}-v{old_version}"
        target.mkdir(parents=True, exist_ok=False)
        # SQLite backup produces one consistent database even with WAL enabled.
        src, dst = sqlite3.connect(self.db_path), sqlite3.connect(target / self.db_path.name)
        try:
            src.backup(dst)
        finally:
            dst.close(); src.close()
        copied = target / self.db_path.name
        digest = hashlib.sha256(copied.read_bytes()).hexdigest()
        (target / "manifest.json").write_text(json.dumps({"version": 1, "schema_before": old_version,
            "database": copied.name, "sha256": "sha256:" + digest}, indent=2), encoding="utf-8")
        return target

    def verify_backup(self, backup_dir: Path) -> bool:
        manifest = json.loads((Path(backup_dir) / "manifest.json").read_text(encoding="utf-8"))
        db = Path(backup_dir) / manifest["database"]
        if "sha256:" + hashlib.sha256(db.read_bytes()).hexdigest() != manifest["sha256"]: return False
        conn = sqlite3.connect(db)
        try: return conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        finally: conn.close()

    def rollback(self, backup_dir: Path) -> None:
        backup_dir = Path(backup_dir)
        if not self.verify_backup(backup_dir): raise ValueError("TASK_SCHEMA_BACKUP_INVALID")
        shutil.copy2(backup_dir / self.db_path.name, self.db_path)
