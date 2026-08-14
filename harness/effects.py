"""乙9 · effects.jsonl 副作用账本：把 agent 每次**真执行**的有副作用动作（写文件/改文件/跑命令/存技能/原生UI）
记一行到 `.state/effects.jsonl`——事后可查「这一轮/这个会话到底动了什么」，是注入/越权事后排查的账本。

只**记**不拦（纯观测层，绝不阻塞工具执行）；挂在唯一派发入口 agent._run_tool，主循环与 PTC 脚本的副作用都覆盖。
只记内置副作用工具的 tool + 目标(路径/命令/名)——都已过 permission 闸（非敏感、在 ROOT 内）；不记 mcp 外部工具参数（避免日志泄漏）。
`.state/` 已 gitignore，不进 git、不泄漏。

§6.1 可逆性三态（口径）：
- **可撤**：文件写且快照已入 undo 栈（`undoable: true`）；
- **未快照不可撤**：文件写但快照被选择性跳过（`undoable: false` + `snapshot_skip` 原因，见 checkpoint §6.2）——本质可逆、这次没兜住，如实交代；
- **本质不可逆**：`irreversible: true`（+`irrev_why`）——命令副作用/删除·破坏命令/外部请求/原生UI，undo 只覆盖文件、够不到这些。
判定在纯函数 judge_irreversible（可单测）；旧格式条目没有这些字段=「未知」，视图不得装知道。
"""
from __future__ import annotations

import json
import re
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from . import _io, config

EFFECTS_FILE = config.STATE_DIR / "effects.jsonl"
_MAX = 2000            # 超限轮转，防无界增长
_TARGET_MAX = 300
_LOCK_TIMEOUT = 5
_TASK_FENCE_TIMEOUT = 30
_SUMMARY_VERSION = 2

# 有副作用（动了外部状态）的内置工具——只记这些；只读工具(read_file/glob/grep/observe…)不记。
SIDE_EFFECT_TOOLS = {
    "write_file", "edit", "run_command", "run_in_background", "save_skill",
    "click", "click_at", "pick", "press_keys", "type_text", "focus_window",
    "screenshot",   # 读屏+写盘：落了哪个 PNG 记账（工具会把实际路径写回 args.path，自动命名的也能记）
}

# §6.1 不可逆判定用的工具分组
_CMD_TOOLS = {"run_command", "run_in_background"}
_UI_TOOLS = {"click", "click_at", "pick", "press_keys", "type_text", "focus_window"}
_FILEY_TOOLS = {"write_file", "edit", "screenshot", "save_skill"}   # 副作用落在文件上，本质可逆
_RECOVERY_REASONS = {"原生UI动作不可逆", "删除/破坏命令不可逆", "外部请求不可逆", "命令副作用不可逆"}

# 删除/破坏命令形态（命中即「删除/破坏命令不可逆」）——宁严勿宽：漏标=装能撤，比多标危险。
_DESTRUCTIVE_CMD = re.compile(
    r"\brm\s+[^\n|;&]*-[a-z]*[rf]"        # rm -rf / rm -r / rm -f
    r"|\bdel\b[^\n|;&]*/[fsq]"            # del /f /s /q（任意组合）
    r"|\brmdir\b[^\n|;&]*/s"              # rmdir /s
    r"|remove-item[^\n|;&]*-r"            # Remove-Item -Recurse
    r"|\bgit\s+reset\s+--hard"
    r"|\bgit\s+clean\s+-[a-z]*[fd]"       # git clean -f/-d/-fd
    r"|\bformat\b\s+[a-z]:"
    r"|\bmkfs\b|\bdd\s+if=", re.I)
# 发外部请求（ACRFence：restore 后重放=第二次执行，本质不可逆）
_NETWORK_CMD = re.compile(
    r"\b(?:curl|wget|nc|ssh|scp|sftp)\b"
    r"|\binvoke-(?:webrequest|restmethod)\b|\b(?:iwr|irm)\b"
    r"|\bgit\s+(?:push|pull|fetch|clone)\b"
    r"|\bnpm\s+publish\b", re.I)

# snapshot_skip 机器键 → 中文（:effects/:undo 视图共用，口径一致）
SKIP_REASON_CN = {"too_big": "太大", "sensitive": "敏感", "binary": "二进制"}


