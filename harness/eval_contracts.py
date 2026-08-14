"""F0 的版本化评测对象与五分区访问控制。

这是数据边界，不是运行时权限闸门的替代品：任何请求 hidden/security
分区的调用者都必须在读取数据前通过这里的显式角色检查。
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from typing import Any, Mapping


class EvalContractError(ValueError):
    """评测对象不符合版本化契约。"""


class DatasetAccessError(PermissionError):
    """调用方无权读取指定数据分区。"""


PARTITIONS = ("search", "dev", "hidden-test", "security", "calibration")
ROLES = ("runtime", "optimizer", "judge", "reviewer", "release")
_CASE_FIELDS = frozenset(
    {
        "schema_version",
        "case_id",
        "suite_id",
        "partition",
        "task_kind",
        "risk_class",
        "workspace_digest",
        "prompt_ref",
        "verifiers",
        "forbidden_effects",
        "timeout_s",
        "repeats",
    }
)


def _sha256(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _require_string(payload: Mapping[str, Any], name: str) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not value.strip():
        raise EvalContractError(f"{name} 必须是非空字符串")
    return value


def _require_sha256(value: str, name: str) -> str:
    if len(value) != 71 or not value.startswith("sha256:"):
        raise EvalContractError(f"{name} 必须是 sha256: 后跟 64 位十六进制摘要")
    try:
        int(value[7:], 16)
    except ValueError as exc:
        raise EvalContractError(f"{name} 必须是 sha256: 后跟 64 位十六进制摘要") from exc
    return value


@dataclass(frozen=True)
class EvalCase:
    schema_version: int
    case_id: str
    suite_id: str
    partition: str
    task_kind: str
    risk_class: str
    workspace_digest: str
    prompt_ref: str
    verifiers: tuple[dict[str, Any], ...]
    forbidden_effects: tuple[str, ...]
    timeout_s: int
    repeats: int

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> "EvalCase":
        if not isinstance(payload, Mapping):
            raise EvalContractError("EvalCase 必须是对象")
        unknown = sorted(set(payload) - _CASE_FIELDS)
        missing = sorted(_CASE_FIELDS - set(payload))
        if unknown:
            raise EvalContractError(f"EvalCase 含未知字段: {', '.join(unknown)}")
        if missing:
            raise EvalContractError(f"EvalCase 缺少字段: {', '.join(missing)}")
        if payload.get("schema_version") != 1:
            raise EvalContractError("仅支持 EvalCase schema_version=1")
        partition = _require_string(payload, "partition")
        if partition not in PARTITIONS:
            raise EvalContractError(f"partition 必须是: {', '.join(PARTITIONS)}")
        verifiers = payload.get("verifiers")
        effects = payload.get("forbidden_effects")
        timeout_s = payload.get("timeout_s")
        repeats = payload.get("repeats")
        if not isinstance(verifiers, list) or any(not isinstance(item, dict) for item in verifiers):
            raise EvalContractError("verifiers 必须是对象列表")
        if not isinstance(effects, list) or any(not isinstance(item, str) or not item for item in effects):
            raise EvalContractError("forbidden_effects 必须是非空字符串列表")
        if not isinstance(timeout_s, int) or isinstance(timeout_s, bool) or timeout_s < 1 or timeout_s > 86_400:
            raise EvalContractError("timeout_s 必须是 1–86400 的整数")
        if not isinstance(repeats, int) or isinstance(repeats, bool) or repeats < 1 or repeats > 100:
            raise EvalContractError("repeats 必须是 1–100 的整数")
        workspace_digest = _require_sha256(_require_string(payload, "workspace_digest"), "workspace_digest")
        prompt_ref = _require_string(payload, "prompt_ref")
        if not prompt_ref.startswith("vault:"):
            raise EvalContractError("prompt_ref 必须引用 DatasetVault（vault: 前缀）")
        return cls(
            schema_version=1,
            case_id=_require_string(payload, "case_id"),
            suite_id=_require_string(payload, "suite_id"),
            partition=partition,
            task_kind=_require_string(payload, "task_kind"),
            risk_class=_require_string(payload, "risk_class"),
            workspace_digest=workspace_digest,
            prompt_ref=prompt_ref,
            verifiers=tuple(dict(item) for item in verifiers),
            forbidden_effects=tuple(effects),
            timeout_s=timeout_s,
            repeats=repeats,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "case_id": self.case_id,
            "suite_id": self.suite_id,
            "partition": self.partition,
            "task_kind": self.task_kind,
            "risk_class": self.risk_class,
            "workspace_digest": self.workspace_digest,
            "prompt_ref": self.prompt_ref,
            "verifiers": [dict(item) for item in self.verifiers],
            "forbidden_effects": list(self.forbidden_effects),
            "timeout_s": self.timeout_s,
            "repeats": self.repeats,
        }

    def cell_key(self, experiment_id: str, arm_id: str, repeat: int, environment_digest: str) -> str:
        if not isinstance(repeat, int) or isinstance(repeat, bool) or repeat < 1:
            raise EvalContractError("repeat 必须是从 1 开始的整数")
        _require_sha256(environment_digest, "environment_digest")
        fields = {
            "arm_id": _require_string({"arm_id": arm_id}, "arm_id"),
            "case_id": self.case_id,
            "environment_digest": environment_digest,
            "experiment_id": _require_string({"experiment_id": experiment_id}, "experiment_id"),
            "repeat": repeat,
        }
        return _sha256(json.dumps(fields, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


@dataclass(frozen=True)
class DatasetAccessPolicy:
    """五分区的最小访问面；未列出的角色或分区一律拒绝。"""

    grants: Mapping[str, frozenset[str]]

    @classmethod
    def default(cls) -> "DatasetAccessPolicy":
        return cls(
            {
                "runtime": frozenset({"dev"}),
                "optimizer": frozenset({"search"}),
                "judge": frozenset({"calibration"}),
                "reviewer": frozenset(PARTITIONS),
                "release": frozenset({"hidden-test", "security"}),
            }
        )

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> "DatasetAccessPolicy":
        if not isinstance(payload, Mapping):
            raise EvalContractError("DatasetPolicy 必须是对象")
        allowed = {"schema_version", "partitions", "grants", "rules"}
        unknown = sorted(set(payload) - allowed)
        if unknown:
            raise EvalContractError(f"DatasetPolicy 含未知字段: {', '.join(unknown)}")
        if payload.get("schema_version") != 1:
            raise EvalContractError("仅支持 DatasetPolicy schema_version=1")
        if tuple(payload.get("partitions", ())) != PARTITIONS:
            raise EvalContractError("DatasetPolicy 必须声明且仅声明五个固定分区")
        raw_grants = payload.get("grants")
        if not isinstance(raw_grants, Mapping) or set(raw_grants) != set(ROLES):
            raise EvalContractError("DatasetPolicy grants 必须完整覆盖固定角色")
        grants: dict[str, frozenset[str]] = {}
        for role in ROLES:
            partitions = raw_grants[role]
            if not isinstance(partitions, list) or any(item not in PARTITIONS for item in partitions):
                raise EvalContractError(f"{role} 的数据分区授权无效")
            grants[role] = frozenset(partitions)
        policy = cls(grants)
        if policy.grants != cls.default().grants:
            raise EvalContractError("DatasetPolicy 不得放宽 F0 默认最小权限")
        return policy

    @classmethod
    def from_json_file(cls, path: Path) -> "DatasetAccessPolicy":
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise EvalContractError(f"DatasetPolicy 无法读取: {exc}") from exc
        return cls.from_dict(payload)

    def is_allowed(self, role: str, partition: str) -> bool:
        return role in ROLES and partition in PARTITIONS and partition in self.grants.get(role, frozenset())

    def require(self, role: str, partition: str) -> None:
        if not self.is_allowed(role, partition):
            raise DatasetAccessError(f"数据分区访问被拒绝: role={role!r}, partition={partition!r}")
