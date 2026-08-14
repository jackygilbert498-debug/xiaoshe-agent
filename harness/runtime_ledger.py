"""Pi 式 Runtime 的纯数据账本：稳定工具面、前缀和请求预算。

模块故意不导入 Agent、Provider 或工具实现。先用它建立可验证的不变量；接线
阶段只能消费这些不可变记录，不能通过修改记录改变已经发送的请求语义。
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import math
from typing import Any, Mapping


class RuntimeLedgerError(ValueError):
    """Runtime 数据契约被违反。"""


def _canonical(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise RuntimeLedgerError("RUNTIME_LEDGER_VALUE_INVALID") from exc


def _digest(value: Any) -> str:
    return "sha256:" + sha256(_canonical(value).encode("utf-8")).hexdigest()


def _nonempty(value: Any, code: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeLedgerError(code)
    return value


@dataclass(frozen=True)
class ToolEpoch:
    """有序且冻结的工具 schema；权限 revision 不属于 schema。"""

    epoch_id: str
    tools: tuple[dict[str, Any], ...]
    schema_digest: str
    reason: str

    @classmethod
    def create(cls, epoch_id: str, tools: list[Mapping[str, Any]], reason: str) -> "ToolEpoch":
        _nonempty(epoch_id, "TOOL_EPOCH_ID_INVALID")
        _nonempty(reason, "TOOL_EPOCH_REASON_INVALID")
        # 压缩与独立验收是合法的零工具请求；空 schema 也必须拥有稳定
        # digest，不能为满足账本而虚构一个工具。
        if not isinstance(tools, list):
            raise RuntimeLedgerError("TOOL_EPOCH_TOOLS_INVALID")
        normalized: list[dict[str, Any]] = []
        names: set[str] = set()
        for raw in tools:
            if not isinstance(raw, Mapping):
                raise RuntimeLedgerError("TOOL_EPOCH_TOOL_INVALID")
            tool = json.loads(_canonical(dict(raw)))
            # 内部工具定义使用 name 顶层；当前 Provider 发送的是
            # OpenAI function schema（type/function/name）。两者都要以完整
            # 原样 schema 参与 digest，不能在影子层重新排版或丢字段。
            function = tool.get("function")
            name = tool.get("name") if isinstance(tool.get("name"), str) else (
                function.get("name") if isinstance(function, dict) else None
            )
            if not isinstance(name, str) or not name or name in names:
                raise RuntimeLedgerError("TOOL_EPOCH_TOOL_NAME_INVALID")
            names.add(name)
            normalized.append(tool)
        return cls(epoch_id=epoch_id, tools=tuple(normalized), schema_digest=_digest(normalized), reason=reason)


@dataclass(frozen=True)
class PrefixEpoch:
    """一个可解释的 prompt 前缀版本；尾部消息只能追加。"""

    epoch_id: str
    stable_blocks: dict[str, str]
    prefix_digest: str
    reason: str

    @classmethod
    def create(cls, epoch_id: str, stable_blocks: Mapping[str, str], reason: str) -> "PrefixEpoch":
        _nonempty(epoch_id, "PREFIX_EPOCH_ID_INVALID")
        _nonempty(reason, "PREFIX_EPOCH_REASON_INVALID")
        required = ("system", "project", "summary")
        if not isinstance(stable_blocks, Mapping) or set(stable_blocks) != set(required):
            raise RuntimeLedgerError("PREFIX_EPOCH_BLOCKS_INVALID")
        normalized = {name: stable_blocks[name] for name in required}
        if any(not isinstance(value, str) for value in normalized.values()):
            raise RuntimeLedgerError("PREFIX_EPOCH_BLOCKS_INVALID")
        return cls(epoch_id=epoch_id, stable_blocks=normalized, prefix_digest=_digest(normalized), reason=reason)

    def materialize(self, tail: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
        if not isinstance(tail, list):
            raise RuntimeLedgerError("PREFIX_EPOCH_TAIL_INVALID")
        material = [
            {"role": "system", "content": self.stable_blocks["system"]},
            {"role": "system", "content": self.stable_blocks["project"]},
            {"role": "system", "content": self.stable_blocks["summary"]},
        ]
        for event in tail:
            if not isinstance(event, Mapping):
                raise RuntimeLedgerError("PREFIX_EPOCH_TAIL_INVALID")
            material.append(json.loads(_canonical(dict(event))))
        return material

    @staticmethod
    def assert_append_only(previous: list[Mapping[str, Any]], current: list[Mapping[str, Any]]) -> None:
        if not isinstance(previous, list) or not isinstance(current, list):
            raise RuntimeLedgerError("PREFIX_EPOCH_TAIL_INVALID")
        if len(current) < len(previous) or _canonical(current[:len(previous)]) != _canonical(previous):
            raise RuntimeLedgerError("PREFIX_EPOCH_PREFIX_REWRITE")


_PURPOSES = frozenset({
    "agent_step", "compaction", "verifier", "repair", "retry", "title", "evolution_proposer", "evolution_judge",
})
_USAGE_KEYS = ("input_miss", "cache_read", "output", "reasoning", "cost_micros")


def _usage(value: Mapping[str, Any] | None) -> dict[str, int | None]:
    if value is None:
        return {key: None for key in _USAGE_KEYS}
    if not isinstance(value, Mapping) or set(value) - set(_USAGE_KEYS):
        raise RuntimeLedgerError("REQUEST_USAGE_INVALID")
    normalized: dict[str, int | None] = {}
    for key in _USAGE_KEYS:
        item = value.get(key)
        if item is None:
            normalized[key] = None
        elif type(item) is int and item >= 0:
            normalized[key] = item
        else:
            raise RuntimeLedgerError("REQUEST_USAGE_INVALID")
    return normalized


def normalize_provider_usage(value: Mapping[str, Any] | None) -> dict[str, int | None]:
    """将已报告的 provider usage 投影到统一字段；缺失就是 unknown。"""
    if value is None:
        return _usage(None)
    if not isinstance(value, Mapping):
        raise RuntimeLedgerError("REQUEST_USAGE_INVALID")
    detail = value.get("prompt_tokens_details")
    detail = detail if isinstance(detail, Mapping) else {}
    cost = value.get("cost")
    cost = cost if isinstance(cost, Mapping) else {}
    def pick(*keys: str) -> int | None:
        for key in keys:
            candidate = value.get(key)
            if type(candidate) is int and candidate >= 0:
                return candidate
        return None
    cache = pick("prompt_cache_hit_tokens", "cache_read", "cached_tokens")
    if cache is None:
        candidate = detail.get("cached_tokens")
        cache = candidate if type(candidate) is int and candidate >= 0 else None
    cost_micros = pick("cost_micros", "cost_microdollars")
    if cost_micros is None:
        total = cost.get("total")
        # 小数美元的转换只在它是有限且非负的已报告值时进行；没有账单值不猜价格。
        if isinstance(total, (int, float)) and not isinstance(total, bool) and math.isfinite(float(total)) and total >= 0:
            cost_micros = int(round(float(total) * 1_000_000))
    return _usage({
        "input_miss": pick("prompt_cache_miss_tokens", "input_miss"),
        "cache_read": cache,
        "output": pick("completion_tokens", "output_tokens", "output"),
        "reasoning": pick("reasoning_tokens", "reasoning"),
        "cost_micros": cost_micros,
    })


@dataclass(frozen=True)
class RequestRecord:
    request_id: str
    purpose: str
    tool_epoch_id: str
    tool_schema_digest: str
    prefix_epoch_id: str
    prefix_digest: str
    status: str
    usage: dict[str, int | None] | None = None
    error_code: str | None = None


class RequestLedger:
    """所有模型请求的幂等账本，禁止漏记 purpose 或伪造 usage。"""

    def __init__(self) -> None:
        self._records: dict[str, RequestRecord] = {}

    def start(self, request_id: str, purpose: str, tool_epoch: ToolEpoch, prefix_epoch: PrefixEpoch) -> RequestRecord:
        _nonempty(request_id, "REQUEST_ID_INVALID")
        if purpose not in _PURPOSES:
            raise RuntimeLedgerError("REQUEST_PURPOSE_INVALID")
        if not isinstance(tool_epoch, ToolEpoch) or not isinstance(prefix_epoch, PrefixEpoch):
            raise RuntimeLedgerError("REQUEST_EPOCH_INVALID")
        record = RequestRecord(request_id, purpose, tool_epoch.epoch_id, tool_epoch.schema_digest,
                               prefix_epoch.epoch_id, prefix_epoch.prefix_digest, "started")
        existing = self._records.get(request_id)
        if existing is not None:
            if existing != record:
                raise RuntimeLedgerError("REQUEST_ID_CONFLICT")
            return existing
        self._records[request_id] = record
        return record

    def finish(self, request_id: str, usage: Mapping[str, Any] | None, *, error_code: str | None = None) -> RequestRecord:
        _nonempty(request_id, "REQUEST_ID_INVALID")
        existing = self._records.get(request_id)
        if existing is None:
            raise RuntimeLedgerError("REQUEST_NOT_STARTED")
        if existing.status != "started":
            candidate = RequestRecord(existing.request_id, existing.purpose, existing.tool_epoch_id,
                                      existing.tool_schema_digest, existing.prefix_epoch_id, existing.prefix_digest,
                                      "failed" if error_code else "finished", _usage(usage), error_code)
            if existing != candidate:
                raise RuntimeLedgerError("REQUEST_TERMINAL_CONFLICT")
            return existing
        if error_code is not None:
            _nonempty(error_code, "REQUEST_ERROR_CODE_INVALID")
        record = RequestRecord(existing.request_id, existing.purpose, existing.tool_epoch_id,
                               existing.tool_schema_digest, existing.prefix_epoch_id, existing.prefix_digest,
                               "failed" if error_code else "finished", _usage(usage), error_code)
        self._records[request_id] = record
        return record

    def records(self) -> tuple[RequestRecord, ...]:
        return tuple(self._records[key] for key in sorted(self._records))

    def completeness(self) -> dict[str, Any]:
        records = self.records()
        unfinished = [record.request_id for record in records if record.status == "started"]
        unknown_usage = [record.request_id for record in records if record.status != "started"
                         and (record.usage is None or any(value is None for value in record.usage.values()))]
        return {"request_count": len(records), "unfinished": unfinished, "unknown_usage": unknown_usage,
                "complete": not unfinished, "usage_complete": not unknown_usage}

    def audit_summary(self, *, expose_request_ids: bool = False) -> dict[str, Any]:
        """返回可展示的账本摘要，且明确保留 usage 的 unknown 语义。

        ``known_total`` 只代表 provider 已报告的部分；缺失字段不能被加总为
        零。该函数是只读投影，不会修改任何请求记录。
        """
        records = self.records()
        purposes = {purpose: 0 for purpose in sorted(_PURPOSES)}
        statuses = {"started": 0, "finished": 0, "failed": 0}
        usage: dict[str, dict[str, int]] = {
            key: {"known_total": 0, "unknown_request_count": 0} for key in _USAGE_KEYS
        }
        for record in records:
            purposes[record.purpose] += 1
            statuses[record.status] = statuses.get(record.status, 0) + 1
            if record.status == "started" or record.usage is None:
                for item in usage.values():
                    item["unknown_request_count"] += 1
                continue
            for key, value in record.usage.items():
                if value is None:
                    usage[key]["unknown_request_count"] += 1
                else:
                    usage[key]["known_total"] += value
        completeness = self.completeness()
        if not expose_request_ids:
            # 远端/界面消费者只需要知道是否完整和数量；request id 即使不含
            # prompt，也可能成为可关联的会话运行元数据，默认不跨边界导出。
            completeness = {
                "request_count": completeness["request_count"],
                "unfinished_count": len(completeness["unfinished"]),
                "unknown_usage_count": len(completeness["unknown_usage"]),
                "complete": completeness["complete"],
                "usage_complete": completeness["usage_complete"],
            }
        return {
            "request_count": len(records),
            "purposes": purposes,
            "statuses": statuses,
            "tool_epoch_count": len({record.tool_schema_digest for record in records}),
            "prefix_epoch_count": len({record.prefix_digest for record in records}),
            "usage": usage,
            "completeness": completeness,
        }


@dataclass(frozen=True)
class BudgetReservation:
    reservation_id: str
    amount: dict[str, int]


class RuntimeBudget:
    """发送前预留、终态结算的内存预算；不安全地超额结算会失败关闭。"""

    def __init__(self, limits: Mapping[str, int]) -> None:
        if not isinstance(limits, Mapping) or not limits:
            raise RuntimeLedgerError("RUNTIME_BUDGET_LIMITS_INVALID")
        self._limits = self._normalize_against(limits, set(limits))
        self._reserved: dict[str, BudgetReservation] = {}
        self._settled = {key: 0 for key in self._limits}

    def _normalize(self, amount: Mapping[str, int]) -> dict[str, int]:
        return self._normalize_against(amount, set(self._limits))

    @staticmethod
    def _normalize_against(amount: Mapping[str, int], allowed: set[str]) -> dict[str, int]:
        if not isinstance(amount, Mapping) or not allowed or set(amount) - allowed:
            raise RuntimeLedgerError("RUNTIME_BUDGET_AMOUNT_INVALID")
        result = {key: 0 for key in allowed}
        for key, value in amount.items():
            if type(value) is not int or value < 0:
                raise RuntimeLedgerError("RUNTIME_BUDGET_AMOUNT_INVALID")
            result[key] = value
        return result

    def remaining(self) -> dict[str, int]:
        held = {key: 0 for key in self._limits}
        for reservation in self._reserved.values():
            for key, value in reservation.amount.items():
                held[key] += value
        return {key: self._limits[key] - self._settled[key] - held[key] for key in self._limits}

    def reserve(self, reservation_id: str, amount: Mapping[str, int]) -> BudgetReservation:
        _nonempty(reservation_id, "RUNTIME_BUDGET_RESERVATION_ID_INVALID")
        normalized = self._normalize(amount)
        existing = self._reserved.get(reservation_id)
        if existing is not None:
            if existing.amount != normalized:
                raise RuntimeLedgerError("RUNTIME_BUDGET_RESERVATION_CONFLICT")
            return existing
        if any(normalized[key] > self.remaining()[key] for key in normalized):
            raise RuntimeLedgerError("RUNTIME_BUDGET_EXHAUSTED")
        reservation = BudgetReservation(reservation_id, normalized)
        self._reserved[reservation_id] = reservation
        return reservation

    def settle(self, reservation_id: str, actual: Mapping[str, int]) -> None:
        _nonempty(reservation_id, "RUNTIME_BUDGET_RESERVATION_ID_INVALID")
        reservation = self._reserved.get(reservation_id)
        if reservation is None:
            raise RuntimeLedgerError("RUNTIME_BUDGET_RESERVATION_UNKNOWN")
        normalized = self._normalize(actual)
        if any(normalized[key] > reservation.amount[key] for key in normalized):
            raise RuntimeLedgerError("RUNTIME_BUDGET_SETTLEMENT_EXCEEDS_RESERVATION")
        del self._reserved[reservation_id]
        for key, value in normalized.items():
            self._settled[key] += value

    def cancel(self, reservation_id: str) -> None:
        _nonempty(reservation_id, "RUNTIME_BUDGET_RESERVATION_ID_INVALID")
        if self._reserved.pop(reservation_id, None) is None:
            raise RuntimeLedgerError("RUNTIME_BUDGET_RESERVATION_UNKNOWN")