def judge_irreversible(tool: str, args) -> tuple[bool, str]:
    """纯判定：这次副作用是否**本质不可逆**（undo 只覆盖文件，够不到的就是不可逆）。

    返 (是否不可逆, 原因)。文件类副作用（写/改/截图/存技能）标可逆；命令类默认不可逆
    （undo 从未覆盖命令副作用，标不可逆不是功能退化是如实），删除/破坏形态与外部请求单列原因；
    原生UI动作作用在屏幕/系统上，不可逆。"""
    if tool in _FILEY_TOOLS:
        return (False, "")
    if tool in _UI_TOOLS:
        return (True, "原生UI动作不可逆")
    if tool in _CMD_TOOLS:
        cmd = args.get("command") if isinstance(args, dict) else ""
        cmd = cmd if isinstance(cmd, str) else ""
        if _DESTRUCTIVE_CMD.search(cmd):
            return (True, "删除/破坏命令不可逆")
        if _NETWORK_CMD.search(cmd):
            return (True, "外部请求不可逆")
        return (True, "命令副作用不可逆")
    return (False, "")


def _target(tool: str, args) -> str:
    """从参数里取一个可读的「动了谁」摘要（路径/命令/名字/按键/文本/坐标）。"""
    if not isinstance(args, dict):
        return ""
    for k in ("path", "command", "name", "keys", "text"):
        v = args.get(k)
        if isinstance(v, str) and v:
            return " ".join(v.split())[:_TARGET_MAX]
    if tool == "pick":   # pick 按视口编号点：记「点了哪个视口的几号」（坐标在工具内解析，账本记引用）
        vid = args.get("viewport_id")
        if isinstance(vid, str) and vid:
            return f"{vid}#{args.get('mark_no')}"
        return ""
    x, y = args.get("x"), args.get("y")   # click_at 类坐标动作：记「点了哪」
    if isinstance(x, (int, float)) and isinstance(y, (int, float)) and not isinstance(x, bool) and not isinstance(y, bool):
        return f"({int(x)},{int(y)})"
    return ""


def _safe_target(tool: str, args) -> str:
    """Return an effect-ledger summary, never command or native-input contents."""
    if tool in _CMD_TOOLS:
        return "command"
    if tool in _UI_TOOLS:
        return "native_ui"
    return _target(tool, args)


@contextmanager
def recovery_guard(path=None, *, timeout: float = _LOCK_TIMEOUT):
    """Serialize the final recovery fence with effect recording on one ledger lock."""
    p = Path(path) if path else EFFECTS_FILE
    with _io.file_lock(p, timeout=timeout):
        yield


def task_effect_fence(path=None):
    """Bounded task-side-effect fence shared with recovery before real tool execution."""
    return recovery_guard(path, timeout=_TASK_FENCE_TIMEOUT)


class EffectRecordError(RuntimeError):
    pass


def _task_id(ctx) -> str | None:
    """Return only a task identifier; do not copy arbitrary context into the ledger."""
    value = ctx.get("task_id") if isinstance(ctx, dict) else None
    if not isinstance(value, str) and isinstance(ctx, dict):
        run_context = ctx.get("_run_context")
        value = getattr(run_context, "task_id", None)
    return value if isinstance(value, str) and re.fullmatch(r"tsk_[A-Za-z0-9_-]+", value) else None


def _safe_text(value, limit: int = _TARGET_MAX) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def _new_record(tool: str, args, ctx=None, ok: bool | None = True,
                action_id: str | None = None, run_id: str | None = None) -> dict:
    """Build a redacted ledger record without persisting it."""
    rec = {"id":f"eff_{uuid.uuid4().hex}", "summary_version":_SUMMARY_VERSION,
           "ts":datetime.now(UTC).isoformat().replace("+00:00","Z"),
           "tool": tool, "target": _safe_target(tool, args), "ok": ok}
    irrev, why = judge_irreversible(tool, args)
    rec["irreversible"] = irrev
    if irrev:
        rec["irrev_why"] = why
    if isinstance(ctx, dict) and ctx.get("session_id"):
        rec["session"] = ctx["session_id"]
    task_id = _task_id(ctx)
    if task_id:
        rec["task_id"] = task_id
    if isinstance(action_id, str) and action_id:
        rec["action_id"] = action_id
    if isinstance(run_id, str) and run_id:
        rec["run_id"] = run_id
    return rec


def _append_record(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    records = load(path)
    if len(records) >= _MAX:
        records = records[-(_MAX - 1):] + [record]
        _io.atomic_write_text(path, "\n".join(json.dumps(item, ensure_ascii=False) for item in records) + "\n")
        return
    with open(path, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False) + "\n")


