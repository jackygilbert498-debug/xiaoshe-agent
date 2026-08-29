"""checksum 级验证命令信任；来源文件漂移即失信。"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from .task_store import TaskStore
from .verification_discovery import source_hashes
from .verification_model import VerificationProfile, profile_checksum


class VerificationTrustStore:
    def __init__(self, store: TaskStore):
        self.store = store

    def approve(self, project_id: str, profile: VerificationProfile, source_hashes_at_approval: dict[str, str], actor: str) -> dict:
        if not isinstance(profile, VerificationProfile) or not source_hashes_at_approval:
            raise ValueError("VERIFY_TRUST_INPUT_INVALID")
        return self.store.approve_verification_profile(project_id, profile_checksum(profile), asdict(profile),
                                                       dict(sorted(source_hashes_at_approval.items())), actor)

    def is_trusted(self, project_id: str, checksum: str, project_root: Path) -> bool:
        record = self.store.get_verification_profile(project_id, checksum)
        if record is None or record["status"] != "approved":
            return False
        try:
            expected = json.loads(record["source_hashes_json"])
        except (TypeError, ValueError, json.JSONDecodeError):
            self.store.revoke_verification_profile(record["id"])
            return False
        if not isinstance(expected, dict) or not expected:
            self.store.revoke_verification_profile(record["id"])
            return False
        actual = source_hashes(project_root, tuple(sorted(expected)))
        if actual != expected:
            self.store.revoke_verification_profile(record["id"])
            return False
        return True
