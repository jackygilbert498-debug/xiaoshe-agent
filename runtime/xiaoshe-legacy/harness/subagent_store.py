"""P5 · 5e 子 agent 结果共享区（进程内）：并行聚合只回轻量引用，全文按需 recall_subagent 取回（MemGPT 分页思想）。

**诚实说明（去假安全感）**：本区对 agent 可读——子结论本就是 agent 自己产出的，不是敏感数据；`permission._is_sensitive`
只拦 `.state/schedule`，对这里不设防，故不假装「落盘天然受保护」。纯进程内 dict，随进程消亡，不落盘。
"""
from __future__ import annotations

import threading

_STORE: dict = {}
_seq = 0
_lock = threading.Lock()
_MAX_STORE = 100   # 进程内共享区上限：超限淘汰最旧（dict 保插入序），防长会话内存无界增长（M6 修复）


def put(objective: str, full_text: str) -> str:
    """存一条子结论全文，返回轻量引用 ref_id（sa_N，会话内单调）。线程安全（并行子 agent 同时写不撞号）。"""
    global _seq
    with _lock:
        _seq += 1
        ref = f"sa_{_seq}"
        _STORE[ref] = {"objective": objective or "", "text": full_text or ""}
        while len(_STORE) > _MAX_STORE:            # 超限淘汰最旧（旧引用 recall 不到属预期）
            del _STORE[next(iter(_STORE))]
    return ref


def get(ref_id: str):
    """按 ref_id 取回完整子结论 {objective,text}；不存在回 None。"""
    return _STORE.get(ref_id)


def brief(ref_id: str) -> dict:
    """轻量引用视图：{ref_id, objective, summary(前~200字), chars}——并行父只拿这个，不含全文。"""
    r = _STORE.get(ref_id) or {}
    text = r.get("text", "")
    return {"ref_id": ref_id, "objective": r.get("objective", ""),
            "summary": text[:200] + ("…" if len(text) > 200 else ""), "chars": len(text)}