def begin_task_effect(tool: str, args, ctx=None, path=None, *, action_id: str | None = None,
                      run_id: str | None = None, fence_held: bool = False) -> str:
    """Durably mark a task effect pending before external execution begins."""
    if tool not in SIDE_EFFECT_TOOLS:
        raise ValueError("task effect must be side-effecting")
    p = Path(path) if path else EFFECTS_FILE
    record = _new_record(tool, args, ctx, ok=None, action_id=action_id, run_id=run_id)
    try:
        if fence_held:
            _append_record(p, record)
        else:
            with _io.file_lock(p, timeout=_TASK_FENCE_TIMEOUT):
                _append_record(p, record)
    except (OSError, TimeoutError) as exc:
        raise EffectRecordError("EFFECT_RECORD_PERSIST_FAILED") from exc
    return record["id"]


def complete_task_effect(effect_id: str, ok: bool, path=None, *, undoable=None,
                         snapshot_skip=None, fence_held: bool = False) -> None:
    """Finalize a pending task effect without ever deleting its durable evidence."""
    p = Path(path) if path else EFFECTS_FILE

    def persist() -> None:
        records = load(p)
        record = next((item for item in records if item.get("id") == effect_id), None)
        if record is None:
            raise EffectRecordError("EFFECT_RECORD_MISSING")
        record["ok"] = bool(ok)
        if undoable is not None:
            record["undoable"] = bool(undoable)
        if isinstance(snapshot_skip, str) and snapshot_skip:
            record["snapshot_skip"] = snapshot_skip
        p.parent.mkdir(parents=True, exist_ok=True)
        _io.atomic_write_text(p, "\n".join(json.dumps(item, ensure_ascii=False) for item in records) + "\n")

    try:
        if fence_held:
            persist()
        else:
            with _io.file_lock(p, timeout=_TASK_FENCE_TIMEOUT):
                persist()
    except EffectRecordError:
        raise
    except (OSError, TimeoutError) as exc:
        raise EffectRecordError("EFFECT_RECORD_PERSIST_FAILED") from exc


def _effect_time(value) -> tuple[str, datetime | None]:
    """Normalize trusted new timestamps and make malformed legacy ones reviewable."""
    if not isinstance(value, str):
        return "unknown", None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return "unknown", None
    if parsed.tzinfo is None:
        return "unknown", None
    return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z"), parsed.astimezone(UTC)


def recovery_effects(task_id: str, after: str, path=None) -> list[dict]:
    """Safe summaries of task-bound effects after a checkpoint, never treating old data as safe."""
    try:
        boundary = datetime.fromisoformat(after.replace("Z", "+00:00")).astimezone(UTC)
    except (AttributeError, ValueError):
        boundary = None
    result=[]
    for index, record in enumerate(load(path)):
        if record.get("task_id") != task_id or record.get("ok") is False:
            continue
        time_text, occurred = _effect_time(record.get("ts"))
        # A timestamp we cannot prove predates the checkpoint is shown for review.
        if boundary is not None and occurred is not None and occurred <= boundary:
            continue
        irreversible = record.get("irreversible")
        effect_id = record.get("id")
        tool = record.get("tool")
        trusted = (
            record.get("summary_version") == _SUMMARY_VERSION
            and isinstance(effect_id, str) and re.fullmatch(r"eff_[A-Za-z0-9_-]+", effect_id)
            and time_text != "unknown"
            and tool in SIDE_EFFECT_TOOLS
            and record.get("ok") is True
            and isinstance(irreversible, bool)
        )
        if trusted and irreversible is False:
            continue
        if trusted and irreversible is True and tool in _CMD_TOOLS | _UI_TOOLS and record.get("irrev_why") in _RECOVERY_REASONS and record.get("target") == _safe_target(tool, {}):
            action = "command" if tool in _CMD_TOOLS else "native_ui"
            target = _safe_target(tool, {})
            reason = record["irrev_why"]
        else:
            action, target, reason = "unknown", "unknown", "needs_review"
        if not isinstance(effect_id, str) or not re.fullmatch(r"eff_[A-Za-z0-9_-]+", effect_id):
            effect_id = f"eff_legacy_{index}"
        action_id = record.get("action_id")
        evidence_ref = action_id if isinstance(action_id, str) and re.fullmatch(r"act_[A-Za-z0-9_-]+", action_id) else effect_id
        result.append({"id":effect_id,"action":action,"time":time_text,"target":target,
                       "reason":reason,"evidence_ref":evidence_ref})
    return result


