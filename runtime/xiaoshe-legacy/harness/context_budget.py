"""Deterministic, bounded selection of public model context.

This module deliberately handles public facts only.  It neither stores nor
attempts to reconstruct a model's private reasoning.
"""
from __future__ import annotations

import json
import math
import re
from itertools import islice
from dataclasses import dataclass, replace
from typing import Any, Mapping, Sequence

from . import tokens


_PROTECTED_KINDS = frozenset({
    "active_task", "user_constraint", "permission_decision",
    "pending_approval", "recent_error", "tool_result", "evidence",
    "image_reference",
})
_PRIVATE_KEYS = frozenset({
    "reasoning", "thinking", "chain_of_thought", "chain-of-thought",
    "private_reasoning", "internal_reasoning", "cot",
})
_PRIVATE_KEY_RE = re.compile(r"(?:^|[_-])(reasoning|thinking|chain[_-]?of[_-]?thought|cot)(?:$|[_-])", re.IGNORECASE)
_SECRET_KEYS = re.compile(
    r"(?:^|[_-])(api[_-]?key|authorization|cookie|password|secret|token|bytes|data|path)(?:$|[_-])",
    re.IGNORECASE,
)
_SECRET_VALUES = re.compile(r"(?:\bbearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,})", re.IGNORECASE)
_MAX_ITEMS = 4096
_MAX_NODES = 2048
_MAX_DEPTH = 12
_MAX_TEXT = 4096
_MAX_PROTECTED_TEXT = 16 * 1024 * 1024


class ContextBudgetError(RuntimeError):
    """Stable fail-closed context error containing public source ids only."""

    def __init__(self, code: str, source_ids: Sequence[str] = ()) -> None:
        self.code = code
        self.source_ids = tuple(source_ids)
        super().__init__(code)


@dataclass(frozen=True)
class ContextBudget:
    window_tokens: int
    reserved_output_tokens: int
    stable_prefix_tokens: int
    active_task_tokens: int
    evidence_tokens: int
    history_tokens: int
    remaining_tokens: int

    def __post_init__(self) -> None:
        values = tuple(getattr(self, name) for name in self.__dataclass_fields__)
        if any(type(value) is not int or value < 0 for value in values):
            raise ValueError("context budget values must be non-negative integers")
        allocated = sum(values[1:])
        if allocated != self.window_tokens:
            raise ValueError("context budget allocations must exactly match the window")
        if self.reserved_output_tokens <= 0:
            raise ValueError("reserved output tokens must remain positive")


