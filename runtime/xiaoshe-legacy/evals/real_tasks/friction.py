"""D3 摩擦点采集：解析 run_headless 的会话 JSONL 日志（.state/logs/headless-<sid>.jsonl），提炼客观信号。

信号口径（全部来自日志/摘要文件，不脑补）：
- rounds：assistant 带 tool_calls 的条数（≈ 工具往返轮数，越多越曲折）
- tool_errors / error_by_tool：is_error 的工具结果（工具误选/命令写错的直接证据，附首条摘录）
- denied_calls：HARNESS_RUN_SUMMARY 的越权信号灯（审批卡壳）
- verify_nudges / stall_nudges / round_reminds：独立验收驳回 / 停滞软提醒 / 轮数逼近提醒的注入次数
- hit_round_limit / stalled_out：收尾文案里的硬停证据
- tokens：usage 累加（prompt/completion，成本观）
- compaction_observable / compaction_events / compaction_stats / compaction_summary：
  P2-7 压缩事件（auto_compact/force_compact/emergency_truncate/tool_result_clearing）消费统计。
  事件真实格式见 harness/agent.py `_observe_compaction`（扁平字段：ts/kind/reason/
  before_msgs/after_msgs/before_chars/after_chars/cleared/depth）；无事件时如实标
  「无可观测压缩事件」，不留 false 占位。
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

_NUDGE_PREFIXES = ("[独立验收]", "[系统提醒]")
_STALL_MARK = "连续无进展"
_ROUND_LIMIT_MARKS = ("工具调用轮数超上限", "工具调用轮数过多")  # 悬空补配文案 / 收尾回复文案两种


def parse_session_log(log_path: Path) -> dict:
    """会话 JSONL → 摩擦信号 dict。日志不存在/坏行 → 尽量给部分结果（诚实口径，缺的字段为 None/0）。"""
    out = {"rounds": 0, "tool_calls": 0, "tool_errors": 0, "error_by_tool": {},
           "first_errors": [], "verify_nudges": 0, "stall_nudges": 0, "round_reminds": 0,
           "hit_round_limit": False, "stalled_out": False,
           "prompt_tokens": None, "completion_tokens": None, "final_reply": None,
           "tools_used": {}, "compaction_observable": False, "compaction_events": [],
           "compaction_stats": None, "compaction_summary": "无可观测压缩事件"}
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return out
    err_by_tool, tools_used = Counter(), Counter()
    ptok = ctok = 0
    for line in lines:
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        role = rec.get("role")
        if role == "assistant":
            tcs = rec.get("tool_calls") or []
            if tcs:
                out["rounds"] += 1
                out["tool_calls"] += len(tcs)
                tools_used.update(tcs)
            elif rec.get("content"):
                out["final_reply"] = rec["content"]  # 最后一条纯文本回复
                if any(m in rec["content"] for m in _ROUND_LIMIT_MARKS):
                    out["hit_round_limit"] = True
                if _STALL_MARK in rec["content"]:
                    out["stalled_out"] = True
            u = rec.get("usage") or {}
            ptok += u.get("prompt_tokens") or 0
            ctok += u.get("completion_tokens") or 0
        elif role == "tool":
            if rec.get("is_error"):
                out["tool_errors"] += 1
                err_by_tool[rec.get("name", "?")] += 1
                if len(out["first_errors"]) < 3:
                    out["first_errors"].append(f"{rec.get('name')}: {(rec.get('content') or '')[:120]}")
        elif role == "user":
            c = rec.get("content") or ""
            if c.startswith(_NUDGE_PREFIXES[0]):
                out["verify_nudges"] += 1
            elif c.startswith(_NUDGE_PREFIXES[1]):
                out["round_reminds"] += 1
            elif "换策略" in c or "停滞" in c:
                out["stall_nudges"] += 1
        elif role == "system" and rec.get("event") == "compaction":
            # P2-7：压缩事件消费（真实落盘格式，扁平字段，见 agent.py _observe_compaction）
            out["compaction_observable"] = True
            out["compaction_events"].append({
                "kind": rec.get("kind"),
                "ts": rec.get("ts"),
                "reason": rec.get("reason"),
                "before_msgs": rec.get("before_msgs"),
                "after_msgs": rec.get("after_msgs"),
                "before_chars": rec.get("before_chars"),
                "after_chars": rec.get("after_chars"),
                "cleared": rec.get("cleared"),
                "depth": rec.get("depth"),
            })
    evs = out["compaction_events"]
    if evs:   # 有事件 → 出统计（次数/类型/时间/节省量），替换 false 占位
        by_kind = Counter(e["kind"] for e in evs)
        saved = sum((e["before_chars"] or 0) - (e["after_chars"] or 0) for e in evs)
        out["compaction_stats"] = {"count": len(evs), "by_kind": dict(by_kind),
                                   "chars_saved": saved,
                                   "first_ts": evs[0]["ts"], "last_ts": evs[-1]["ts"]}
        kind_txt = "、".join(f"{k}×{n}" for k, n in by_kind.items())
        out["compaction_summary"] = f"压缩事件 {len(evs)} 次（{kind_txt}），共省 {saved} 字符"
    out["error_by_tool"] = dict(err_by_tool)
    out["tools_used"] = dict(tools_used)
    out["prompt_tokens"] = ptok or None
    out["completion_tokens"] = ctok or None
    return out


def session_log_path(sid: str) -> Path:
    from harness import session
    return session.session_log_file(sid)


def collect(base: Path, task_name: str, outcome) -> dict:
    """一任务的完整摩擦报告：Outcome + 摘要文件 + 会话日志三路合。"""
    summary_file = base / f"{task_name}.summary.json"
    sid = None
    try:
        sid = json.loads(summary_file.read_text(encoding="utf-8")).get("session_id")
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        pass
    fr = parse_session_log(session_log_path(sid)) if sid else {}
    return {"task": task_name, "passed": outcome.passed, "rc": outcome.rc,
            "denied_calls": outcome.denied_calls, "failed_step": outcome.failed_step,
            "steps": [[label, ok] for label, ok in outcome.steps],
            "session_id": sid, **fr}
