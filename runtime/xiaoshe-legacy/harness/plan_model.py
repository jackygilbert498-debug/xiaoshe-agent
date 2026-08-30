"""可评审 Plan 的纯数据契约。

这里不保存或推导模型的隐藏推理。它只处理用户能阅读、编辑和批准的
目标、假设、步骤、范围、验证方式和预算信息，因此可作为 API、SQLite 与 UI
共用的稳定输入边界。
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping


PLAN_SCHEMA_VERSION = 1
_RISKS = frozenset({"low", "medium", "high", "critical"})
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_STEP_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_WINDOWS_ABSOLUTE_RE = re.compile(r"^[A-Za-z]:[\\/]")


@dataclass(frozen=True)
class PlanValidationError(Exception):
    """可直接序列化到 422 的字段级 Plan 校验错误。"""

    code: str
    path: str
    message: str

    def __post_init__(self) -> None:
        if not self.path.startswith("/"):
            raise ValueError("Plan 错误路径必须是 JSON pointer")
        Exception.__init__(self, f"{self.code} at {self.path}: {self.message}")

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "path": self.path, "message": self.message}


def canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _text(value: object, path: str, *, minimum: int = 1, maximum: int = 4000) -> str:
    if not isinstance(value, str):
        raise PlanValidationError("PLAN_FIELD_TYPE", path, "必须是文本")
    normalized = value.strip()
    if _CONTROL_RE.search(normalized) or not minimum <= len(normalized) <= maximum:
        raise PlanValidationError("PLAN_FIELD_LENGTH", path, f"长度必须在 {minimum} 到 {maximum} 字符之间，且不得含控制字符")
    return normalized


def _text_list(value: object, path: str, *, maximum_items: int, maximum_text: int = 2000) -> list[str]:
    if not isinstance(value, list):
        raise PlanValidationError("PLAN_FIELD_TYPE", path, "必须是数组")
    if len(value) > maximum_items:
        raise PlanValidationError("PLAN_LIMIT_EXCEEDED", path, f"最多 {maximum_items} 项")
    return [_text(item, f"{path}/{index}", maximum=maximum_text) for index, item in enumerate(value)]


def _path(value: object, path: str) -> str:
    item = _text(value, path, maximum=512).replace("\\", "/")
    if item.startswith("/") or _WINDOWS_ABSOLUTE_RE.match(item) or any(part == ".." for part in item.split("/")):
        raise PlanValidationError("PLAN_PATH_ESCAPE", path, "文件范围必须是工作区内的相对路径或 glob")
    if item in {"", "."} or item.startswith("./"):
        raise PlanValidationError("PLAN_PATH_INVALID", path, "文件范围必须是明确的相对路径或 glob")
    return item


def _budget(value: object) -> dict[str, int | float | str]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise PlanValidationError("PLAN_FIELD_TYPE", "/estimated_budget", "必须是对象")
    if len(value) > 12:
        raise PlanValidationError("PLAN_LIMIT_EXCEEDED", "/estimated_budget", "预算字段最多 12 项")
    result: dict[str, int | float | str] = {}
    for key, raw in value.items():
        name = _text(key, "/estimated_budget", maximum=80)
        if isinstance(raw, bool) or not isinstance(raw, (str, int, float)):
            raise PlanValidationError("PLAN_FIELD_TYPE", f"/estimated_budget/{name}", "预算值必须是文本或数字")
        if isinstance(raw, str):
            result[name] = _text(raw, f"/estimated_budget/{name}", maximum=160)
        elif not (-1_000_000_000 <= raw <= 1_000_000_000):
            raise PlanValidationError("PLAN_FIELD_RANGE", f"/estimated_budget/{name}", "预算数值超出允许范围")
        else:
            result[name] = raw
    return result


def _normalize_step(raw: object, index: int) -> dict[str, Any]:
    path = f"/steps/{index}"
    if not isinstance(raw, Mapping):
        raise PlanValidationError("PLAN_FIELD_TYPE", path, "步骤必须是对象")
    required = ("id", "title", "intent", "files", "validation", "risk", "depends_on")
    missing = next((key for key in required if key not in raw), None)
    if missing:
        raise PlanValidationError("PLAN_FIELD_REQUIRED", f"{path}/{missing}", "步骤字段不可缺失")
    step_id = _text(raw["id"], f"{path}/id", maximum=64)
    if not _STEP_ID_RE.fullmatch(step_id):
        raise PlanValidationError("PLAN_STEP_ID_INVALID", f"{path}/id", "步骤 ID 只能含字母、数字、下划线或连字符")
    files = _text_list(raw["files"], f"{path}/files", maximum_items=100, maximum_text=512)
    risk = raw["risk"]
    if risk not in _RISKS:
        raise PlanValidationError("PLAN_RISK_INVALID", f"{path}/risk", "风险必须是 low、medium、high 或 critical")
    depends_on = _text_list(raw["depends_on"], f"{path}/depends_on", maximum_items=100, maximum_text=64)
    return {
        "id": step_id,
        "title": _text(raw["title"], f"{path}/title", maximum=300),
        "intent": _text(raw["intent"], f"{path}/intent", maximum=4000),
        "files": [_path(item, f"{path}/files/{position}") for position, item in enumerate(files)],
        "validation": _text_list(raw["validation"], f"{path}/validation", maximum_items=30, maximum_text=1000),
        "risk": risk,
        "depends_on": depends_on,
    }


def _normalize_mapping(value: object) -> dict[str, list[str]]:
    if not isinstance(value, Mapping):
        raise PlanValidationError("PLAN_FIELD_TYPE", "/acceptance_mapping", "必须是对象")
    if len(value) > 100:
        raise PlanValidationError("PLAN_LIMIT_EXCEEDED", "/acceptance_mapping", "验收映射最多 100 项")
    result: dict[str, list[str]] = {}
    for key, raw in value.items():
        acceptance_id = _text(key, "/acceptance_mapping", maximum=160)
        result[acceptance_id] = _text_list(raw, f"/acceptance_mapping/{acceptance_id}", maximum_items=100, maximum_text=64)
    return result


def normalize_plan(body: Mapping[str, Any]) -> dict[str, Any]:
    """返回可跨平台 checksum 的唯一 Plan v1 表示；失败时给出字段路径。"""
    if not isinstance(body, Mapping):
        raise PlanValidationError("PLAN_FIELD_TYPE", "/", "计划必须是对象")
    if "steps" not in body:
        raise PlanValidationError("PLAN_FIELD_REQUIRED", "/steps", "计划步骤不可缺失")
    steps_value = body["steps"]
    if not isinstance(steps_value, list):
        raise PlanValidationError("PLAN_FIELD_TYPE", "/steps", "必须是数组")
    if not 1 <= len(steps_value) <= 200:
        raise PlanValidationError("PLAN_LIMIT_EXCEEDED", "/steps", "步骤数量必须在 1 到 200 之间")
    if "acceptance_mapping" not in body:
        raise PlanValidationError("PLAN_FIELD_REQUIRED", "/acceptance_mapping", "验收映射不可缺失")
    steps = [_normalize_step(item, index) for index, item in enumerate(steps_value)]
    ids = [step["id"] for step in steps]
    duplicate = next((step_id for step_id in ids if ids.count(step_id) > 1), None)
    if duplicate is not None:
        raise PlanValidationError("PLAN_STEP_ID_DUPLICATE", f"/steps/{ids.index(duplicate)}/id", "步骤 ID 必须唯一")
    known = set(ids)
    for index, step in enumerate(steps):
        unknown = next((dep for dep in step["depends_on"] if dep not in known), None)
        if unknown is not None:
            raise PlanValidationError("PLAN_DEPENDENCY_UNKNOWN", f"/steps/{index}/depends_on", f"未知依赖：{unknown}")
    mapping = _normalize_mapping(body["acceptance_mapping"])
    for acceptance_id, step_ids in mapping.items():
        unknown = next((step_id for step_id in step_ids if step_id not in known), None)
        if unknown is not None:
            raise PlanValidationError("PLAN_ACCEPTANCE_STEP_UNKNOWN", f"/acceptance_mapping/{acceptance_id}", f"未知步骤：{unknown}")
    return {
        "schema_version": PLAN_SCHEMA_VERSION,
        "objective": _text(body.get("objective"), "/objective", maximum=4000),
        "assumptions": _text_list(body.get("assumptions", []), "/assumptions", maximum_items=20),
        "steps": steps,
        "acceptance_mapping": mapping,
        "estimated_budget": _budget(body.get("estimated_budget", {})),
    }


def _cycle_error(plan: Mapping[str, Any]) -> PlanValidationError | None:
    graph = {step["id"]: tuple(step["depends_on"]) for step in plan["steps"]}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(step_id: str) -> str | None:
        if step_id in visiting:
            return step_id
        if step_id in visited:
            return None
        visiting.add(step_id)
        for dependency in graph[step_id]:
            found = visit(dependency)
            if found:
                return found
        visiting.remove(step_id)
        visited.add(step_id)
        return None

    for index, step in enumerate(plan["steps"]):
        if found := visit(step["id"]):
            return PlanValidationError("PLAN_DEPENDENCY_CYCLE", f"/steps/{index}/depends_on", f"检测到循环依赖：{found}")
    return None


def validate_plan(body: Mapping[str, Any], *, acceptance_ids: tuple[str, ...] | list[str] = ()) -> tuple[PlanValidationError, ...]:
    """收集可同时呈现给用户的高层校验错误，不暴露内部推理。"""
    try:
        normalized = normalize_plan(body)
    except PlanValidationError as error:
        return (error,)
    errors: list[PlanValidationError] = []
    if cycle := _cycle_error(normalized):
        errors.append(cycle)
    confirmed = tuple(acceptance_ids)
    if not confirmed:
        errors.append(PlanValidationError("PLAN_ACCEPTANCE_REQUIRED", "/acceptance_mapping", "任务尚未确认验收标准，计划不可提交评审"))
    else:
        mapping = normalized["acceptance_mapping"]
        for index, acceptance_id in enumerate(confirmed):
            if not isinstance(acceptance_id, str) or not acceptance_id.strip():
                errors.append(PlanValidationError("PLAN_ACCEPTANCE_INVALID", f"/acceptance_ids/{index}", "验收标准必须是非空文本"))
            elif not mapping.get(acceptance_id):
                errors.append(PlanValidationError("PLAN_ACCEPTANCE_UNMAPPED", f"/acceptance_mapping/{acceptance_id}", "每条验收标准必须映射到至少一个步骤"))
    return tuple(errors)


def plan_checksum(body: Mapping[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(normalize_plan(body))).hexdigest()
