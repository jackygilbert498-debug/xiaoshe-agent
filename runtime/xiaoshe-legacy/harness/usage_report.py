"""每会话 token / 请求 / prompt 缓存命中 / 费用统计（P2 验收锚：可观测且能对上账）。

读会话日志（`.state/logs/<sid>.jsonl`，每 assistant 轮记 `usage`）聚合。**Kimi coding 端点按请求次数计费**
（真机探针），故费用口径 = 请求数；同时报 token 与 prompt 缓存命中率（`prompt_tokens_details.cached_tokens`）。
查看命令：`python run.py cost [会话id]`（不给 id = 列最近若干会话）。
诚实口径（对抗审查）：**请求数只统计落日志的主循环轮，不含上下文压缩摘要（compaction._summarize）那次未落日志的调用**，
故报出的请求数是"下界"，实际计费可能略多（每触发一次压缩多 1 次请求）。
"""
from __future__ import annotations

import json
from pathlib import Path

from . import session


def summarize_log(path) -> dict:
    """聚合一份会话日志：请求数（=计费口径）、prompt/completion token、缓存命中 token 与命中率。"""
    def _num(v):   # 只认数值（排除 bool）；坏值一律记 0，别让一条坏 usage 崩掉全项目总账（#12）
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0
    reqs = pt = ct = cached = 0
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        u = r.get("usage")
        if not isinstance(u, dict) or not u.get("prompt_tokens"):
            continue
        reqs += 1
        pt += _num(u.get("prompt_tokens"))   # 类型硬化（#12）：坏日志里 token 若是字符串/列表，别 int+=str 崩掉整份总账
        ct += _num(u.get("completion_tokens"))
        details = u.get("prompt_tokens_details")
        cached += _num(details.get("cached_tokens") if isinstance(details, dict) else u.get("cached_tokens"))
    return {"requests": reqs, "prompt_tokens": pt, "completion_tokens": ct,
            "cached_tokens": cached, "hit_rate": round(cached / pt, 3) if pt else 0.0}


_CAVEAT = "（注：请求数只含落日志的主循环轮，不含上下文压缩摘要那次调用，实际计费可能略多）"


def totals(logs_dir=None) -> dict:
    """全项目总账：跨所有会话日志求和（会话数/总请求/总 token/总缓存命中/命中率）。空目录回全零、不崩。"""
    logs_dir = Path(logs_dir) if logs_dir else session.LOGS_DIR
    agg = {"sessions": 0, "requests": 0, "prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0}
    if Path(logs_dir).exists():
        for f in sorted(Path(logs_dir).glob("*.jsonl")):
            s = summarize_log(f)
            if s["requests"]:
                agg["sessions"] += 1
                for k in ("requests", "prompt_tokens", "completion_tokens", "cached_tokens"):
                    agg[k] += s[k]
    agg["hit_rate"] = round(agg["cached_tokens"] / agg["prompt_tokens"], 3) if agg["prompt_tokens"] else 0.0
    return agg


def _fmt(sid: str, s: dict) -> str:
    return (f"{sid}\n"
            f"  请求数（计费口径，下界）：{s['requests']}\n"
            f"  prompt token：{s['prompt_tokens']}（其中缓存命中 {s['cached_tokens']}，命中率 {s['hit_rate']:.1%}）\n"
            f"  生成 token：{s['completion_tokens']}")


def _fmt_totals(t: dict) -> str:
    return (f"全项目总账（{t['sessions']} 个会话）：\n"
            f"  总请求（计费口径，下界）：{t['requests']}\n"
            f"  总 prompt token：{t['prompt_tokens']}（缓存命中 {t['cached_tokens']}，命中率 {t['hit_rate']:.1%}）\n"
            f"  总生成 token：{t['completion_tokens']}")


def report(session_id: str | None = None, recent: int = 10, logs_dir=None) -> str:
    """给定会话 id → 该会话统计；不给 → 全项目总账 + 最近 recent 个会话明细。"""
    logs_dir = Path(logs_dir) if logs_dir else session.LOGS_DIR
    if session_id:
        p = logs_dir / f"{session_id}.jsonl"
        if not p.exists():
            return f"没找到会话日志：{session_id}（看 .state/logs/ 里的 id）"
        return _fmt(session_id, summarize_log(p)) + "\n" + _CAVEAT
    if not Path(logs_dir).exists():
        return "还没有任何会话日志。"
    def _mtime(f):   # 排序枚举与 stat 之间文件被删/轮转时不抛 FileNotFoundError 崩报告（#14 TOCTOU）
        try:
            return f.stat().st_mtime
        except OSError:
            return 0.0
    files = sorted(Path(logs_dir).glob("*.jsonl"), key=_mtime, reverse=True)[:recent]
    if not files:
        return "还没有任何会话日志。"
    lines = [_fmt_totals(totals(logs_dir)), "", "最近会话明细（Kimi coding 按请求计费）：\n"]
    for f in files:
        s = summarize_log(f)
        if s["requests"]:
            lines.append(_fmt(f.stem, s))
    lines.append(_CAVEAT)
    return "\n".join(lines)
