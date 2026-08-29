"""UI 状态快照层（SPEC v2 §10）：UI 读 ctx 与 .state 的唯一入口。

纪律：
- import 只许数据层模块（viewport/vision/jobs/memory/skills/cheatsheet/selflearn/notes/
  subagent_store/permission/config/_io/approvals/session）+ ui_bus（只为 STATE_LOCK，ui_bus 零 harness 依赖故无环）。
- 全部公开函数持 ``ui_bus.STATE_LOCK`` + 深拷贝/白名单重建——绝不把 ctx 内部对象引用泄给 UI 侧。
- 脱敏（SPEC §10 尾部 + R3 §7 排除清单）：只按白名单字段产出——天然不导出 .env 内容、ui_token、
  config 的 key/代理串、_tainted/_taint_labels 原文、runtime 句柄键（_model_fn/_approver/_log_file/_cancel_event 等）。
- msg_id 归属：本模块**不自行编号**。msg_id 由 ui_server 持有（会话内单调 int），经 ``ids``
  参数（与 ctx history 平行的 int 列表）传入；快照尾页编号与后续 message.append 连续（SPEC D8）。
"""
from __future__ import annotations

import copy
import json
import re
from datetime import datetime
from pathlib import Path

from . import (_io, approvals, calibrate, cheatsheet, jobs, memory, notes, permission, project_memory,
               projects, selflearn, session, skills, subagent_store, ui_bus, vision, viewport, config)  # noqa: F401 (config/permission/subagent_store 备溯源表口径)

STATE_LOCK = ui_bus.STATE_LOCK

_STEP_RE = re.compile(r"^\s*(?:\d+[.、)]|[-*])", re.M)   # D16：技能正文步骤行计数

_PATCH_KEYS = ("todos", "notes", "vision_pending", "approved_tools",
               "denied_calls", "stall", "usage", "compaction", "pick_diff",
               "run_active", "tool_round")


# ---------------------------------------------------------------- 小件

def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")


def _todos(ctx: dict) -> list:
    out = []
    for t in ctx.get("todos") or []:
        if isinstance(t, dict):
            out.append({"content": str(t.get("content", "")), "status": str(t.get("status", "pending"))})
    return out


def _subagents(ctx: dict) -> list:
    out = []
    for r in ctx.get("_subagent_runs") or []:
        if not isinstance(r, dict):
            continue
        out.append({"ref_id": r.get("ref_id"), "objective": r.get("objective", ""),
                    "status": r.get("status", "running"), "summary": r.get("summary", ""),
                    "text_ref": r.get("text_ref"), "batch_id": r.get("batch_id"),
                    "started_at": r.get("started_at"), "ended_at": r.get("ended_at")})
    return out


# ---------------------------------------------------------------- §10 溯源表逐行

def vision_pending_rich(ctx: dict) -> list:
    """ctx['_vision_pending'] 逐 ref + vision.meta(sid,ref)['target'] → [{ref, target|null}]（P0-4）。"""
    with STATE_LOCK:
        sid = ctx.get("session_id")
        out = []
        for ref in list(ctx.get("_vision_pending") or []):
            target = None
            try:
                m = vision.meta(sid, ref) if sid else None
                if m:
                    target = m.get("target")
            except Exception:
                pass
            out.append({"ref": ref, "target": target})
        return out


def approved_tools_rich(ctx: dict) -> list:
    """ctx['_approved_tools'](scope=session) ∪ approvals.load()(scope=persist) → [{key, scope}]（P1-8）。"""
    with STATE_LOCK:
        sess = sorted(str(k) for k in (ctx.get("_approved_tools") or ()))
        try:
            persist = sorted(str(k) for k in approvals.load())
        except Exception:
            persist = []
        return ([{"key": k, "scope": "session"} for k in sess]
                + [{"key": k, "scope": "persist"} for k in persist])


def viewport_current(ctx: dict) -> dict:
    """注册表尾=当前；chain 沿 parent_id 上溯（根→当前）；marks int 键转 str；空态 {viewport_id:None, marks:{}}。
    Y7 读侧：tools 写侧变更注册表时并发迭代会抛 RuntimeError——捕获重试一次。"""
    for _attempt in range(2):
        try:
            with STATE_LOCK:
                return _viewport_current_locked(ctx)
        except RuntimeError:
            continue
    with STATE_LOCK:   # 重试仍撞 → 给空态，观测层绝不阻塞（红线 6）
        return {"viewport_id": None, "marks": {}}


