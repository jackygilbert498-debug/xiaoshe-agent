"""上下文窗口自校准 · compaction 75% 触发点的地基。

真 Kimi 超限时回 HTTP 400，体形状（探针实测，流式/非流式同形）：
  {"error":{"message":"Invalid request: Your request exceeded model token limit: 262144 (requested: 367360)",
            "type":"invalid_request_error"}}
provider 在报错里**明说真窗口(262144)与本次请求量(367360)**——
把窗口当权威落盘（比任何本地假设都准），把请求量当密度真值供 emergency_truncate 精确截断。

窗口是模型的固定属性；默认取 config.CONTEXT_WINDOW_TOKENS（探针确认 262144），
一旦从真超限报错学到别的（更小模型/账户降级）就落盘沿用、下会话不再重蹈超限。
落盘只在 .state（harness 私有态、模型读写不了）；读路径严格校验越界即回退默认，绝不信坏值/带外篡改。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import _io, config

# 匹配真报错里的两个数字：`token limit: <窗口> (requested: <本次请求>)`，大小写无关、容忍空白。
_OVERFLOW_RE = re.compile(r"token limit:\s*(\d+)\s*\(\s*requested:\s*(\d+)\s*\)", re.IGNORECASE)

_WINDOW_FILE = config.STATE_DIR / "context_window.json"
_MIN_WINDOW = config.WINDOW_MIN   # 合理下界：比这还小的窗口没法干活，判坏值（防把预算压成几 token 每轮空压死循环）
_MAX_WINDOW = config.WINDOW_MAX   # 合理上界：防坏值/注入报天文数字骗过 75% 闸致每次必溢


def _err_text(err) -> str:
    """把各种形态的报错规整成可搜的字符串：str/异常原样 str()；dict 取 error.message 或整体 json。"""
    if isinstance(err, dict):
        e = err.get("error", err)
        if isinstance(e, dict):
            msg = e.get("message")
            if isinstance(msg, str) and msg:
                return msg
            return json.dumps(e, ensure_ascii=False)
        return str(e)
    return str(err)


def parse_overflow(err) -> tuple[int, int] | None:
    """从 Kimi 报错里取 (真窗口, 本次请求 token)。非超限错误/取不到数字/越界一律 None。

    err 可为 str、dict（{"message":...} 或 {"error":{...}}）、或异常对象（str(e) 含数字即可）。
    越界拒信（<_MIN_WINDOW 或 >_MAX_WINDOW）——坏窗口比不校准更危险。
    """
    m = _OVERFLOW_RE.search(_err_text(err))
    if not m:
        return None
    window, requested = int(m.group(1)), int(m.group(2))
    if not (_MIN_WINDOW <= window <= _MAX_WINDOW) or requested <= 0:
        return None
    return window, requested


def _fallback_window() -> int:
    """回退窗口：config 默认也夹到 [MIN,MAX]，令窗口界不变量对所有来源成立（红队 LOW）。"""
    return min(_MAX_WINDOW, max(_MIN_WINDOW, config.CONTEXT_WINDOW_TOKENS))


def load_window(path=None) -> int:
    """读落盘的真窗口；缺档/坏档/越界/**跨模型陈旧**一律回退默认（绝不信坏值/别模型的窗口）。"""
    p = Path(path) if path is not None else _WINDOW_FILE
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            m = data.get("model")
            if m and m != config.MODEL:
                return _fallback_window()   # 别模型学到的窗口，换模型后不采用（防旧小窗口永久拖累压缩预算）
            w = data.get("window")
            if isinstance(w, int) and not isinstance(w, bool) and _MIN_WINDOW <= w <= _MAX_WINDOW:
                return w
    except (OSError, ValueError, TypeError):
        pass
    return _fallback_window()


def save_window(window: int, requested: int | None = None, path=None) -> bool:
    """把从真报错学到的窗口落盘（越界拒写；带模型标识供跨模型失效）。返回是否写了。

    落盘是**尽力而为**：.state 不可写（只读挂载/满盘/flock 不支持）时吞掉异常返 False——
    绝不能让一次持久化失败挡住调用方（尤其 _send 的溢出恢复网）（红队 MED）。
    """
    if not (isinstance(window, int) and not isinstance(window, bool)
            and _MIN_WINDOW <= window <= _MAX_WINDOW):
        return False
    p = Path(path) if path is not None else _WINDOW_FILE
    rec = {"window": window, "source": "calibrated", "model": config.MODEL}
    if isinstance(requested, int) and requested > 0:
        rec["requested_at_overflow"] = requested
    try:
        with _io.file_lock(p):
            _io.atomic_write_json(p, rec)
    except (OSError, TimeoutError):
        return False
    return True


def effective_window(ctx=None) -> int:
    """本会话生效的真窗口：ctx 里已学到的 > 落盘的 > 默认。"""
    if isinstance(ctx, dict):
        w = ctx.get("_context_window")
        if isinstance(w, int) and not isinstance(w, bool) and _MIN_WINDOW <= w <= _MAX_WINDOW:
            return w
    return load_window()


def trigger_budget(ctx=None) -> int:
    """75% 触发预算 = 真窗口 × 触发比。显式 env 覆盖优先（尊重用户自定义，回退旧行为）。"""
    if config.CONTEXT_BUDGET_OVERRIDE is not None:
        return config.CONTEXT_BUDGET_OVERRIDE
    return int(effective_window(ctx) * config.COMPACT_TRIGGER_RATIO)


def learn_window(window: int, requested: int | None = None, ctx=None) -> bool:
    """从真超限报错学到窗口：**先写 ctx 内存预算**（立即生效、不会失败），再尽力落盘。

    次序关键（红队 MED）：ctx 收紧与落盘解耦——即使 .state 不可写、落盘挂了，本会话预算也已收紧，
    溢出恢复照常进行。返回是否落盘成功（本会话生效不依赖它）。
    """
    if isinstance(ctx, dict) and isinstance(window, int) and not isinstance(window, bool) \
            and _MIN_WINDOW <= window <= _MAX_WINDOW:
        ctx["_context_window"] = window
    return save_window(window, requested)
