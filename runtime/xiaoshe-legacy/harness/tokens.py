"""token 计量（#2a）：provider 的 usage 优先，没有时本地粗估兜底。

明确【不引 tiktoken / 本地 BPE 词表】——那会在 Windows 首用时联网下词表，违背纯标准库 + 跨机 + 单机纪律。
本地估算只当 provider 没给 usage（首轮/流式缺失/离线测）时的兜底，真值一律以 provider usage 为准。
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping
from itertools import islice

# 仅覆盖 CJK 统一 + CJK 符号 + 全角（漏 Ext-A/假名/谚文）——够中文优先兜底，别当通用 tokenizer 用。
_CJK = re.compile(r"[一-鿿　-〿＀-￯]")

# 长 base64/高熵 ASCII 连串：BPE 上约 1.3–1.6 字符/token，远密于默认的 4 字符/token。默认会把它严重低估、
# 骗过 token 预算致越 provider 上限直接 400（F03 复审）。对 ≥64 连续 base64 字符段单独按更密的 _B64_DENSITY 计。
_B64_RUN = re.compile(r"[A-Za-z0-9+/]{64,}={0,2}")
_B64_DENSITY = 1.4  # 字符/token（取 base64 真实密度偏保守下限：宁可高估 token 提前压缩，不可低估致越限 400）


def from_usage(usage) -> int | None:
    """从 provider 的 usage 取真实 prompt_tokens；缺失或非法返回 None（改用本地估算）。"""
    if isinstance(usage, dict):
        pt = usage.get("prompt_tokens")
        if isinstance(pt, int) and pt >= 0:
            return pt
    return None


def estimate_text(s: str) -> int:
    """粗估 token：CJK ≈ 1 token/字，长 base64/高熵段 ≈ 1.4 字符/token，其余 ≈ 4 字符/token。仅无 provider usage 时用。"""
    if not s:
        return 0
    cjk = len(_CJK.findall(s))
    dense = sum(len(m.group()) for m in _B64_RUN.finditer(s))  # 长 base64 段（全 ASCII，不与 CJK 重叠）
    rest = len(s) - cjk - dense
    tokens = cjk
    if rest > 0:
        tokens += max(1, round(rest / 4))
    if dense:
        tokens += round(dense / _B64_DENSITY)  # F03：base64 密得多，单独高密度计，防长串骗过预算越限
    return tokens


def estimate_messages(history: list) -> int:
    """整段 history 的估算 token 和（与 compaction 同源 json 序列化，非文本不抛）。"""
    total = 0
    for m in history:
        try:
            total += estimate_text(json.dumps(m, ensure_ascii=False))
        except (TypeError, ValueError):
            total += estimate_text(str(m))
    return total


def estimate_public_value(value, *, max_nodes: int = 2048, max_depth: int = 12) -> int:
    """Conservatively estimate an adversarial public value with hard work bounds.

    Cycles, huge mappings and deeply nested values are represented by markers;
    booleans and negative budgets never acquire special numeric meaning here.
    """
    seen: set[int] = set()
    nodes = 0

    def render(current, depth):
        nonlocal nodes
        nodes += 1
        if nodes > max_nodes:
            return "[node-budget-exceeded]"
        if depth > max_depth:
            return "[depth-budget-exceeded]"
        if isinstance(current, (Mapping, list, tuple, set)):
            ident = id(current)
            if ident in seen:
                return "[cycle]"
            seen.add(ident)
            try:
                if isinstance(current, Mapping):
                    try:
                        if len(current) > 256:
                            return {"truncated_mapping_size": len(current)}
                    except (TypeError, OverflowError):
                        return {"truncated_mapping": True}
                    return {str(k)[:128]: render(v, depth + 1)
                            for k, v in sorted(islice(current.items(), 256), key=lambda p: str(p[0]))}
                return [render(v, depth + 1) for v in islice(iter(current), 256)]
            finally:
                seen.discard(ident)
        if isinstance(current, float) and (current != current or abs(current) == float("inf")):
            return str(current)
        if current is None or type(current) in (bool, int, float):
            return current
        return str(current)[:4096]

    try:
        public = render(value, 0)
        return estimate_text(json.dumps(public, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    except (TypeError, ValueError, RecursionError):
        return estimate_text("[unrenderable-public-value]")