def _viewport_current_locked(ctx: dict) -> dict:
    reg = ctx.get("_viewport_registry")
    if not reg:
        return {"viewport_id": None, "marks": {}}
    try:
        vid, vp = next(reversed(list(reg.items())))
    except (StopIteration, TypeError):
        return {"viewport_id": None, "marks": {}}
    # chain：沿 parent_id 上溯到根（用 OrderedDict.get 裸查，不刷 LRU 热度；防环兜底）
    chain, seen, cur = [], {vid}, vp
    while isinstance(cur, dict) and cur.get("parent_id"):
        pid = cur["parent_id"]
        if pid in seen:
            break
        seen.add(pid)
        chain.append(pid)
        cur = reg.get(pid)
        if cur is None:
            break
    chain.reverse()
    chain.append(vid)
    marks = {}
    for no, m in (vp.get("marks") or {}).items():
        if isinstance(m, dict):
            marks[str(no)] = dict(m)
    return {"viewport_id": vid,
            "size": list(vp.get("size") or []),
            "scale": vp.get("scale"),
            "parent_id": vp.get("parent_id"),
            "chain": chain,
            "marks": marks,
            "screenshot_ref": vp.get("screenshot_ref"),
            "updated_at": vp.get("created_at")}


def pick_diff(ctx: dict) -> dict:
    """ctx.get('_pick_diff_last')（tools 仪表化 D5 写入）或 unknown 空态。"""
    with STATE_LOCK:
        d = ctx.get("_pick_diff_last")
        if isinstance(d, dict):
            return {"ratio": d.get("ratio"), "status": d.get("status", "unknown"),
                    "pair": dict(d.get("pair") or {"before_ref": None, "after_ref": None}),
                    "target": dict(d.get("target") or {"no": None, "screen_cx": None, "screen_cy": None}),
                    "at": d.get("at")}
        return {"ratio": None, "status": "unknown",
                "pair": {"before_ref": None, "after_ref": None},
                "target": {"no": None, "screen_cx": None, "screen_cy": None},
                "at": None}


def jobs_list(tail_lines: int = 20) -> list:
    """jobs.list_jobs() 每条 + 读 log_path 末 N 行（_io.decode_cmd_output 回退链解码；D13 按行切不按字符）。
    Y4 两阶段：本函数不触 ctx 共享状态（jobs 记录由 jobs 模块自管），全程磁盘 I/O 在 STATE_LOCK 外。"""
    out = []
    try:
        recs = jobs.list_jobs()
    except Exception:
        recs = []
    for rec in recs:
        if not isinstance(rec, dict):
            continue
        item = {k: rec.get(k) for k in    # 契约仲裁 3：jobs.py:202 实写 8 键（无 cwd）
                ("id", "command", "pid", "log_path", "status", "started_at", "returncode", "ended_at")}
        item["tail"] = _log_tail(rec.get("log_path"), tail_lines)
        out.append(item)
    return out


_LOG_TAIL_WIN = 64 * 1024   # Y4：_log_tail 尾部窗口字节数（末 N KB seek 读，禁止整文件 read_bytes）


def _log_tail(log_path, n: int) -> str:
    """读日志末 n 行：seek 尾部窗口（不超 _LOG_TAIL_WIN 与 n×2KB 的较大者），大文件不整读。"""
    if not log_path:
        return ""
    try:
        p = Path(log_path)
        size = p.stat().st_size
        win = max(_LOG_TAIL_WIN, int(n or 0) * 2048)
        with p.open("rb") as f:
            if size > win:
                f.seek(size - win)   # 只读尾窗；窗首可能切开一行 → 解码后丢首行（见下）
                data = f.read()
                cut = True
            else:
                data = f.read()
                cut = False
    except (OSError, ValueError):
        return ""
    text = _io.decode_cmd_output(data)
    lines = text.splitlines()
    if cut and lines:
        lines = lines[1:]            # 窗首残行丢弃，保证返回的都是完整行
    return "\n".join(lines[-n:]) if n and len(lines) > n else "\n".join(lines) if cut else text