def allocate_context_budget(
    window_tokens: int,
    *,
    reserved_output_tokens: int | None = None,
    stable_prefix_tokens: int | None = None,
    estimation_error_tokens: int | None = None,
) -> ContextBudget:
    """Allocate one conservative budget without borrowing safety reserves."""
    for name, value in (
        ("window_tokens", window_tokens),
        ("reserved_output_tokens", reserved_output_tokens),
        ("stable_prefix_tokens", stable_prefix_tokens),
        ("estimation_error_tokens", estimation_error_tokens),
    ):
        if value is not None and (type(value) is not int or value < 0):
            raise ValueError(f"{name} must be a non-negative integer")
    if window_tokens < 64:
        raise ValueError("context window is too small")
    reserved = reserved_output_tokens if reserved_output_tokens is not None else max(16, window_tokens // 5)
    prefix = stable_prefix_tokens if stable_prefix_tokens is not None else max(8, window_tokens // 20)
    margin = estimation_error_tokens if estimation_error_tokens is not None else max(8, window_tokens // 10)
    usable = window_tokens - reserved - prefix - margin
    if reserved <= 0 or usable < 3:
        raise ValueError("context window cannot satisfy safety reserves")
    active = max(1, usable // 4)
    evidence = max(1, usable // 4)
    history = usable - active - evidence
    return ContextBudget(
        window_tokens, reserved, prefix, active, evidence, history, margin,
    )


@dataclass(frozen=True)
class ContextItem:
    source_id: str
    kind: str
    content: Any
    completed: bool = False
    task_id: str | None = None
    run_id: str | None = None
    session_id: str | None = None
    sequence: int = 0

    def __post_init__(self) -> None:
        if not isinstance(self.source_id, str) or not self.source_id.strip():
            raise ValueError("source_id must be non-empty text")
        if (len(self.source_id) > 256 or any(ord(ch) < 32 for ch in self.source_id)
                or _SECRET_VALUES.search(self.source_id)):
            raise ValueError("source_id must be bounded public text")
        if not isinstance(self.kind, str) or not self.kind.strip():
            raise ValueError("kind must be non-empty text")
        if type(self.completed) is not bool or type(self.sequence) is not int:
            raise ValueError("invalid completed or sequence")


@dataclass(frozen=True)
class ContextSummary:
    source_ids: tuple[str, ...]
    text: str
    estimated_tokens: int


@dataclass(frozen=True)
class ContextSelection:
    items: tuple[ContextItem, ...]
    summaries: tuple[ContextSummary, ...]
    source_ids: tuple[str, ...]
    estimated_tokens: int
    overflow_tokens: int
    task_critical_preserved: bool


def _safe_scalar(value: object, *, protected: bool = False) -> object:
    if value is None or type(value) in (bool, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ContextBudgetError("invalid_context_content")
        return value
    if not isinstance(value, str):
        raise ContextBudgetError("invalid_context_content")
    text = value
    if _SECRET_VALUES.search(text):
        return "[redacted]"
    if protected:
        if len(text) > _MAX_PROTECTED_TEXT:
            raise ContextBudgetError("protected_item_exceeds_hard_limit")
        return text
    return text[:_MAX_TEXT]


def _safe_image_reference(value: object) -> dict[str, object]:
    """Extract a traceable identity/purpose from nested metadata, never payloads."""
    if not isinstance(value, Mapping):
        raise ContextBudgetError("invalid_image_reference")
    envelope = "role" in value and "content" in value
    role = value.get("role") if envelope else None
    if envelope and role not in {"user", "assistant", "system", "tool"}:
        raise ContextBudgetError("invalid_image_reference")
    if envelope:
        raw_content = value.get("content")
        parts = raw_content if isinstance(raw_content, list) else [raw_content]
        if len(parts) > 256:
            raise ContextBudgetError("invalid_image_reference")
        safe_parts = []
        for part in parts:
            if not isinstance(part, Mapping):
                raise ContextBudgetError("invalid_image_reference")
            part_type = part.get("type")
            if part_type == "text":
                continue
            safe_parts.append({"type": "image_reference", **_safe_image_reference(part)})
        if not safe_parts:
            raise ContextBudgetError("invalid_image_reference")
        return {"role": role, "content": safe_parts}
    result: dict[str, object] = {}
    stack: list[tuple[str, object, int]] = [("", value, 0)]
    seen: set[int] = set()
    nodes = 0
    while stack:
        parent, current, depth = stack.pop()
        nodes += 1
        if nodes > _MAX_NODES or depth > _MAX_DEPTH:
            raise ContextBudgetError("invalid_image_reference")
        if isinstance(current, (list, tuple)):
            if len(current) > 256:
                raise ContextBudgetError("invalid_image_reference")
            stack.extend((parent, child, depth + 1) for child in reversed(current))
            continue
        if not isinstance(current, Mapping):
            continue
        ident = id(current)
        if ident in seen:
            raise ContextBudgetError("invalid_image_reference")
        seen.add(ident)
        try:
            pairs = list(current.items())
        except Exception as error:
            raise ContextBudgetError("invalid_image_reference") from error
        if len(pairs) > 256:
            raise ContextBudgetError("invalid_image_reference")
        seen_keys: set[str] = set()
        for raw_key, child in pairs:
            if not isinstance(raw_key, str):
                raise ContextBudgetError("invalid_image_reference")
            key = raw_key.casefold()
            if key in seen_keys:
                raise ContextBudgetError("invalid_image_reference")
            seen_keys.add(key)
            if isinstance(child, Mapping):
                stack.append((key, child, depth + 1))
                continue
            if key in {"media_id", "attachment_id", "ref"}:
                result[key] = _safe_scalar(child, protected=True)
            elif key == "id" and parent in {"attachment", "image", "media"}:
                result["attachment_id" if parent == "attachment" else "media_id"] = _safe_scalar(child, protected=True)
            elif key in {"purpose", "mime_type"}:
                result[key] = _safe_scalar(child, protected=True)
    if not any(key in result for key in ("media_id", "attachment_id", "ref")):
        raise ContextBudgetError("invalid_image_reference")
    return result


def _safe_public(value: object, *, protected: bool = False, image: bool = False) -> object:
    """Copy an adversarial value into a bounded, acyclic public structure."""
    if image:
        return _safe_image_reference(value)
    seen: set[int] = set()
    nodes = 0

    def visit(current: object, depth: int) -> object:
        nonlocal nodes
        nodes += 1
        if nodes > _MAX_NODES:
            if protected:
                raise ContextBudgetError("invalid_context_content")
            return "[node-budget-exceeded]"
        if depth > _MAX_DEPTH:
            if protected:
                raise ContextBudgetError("invalid_context_content")
            return "[depth-budget-exceeded]"
        if isinstance(current, (Mapping, list, tuple, set)):
            ident = id(current)
            if ident in seen:
                if protected:
                    raise ContextBudgetError("invalid_context_content")
                return "[cycle]"
            seen.add(ident)
            try:
                if isinstance(current, Mapping):
                    output = {}
                    try:
                        if len(current) > 256:
                            if protected:
                                raise ContextBudgetError("invalid_context_content")
                            return {"truncated_mapping_size": len(current)}
                        raw_pairs = current.items()
                        pairs = list(islice(raw_pairs, 257))
                    except ContextBudgetError:
                        raise
                    except Exception as error:
                        raise ContextBudgetError("invalid_context_content") from error
                    if len(pairs) > 256:
                        if protected:
                            raise ContextBudgetError("invalid_context_content")
                        pairs = pairs[:256]
                    if any(not isinstance(pair, tuple) or len(pair) != 2
                           or not isinstance(pair[0], str) for pair in pairs):
                        raise ContextBudgetError("invalid_context_content")
                    pairs.sort(key=lambda item: item[0])
                    if len({pair[0] for pair in pairs}) != len(pairs):
                        raise ContextBudgetError("invalid_context_content")
                    for raw_key, raw_value in pairs:
                        key = raw_key
                        key = key if protected else key[:128]
                        lowered = key.casefold()
                        if (lowered in _PRIVATE_KEYS or _PRIVATE_KEY_RE.search(key)
                                or _SECRET_KEYS.search(key)):
                            continue
                        output[key] = visit(raw_value, depth + 1)
                    return output
                try:
                    if isinstance(current, set):
                        if len(current) > 256:
                            if protected:
                                raise ContextBudgetError("invalid_context_content")
                            return ["[set-item-budget-exceeded]"]
                        canonical = []
                        for item in current:
                            if type(item) not in (type(None), bool, int, float, str):
                                raise ContextBudgetError("invalid_context_content")
                            try:
                                encoded = json.dumps(
                                    item, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False,
                                )
                            except (TypeError, ValueError) as error:
                                raise ContextBudgetError("invalid_context_content") from error
                            canonical.append((encoded, item))
                        ordered = [item for _encoded, item in sorted(canonical, key=lambda pair: pair[0])]
                    else:
                        ordered = list(islice(iter(current), 257))
                except ContextBudgetError:
                    raise
                except Exception as error:
                    if protected:
                        raise ContextBudgetError("invalid_context_content") from error
                    return ["[invalid-container]"]
                if len(ordered) > 256:
                    if protected:
                        raise ContextBudgetError("invalid_context_content")
                    ordered = ordered[:256]
                return [visit(item, depth + 1) for item in ordered]
            finally:
                seen.discard(ident)
        return _safe_scalar(current, protected=protected)

    return visit(value, 0)


def canonical_public_json(value: object, *, protected: bool = False) -> tuple[object, str]:
    """Return the bounded public value and its deterministic JSON encoding."""
    safe = _safe_public(value, protected=protected)
    try:
        encoded = json.dumps(
            safe, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise ContextBudgetError("invalid_context_content") from error
    return safe, encoded


def _item_tokens(item: ContextItem) -> int:
    return max(1, tokens.estimate_public_value({
        "source_id": item.source_id,
        "kind": item.kind,
        "content": item.content,
        "task_id": item.task_id,
        "run_id": item.run_id,
        "session_id": item.session_id,
    }))


def _sort_key(item: ContextItem) -> tuple[int, int, str]:
    protected = 0 if item.kind in _PROTECTED_KINDS else 1
    # Within a category, newest public facts have priority; source id breaks ties.
    return (protected, -item.sequence, item.source_id)


def select_context(items: Sequence[ContextItem], budget: ContextBudget, *, session=None) -> ContextSelection:
    """Select a stable context view, preserving all task-critical public facts.

    Protected facts may overflow the input allocation: reserved output and the
    stable prefix are never borrowed to hide a conflict.  Callers can surface
    ``overflow_tokens`` and request a larger window or explicit user decision.
    """
    if not isinstance(budget, ContextBudget):
        raise TypeError("budget must be ContextBudget")
    if not isinstance(items, Sequence) or isinstance(items, (str, bytes)):
        raise TypeError("items must be a sequence")
    try:
        item_count = len(items)
    except Exception as error:
        raise ContextBudgetError("invalid_context_items") from error
    if item_count > _MAX_ITEMS:
        raise ValueError("context item limit exceeded")
    normalized: list[ContextItem] = []
    seen_system: set[str] = set()
    seen_sources: set[str] = set()
    try:
        bounded_items = list(islice(iter(items), _MAX_ITEMS + 1))
    except Exception as error:
        raise ContextBudgetError("invalid_context_items") from error
    if len(bounded_items) != item_count:
        raise ContextBudgetError("invalid_context_items")
    for raw in sorted(bounded_items, key=lambda item: (
            item.sequence if isinstance(item, ContextItem) else 0,
            item.source_id if isinstance(item, ContextItem) else "")):
        if not isinstance(raw, ContextItem):
            raise TypeError("all context items must be ContextItem")
        if raw.source_id in seen_sources:
            raise ContextBudgetError("duplicate_source_id", (raw.source_id,))
        seen_sources.add(raw.source_id)
        if session is not None:
            identity = getattr(session, "identity", None)
            if identity is None:
                raise ContextBudgetError("runtime_session_required")
            if ((raw.task_id is not None and raw.task_id != identity.task_id)
                    or (raw.run_id is not None and raw.run_id != identity.run_id)
                    or (raw.session_id is not None and raw.session_id != identity.session_id)):
                raise ContextBudgetError("context_domain_mismatch", (raw.source_id,))
        protected = raw.kind in _PROTECTED_KINDS
        try:
            safe = _safe_public(raw.content, protected=protected,
                                image=raw.kind == "image_reference")
        except ContextBudgetError as error:
            if not error.source_ids:
                error.source_ids = (raw.source_id,)
            raise
        item = replace(raw, content=safe)
        if item.kind == "system":
            fingerprint = json.dumps(safe, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            if fingerprint in seen_system:
                continue
            seen_system.add(fingerprint)
        normalized.append(item)

    capacity = budget.active_task_tokens + budget.evidence_tokens + budget.history_tokens
    chosen: list[ContextItem] = []
    deferred: list[ContextItem] = []
    used = 0
    old_completed = sorted(
        (item for item in normalized if item.completed and item.kind == "history"),
        key=lambda item: (item.sequence, item.source_id),
    )
    old_source_ids = {item.source_id for item in old_completed}
    priority_items = [item for item in normalized if item.source_id not in old_source_ids]
    for item in sorted(priority_items, key=_sort_key):
        cost = _item_tokens(item)
        if item.kind in _PROTECTED_KINDS and cost > capacity:
            raise ContextBudgetError("protected_item_exceeds_context_window", (item.source_id,))
        if item.kind in _PROTECTED_KINDS or used + cost <= capacity:
            chosen.append(item)
            used += cost
        else:
            deferred.append(item)

    summaries: list[ContextSummary] = []
    old_costs = [_item_tokens(item) for item in old_completed]
    if used + sum(old_costs) <= capacity:
        chosen.extend(old_completed)
        used += sum(old_costs)
        old_completed = []
    for start in range(0, len(old_completed), 8):
        chunk = old_completed[start:start + 8]
        source_ids = tuple(item.source_id for item in chunk)
        rendered_facts = []
        for item in chunk:
            try:
                rendered = json.dumps(item.content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            except Exception:
                rendered = "[invalid-public-fact]"
            rendered_facts.append(rendered)
        text = ""
        cost = capacity + 1
        for fact_limit in (96, 48, 24, 0):
            encoded_sources = json.dumps(
                list(source_ids), ensure_ascii=False, separators=(",", ":"),
            )
            text = "completed old turns; source_ids=" + encoded_sources
            if fact_limit:
                text += "; public_facts=" + " | ".join(
                    fact[:fact_limit] for fact in rendered_facts)
            cost = max(1, tokens.estimate_public_value({"role": "system", "content": text}))
            if used + cost <= capacity:
                break
        if used + cost <= capacity:
            summaries.append(ContextSummary(source_ids, text, cost))
            used += cost

    chosen.sort(key=lambda item: (item.sequence, item.source_id))
    represented_summary_ids = tuple(source for summary in summaries for source in summary.source_ids)
    source_ids = tuple(item.source_id for item in chosen) + represented_summary_ids
    estimated = used
    protected_ids = {item.source_id for item in normalized if item.kind in _PROTECTED_KINDS}
    return ContextSelection(
        tuple(chosen), tuple(summaries), source_ids, estimated,
        max(0, estimated - capacity), protected_ids.issubset(set(source_ids)),
    )