def record_effect(tool: str, args, ctx=None, ok: bool = True, path=None,
                  undoable=None, snapshot_skip=None, action_id: str | None = None,
                  run_id: str | None = None, *, fence_held: bool = False,
                  require_persistence: bool = False) -> bool:
    """记一条副作用（只对 SIDE_EFFECT_TOOLS）。观测失败绝不冒泡/阻塞工具执行。

    undoable/snapshot_skip 由调用方（agent._run_tool）按 checkpoint 快照结果给：
    undoable=True=可撤；undoable=False+snapshot_skip=未快照不可撤（太大/敏感/二进制）；
    非文件工具传 None=不适用（不落 undoable 字段，别把「不适用」记成「不可撤」）。"""
    if tool not in SIDE_EFFECT_TOOLS:
        return True
    p = Path(path) if path else EFFECTS_FILE
    rec = {"id":f"eff_{uuid.uuid4().hex}", "summary_version":_SUMMARY_VERSION,
           "ts":datetime.now(UTC).isoformat().replace("+00:00","Z"),
           "tool": tool, "target": _safe_target(tool, args), "ok": bool(ok)}
    irrev, why = judge_irreversible(tool, args)   # §6.1：本质不可逆打标
    rec["irreversible"] = irrev
    if irrev:
        rec["irrev_why"] = why
    if undoable is not None:
        rec["undoable"] = bool(undoable)
    if isinstance(snapshot_skip, str) and snapshot_skip:
        rec["snapshot_skip"] = snapshot_skip
    if isinstance(ctx, dict) and ctx.get("session_id"):
        rec["session"] = ctx["session_id"]
    task_id = _task_id(ctx)
    if task_id:
        rec["task_id"] = task_id
    if isinstance(action_id, str) and action_id:
        rec["action_id"] = action_id
    if isinstance(run_id, str) and run_id:
        rec["run_id"] = run_id
    def persist() -> None:
        p.parent.mkdir(parents=True, exist_ok=True)
        eps = load(p)
        if len(eps) >= _MAX:   # 超限轮转（保留末 _MAX-1 + 新的）
            eps = eps[-(_MAX - 1):] + [rec]
            _io.atomic_write_text(p, "\n".join(json.dumps(e, ensure_ascii=False) for e in eps) + "\n")
        else:
            with open(p, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    try:
        if fence_held:
            persist()
        else:
            with _io.file_lock(p, timeout=_LOCK_TIMEOUT):
                persist()
    except (OSError, TimeoutError) as exc:
        if require_persistence:
            raise EffectRecordError("EFFECT_RECORD_PERSIST_FAILED") from exc
        return False
    return True


def recent(limit: int = 20, session_id=None, path=None) -> list:
    """取回账本里最近 limit 条副作用（时序、末条在后）；session_id 给定则只回该会话的。供 :effects 展示。"""
    eps = load(path)
    if session_id is not None:
        eps = [e for e in eps if e.get("session") == session_id]
    return eps[-max(1, limit):]


def load(path=None) -> list:
    """逐行读副作用账本（坏行跳过不崩）。"""
    return load_with_integrity(path)["records"]


def load_with_integrity(path=None) -> dict:
    """Recover readable JSONL prefix and expose corruption instead of hiding it.

    JSONL has no atomic whole-file boundary: a process can die after appending
    half of the final record.  Consumers that only need history may use
    :func:`load`; recovery and release gates must use this projection and see
    whether a malformed tail or an earlier malformed line was encountered.
    """
    p = Path(path) if path else EFFECTS_FILE
    out = []
    malformed_lines: list[int] = []
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {"records": out, "integrity": {"valid": True, "malformed_lines": [], "tail_corrupt": False}}
    lines = text.splitlines()
    for line_number, line in enumerate(lines, start=1):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            malformed_lines.append(line_number)
            continue
        if isinstance(r, dict):
            out.append(r)
        else:
            malformed_lines.append(line_number)
    return {
        "records": out,
        "integrity": {
            "valid": not malformed_lines,
            "malformed_lines": malformed_lines,
            "tail_corrupt": bool(malformed_lines and malformed_lines[-1] == len(lines)),
        },
    }