def memory_stats() -> dict:
    """ROOT/memory.json（D2）→ {total, by_zone(六中文分区 D3), injectable, superseded, items}。
    Y4 两阶段：输入只取不可变引用（memory.MEMORY_FILE 常量），读盘/统计全程在 STATE_LOCK 外。"""
    try:
        records = memory.load_records(memory.MEMORY_FILE)
    except Exception:
        records = []
    live = [r for r in records if memory._is_live(r)]
    by_zone = {z: 0 for z in memory._ZONES}
    for r in live:
        by_zone[r.get("zone", "其它")] = by_zone.get(r.get("zone", "其它"), 0) + 1
    items = [{"id": r.get("id"), "zone": r.get("zone", "其它"), "text": r.get("text", ""),
              "created_at": r.get("created_at", ""), "superseded_by": r.get("superseded_by")}
             for r in live]
    return {"total": len(live), "by_zone": by_zone,
            "injectable": sum(1 for r in live if memory._is_injectable(r)),
            "superseded": sum(1 for r in live if memory._is_superseded(r)),
            "items": items}


def _layer_item(r: dict) -> dict:
    """三层记忆条目契约形状（UI 批次 C）：memory_stats.items + source（untrusted 标注前端亮「外部来源」）。"""
    return {"id": r.get("id"), "zone": r.get("zone", "其它"), "text": r.get("text", ""),
            "source": r.get("source", "unknown"),
            "created_at": r.get("created_at", ""), "superseded_by": r.get("superseded_by")}


def memory_layers(memory_path, ctx: dict, projects_path, pm_path) -> dict:
    """三层记忆平铺（UI 批次 C GET /api/memory/layers）：

    - 长期 = memory.json v2 分区记录（跨会话，关于使用者）；
    - 项目 = 当前会话归属项目的共享记忆（project_memory.json；未归属如实 unassigned=True）；
    - 短期 = 本会话 notes 便签（会话结束即弃）。
    Y4 两阶段：输入只取不可变引用（路径常量/ctx），读盘全程在 STATE_LOCK 外。"""
    try:
        records = memory.load_records(memory_path)
    except Exception:
        records = []
    live = [r for r in records if memory._is_live(r)]
    sid = ctx.get("session_id") if isinstance(ctx, dict) else None
    pid = projects.project_of(sid, projects_path) if sid else None
    pname = None
    if pid:
        pr = next((p for p in projects.load(projects_path)["projects"] if p["id"] == pid), None)
        pname = pr.get("name") if pr else None
    try:
        p_items = [_layer_item(r) for r in project_memory.entries(pid, pm_path)] if pid else []
    except Exception:
        p_items = []
    return {
        "long_term": {"total": len(live),
                      "injectable": sum(1 for r in live if memory._is_injectable(r)),
                      "superseded": sum(1 for r in live if memory._is_superseded(r)),
                      "items": [_layer_item(r) for r in live]},
        "project": {"project_id": pid, "project_name": pname,
                    "unassigned": pid is None, "items": p_items},
        "short_term": {"notes": notes.current(ctx)},
    }


def skills_pending() -> dict:
    """pending(selflearn)/active(skills)/cheatsheet 三段。
    worked_count=hits、nominated=promoted（D14）；enabled 恒 true（D16 存在即启用）；
    steps_count=数正文 `^\\s*(?:\\d+[.、)]|[-*])` 行（D16）。D18：user_tools 待审体系不并入。
    Y4 两阶段：输入只取不可变引用（pending_dir/SKILLS_DIR 常量），目录扫描/读正文全程在 STATE_LOCK 外。"""
    pending = []
    try:
        base = selflearn.pending_dir()
        for m in selflearn.list_pending():
            body, created = _skill_body(base, m.get("slug"))
            pending.append({"name": m.get("name"), "description": m.get("description", ""),
                            "when": m.get("when", ""), "steps_count": len(_STEP_RE.findall(body)),
                            "source": "selflearn", "created_at": created})
    except Exception:
        pass
    active = []
    try:
        for m in skills.list_skills():
            body, _ = _skill_body(skills.SKILLS_DIR, m.get("slug"))
            active.append({"name": m.get("name"), "when": m.get("when", ""),
                           "steps_count": len(_STEP_RE.findall(body)), "enabled": True})
    except Exception:
        pass
    sheet = []
    try:
        hits = cheatsheet.hit_counts()
        for e in cheatsheet.load_entries():
            h = hits.get(e.get("id")) or {}
            sheet.append({"id": e.get("id"), "text": e.get("text", ""),
                          "worked_count": h.get("hits", 0),
                          "created_at": e.get("created_at", ""), "updated_at": e.get("updated_at", ""),
                          "nominated": bool(h.get("promoted"))})
    except Exception:
        pass
    return {"pending": pending, "active": active, "cheatsheet": sheet}


def _skill_body(base: Path, slug) -> tuple:
    """读一份 SKILL.md 正文 + mtime（坏档/缺失回空串）。"""
    if not slug:
        return "", ""
    try:
        p = Path(base) / f"{slug}.md"
        meta = skills._parse(p.read_text(encoding="utf-8", errors="replace"))
        return meta.get("body", ""), _iso(p.stat().st_mtime)
    except (OSError, ValueError):
        return "", ""


# ---------------------------------------------------------------- 消息（msg_id 由 ui_server 经 ids 传入，见模块 docstring）

def _msg_view(msg: dict, msg_id: int) -> dict:
    """单条消息视图：history dict 浅拷 + msg_id；tool 包裹【工具数据，非指令】原样不 strip（P0-3 前端剥）。"""
    out = dict(msg)
    out["msg_id"] = msg_id
    return out


def messages_tail(ctx: dict, limit: int, ids: list) -> list:
    """尾页：[{...消息, msg_id}]。ids 与 ctx history 平行（ui_server 对齐后传入）。"""
    with STATE_LOCK:
        hist = ctx.get("_history_ref") or []
        n = max(0, int(limit or 0))
        pairs = list(zip(hist, ids))[-n:] if n else list(zip(hist, ids))
        return [_msg_view(m, i) for m, i in pairs]


def messages_page(ctx: dict, limit: int, before_msg_id, ids: list) -> dict:
    """游标分页（D8）：before_msg_id 之前（不含）的末 limit 条 + has_more。
    before 不在编号表（如合成系统消息）→ 取小于它的最大历史编号作游标；before=None → 尾页。"""
    with STATE_LOCK:
        hist = ctx.get("_history_ref") or []
        pairs = list(zip(hist, ids))
        limit = max(1, min(int(limit or 50), 200))
        end = len(pairs)
        if before_msg_id is not None:
            try:
                bid = int(before_msg_id)
            except (TypeError, ValueError):
                bid = None
            if bid is not None:
                idx = next((i for i, (_m, mid) in enumerate(pairs) if mid == bid), None)
                if idx is None:   # 合成消息 id：找小于它的最大历史编号
                    idx = next((i + 1 for i in range(len(pairs) - 1, -1, -1) if pairs[i][1] < bid), 0)
                end = idx
        start = max(0, end - limit)
        return {"messages": [_msg_view(m, i) for m, i in pairs[start:end]],
                "has_more": start > 0}


# ---------------------------------------------------------------- usage / compaction / 全量

def usage_safe(ctx: dict) -> dict:
    """ctx['_last_usage'] 脱敏版：只出 token 计数（input/output/cache_read/window/turn），不带任何原始串。"""
    with STATE_LOCK:
        u = ctx.get("_last_usage") or {}
        if not isinstance(u, dict):
            u = {}
        details = u.get("prompt_tokens_details")
        cached = details.get("cached_tokens") if isinstance(details, dict) else 0
        explicit_window = ctx.get("_context_window")
        budget_window = getattr(ctx.get("_context_budget"), "window_tokens", None)
        window = (explicit_window if type(explicit_window) is int and explicit_window > 0
                  else budget_window if type(budget_window) is int and budget_window > 0
                  else calibrate.effective_window(ctx))
        return {"input_tokens": u.get("prompt_tokens") or 0,
                "output_tokens": u.get("completion_tokens") or 0,
                "cache_read": cached or 0,
                # 供应商并不保证在 usage 中回传窗口；缺失时与真实
                # 压缩预算共用自校准值，但不覆盖测试/运行时显式会话值。
                "window": window,
                "turn": ctx.get("_turn", 0)}


def compaction_recent(ctx: dict) -> dict | None:
    """会话 JSONL 尾 20 行筛最近一条 role=system event=compaction → 契约形状（D7 桥接层映射）。"""
    with STATE_LOCK:
        sid = ctx.get("session_id")
        if not sid:
            return None
        try:
            data = session.session_log_file(sid).read_bytes()[-65536:]
        except (OSError, ValueError):
            return None
        hit = None
        for line in _io.decode_cmd_output(data).splitlines()[-20:]:
            try:
                rec = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if rec.get("role") == "system" and rec.get("event") == "compaction":
                hit = rec
        if not hit:
            return None
        return {"kind": hit.get("kind"), "at": hit.get("ts"),
                "before": {"msgs": hit.get("before_msgs"), "chars": hit.get("before_chars")},
                "after": {"msgs": hit.get("after_msgs"), "chars": hit.get("after_chars")},
                "cleared": hit.get("cleared"), "depth": hit.get("depth", 0)}


def snapshot_full(ctx: dict) -> dict:
    """§10 全量 state：todos/notes/jobs/subagents/vision_pending/approved_tools/denied_calls/
    stall/usage/compaction_recent（白名单重建，脱敏见模块 docstring）。
    Y4 两阶段：锁内只取 ctx 共享状态（jobs 磁盘 I/O 移出锁外组装，键序不变）。"""
    with STATE_LOCK:
        snap = {"todos": _todos(ctx),
                "notes": notes.current(ctx),
                "jobs": None,                       # 占位保键序——锁外第二阶段填
                "subagents": _subagents(ctx),
                "vision_pending": vision_pending_rich(ctx),
                "approved_tools": approved_tools_rich(ctx),
                "denied_calls": ctx.get("_denied_calls", 0),
                "stall": copy.deepcopy(ctx.get("_stall")),
                "usage": usage_safe(ctx),
                "compaction_recent": compaction_recent(ctx),
                "run_active": bool(ctx.get("_run_active")),
                "tool_round": copy.deepcopy(ctx.get("_tool_round") or
                                             {"used": 0, "limit": 60, "remaining": 60,
                                              "status": "idle"}),
                # UI 批次 D：会话级自主模式 + 会话级模型（都在 ctx、不落盘，脱敏白名单内）
                "autonomy": bool(ctx.get("_autonomy")),
                "model": str(ctx.get("_model") or config.MODEL),
                "model_id": str(ctx.get("_model_profile_id") or ""),
                "provider": str(ctx.get("_model_provider") or "")}
    snap["jobs"] = jobs_list()                      # Y4：磁盘 I/O 不持 STATE_LOCK
    return snap


# ---------------------------------------------------------------- dirty 汇聚（ui_bus.init 的 snapshot_fn）

def collect_dirty(ctx: dict, keys) -> list:
    """ui_bus 的 snapshot_fn：按 dirty 键产出 (channel, payload) 列表。
    viewport→viewport.update；jobs→job.update；subagents→subagent.update；
    其余（含 pick_diff）并入一条 state.patch（SPEC §3.2 / 任务 A）。
    Y4 两阶段：jobs 磁盘 I/O 移出锁外（job.update 末尾补挂，通道序无语义约束）。"""
    want_jobs = False
    with STATE_LOCK:
        out = []
        patch = {}
        for k in keys or []:
            try:
                if k == "viewport":
                    out.append(("viewport.update", viewport_current(ctx)))
                elif k == "jobs":
                    want_jobs = True               # 锁外第二阶段组装
                elif k == "subagents":
                    out.append(("subagent.update", {"subagents": _subagents(ctx)}))
                elif k == "todos":
                    patch["todos"] = _todos(ctx)
                elif k == "notes":
                    patch["notes"] = notes.current(ctx)
                elif k == "vision_pending":
                    patch["vision_pending"] = vision_pending_rich(ctx)
                elif k == "approved_tools":
                    patch["approved_tools"] = approved_tools_rich(ctx)
                elif k == "denied_calls":
                    patch["denied_calls"] = ctx.get("_denied_calls", 0)
                elif k == "stall":
                    patch["stall"] = copy.deepcopy(ctx.get("_stall"))
                elif k == "usage":
                    patch["usage"] = usage_safe(ctx)
                elif k == "compaction":
                    patch["compaction_recent"] = compaction_recent(ctx)
                elif k == "pick_diff":
                    patch["pick_diff"] = pick_diff(ctx)
                elif k == "run_active":
                    patch["run_active"] = bool(ctx.get("_run_active"))
                elif k == "tool_round":
                    patch["tool_round"] = copy.deepcopy(ctx.get("_tool_round") or
                                                         {"used": 0, "limit": 60,
                                                          "remaining": 60, "status": "idle"})
                elif k == "autonomy":            # UI 批次 D：自主模式开关翻转
                    patch["autonomy"] = bool(ctx.get("_autonomy"))
                elif k == "model":               # UI 批次 D：会话级模型切换
                    patch["model"] = str(ctx.get("_model") or config.MODEL)
                    patch["model_id"] = str(ctx.get("_model_profile_id") or "")
                    patch["provider"] = str(ctx.get("_model_provider") or "")
            except Exception:
                pass    # 观测层绝不阻塞（红线 6）
        if patch:
            out.insert(0, ("state.patch", patch))
    if want_jobs:
        out.append(("job.update", {"jobs": jobs_list()}))   # Y4：磁盘 I/O 不持 STATE_LOCK
    return out
