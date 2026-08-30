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

import hashlib
import hmac
import json
import re
import secrets
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from . import _io, config
from .effect_outcomes import (
    EffectOutcome,
    classify_outcome,
    is_proven_read_only_tool,
    recovery_options,
)
from .model_secrets import SecretStore, SecretStoreError

EFFECTS_FILE = config.ROOT / ".state" / "effects.jsonl"
_MAX = 2000            # 超限轮转，防无界增长
_TARGET_MAX = 300
_LOCK_TIMEOUT = 5
_TASK_FENCE_TIMEOUT = 30
_SUMMARY_VERSION = 2
_IDEMPOTENCY_FINGERPRINT_FIELD = "idempotency_proof_fingerprint"
_IDEMPOTENCY_FINGERPRINT_RE = re.compile(r"^hmac-sha256:[0-9a-f]{64}$")
_IDEMPOTENCY_SALT_REF = "effect-recovery-idempotency-hmac-v1"
_IDEMPOTENCY_SECRET_FILE = "effect-recovery-secrets.bin"

# Caller/model identifiers must never become diagnostic or recovery evidence.
# The strict prefixes prevent arbitrary provider call IDs from crossing this
# durable-effect boundary.
_ACTION_ID_RE = re.compile(r"^act_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_TASK_ID_RE = re.compile(r"^tsk_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_RUN_ID_RE = re.compile(r"^run_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_EFFECT_ID_RE = re.compile(r"^eff_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_SECRET_SHAPED_ID = re.compile(
    r"(?:bearer\s+\S+|sk[-_][A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|"
    r"AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})", re.I)

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


def task_effect_fence(path=None, *, timeout: float = _TASK_FENCE_TIMEOUT):
    """Bounded task-side-effect fence shared with recovery before real tool execution."""
    return recovery_guard(path, timeout=timeout)


class EffectRecordError(RuntimeError):
    pass


def _safe_internal_id(value: object, pattern: re.Pattern[str]) -> str | None:
    if not isinstance(value, str) or _SECRET_SHAPED_ID.search(value) or not pattern.fullmatch(value):
        return None
    return value


def safe_action_id(value: object) -> str | None:
    """Return a permitted internal action id, never a provider/model value."""
    return _safe_internal_id(value, _ACTION_ID_RE)


def is_safe_effect_reference(value: object) -> bool:
    """Whether a value is a redaction-safe internal ledger reference."""
    return _safe_internal_id(value, _EFFECT_ID_RE) is not None


def is_safe_task_reference(value: object) -> bool:
    """Whether a task id is safe to use as durable effect linkage."""
    return (
        isinstance(value, str) and bool(_TASK_ID_RE.fullmatch(value))
        # ``tsk_`` contains ``sk_``; inspect only the caller-controlled suffix.
        and not _SECRET_SHAPED_ID.search(value[4:])
    )


def is_safe_run_reference(value: object) -> bool:
    """Whether a run id is safe to use as durable effect linkage."""
    return _safe_internal_id(value, _RUN_ID_RE) is not None


def _task_id(ctx) -> str | None:
    """Return only a task identifier; do not copy arbitrary context into the ledger."""
    value = ctx.get("task_id") if isinstance(ctx, dict) else None
    if not isinstance(value, str) and isinstance(ctx, dict):
        run_context = ctx.get("_run_context")
        value = getattr(run_context, "task_id", None)
    return value if is_safe_task_reference(value) else None


def _safe_text(value, limit: int = _TARGET_MAX) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def _idempotency_metadata(*, tool: object, idempotency_key: object = None,
                          requested: object = None) -> tuple[str, bool]:
    """Return a conservative class and whether runtime evidence proves it.

    Do not retain keys, and do not let a caller label a side effect as safe.
    ``tool`` is retained only to support a future ledger caller for a runtime
    allowlisted read; the task-effect entry points reject those tools anyway.
    """
    if isinstance(idempotency_key, str) and idempotency_key.strip():
        return "keyed", True
    if requested == "read" and is_proven_read_only_tool(tool):
        return "read", True
    return "non_idempotent", False


def _set_outcome(record: dict, *, started: bool, response_known: bool,
                 ok: bool | None) -> None:
    """Write the complete v3 outcome fields from explicit execution evidence."""
    outcome = classify_outcome(started=started, response_known=response_known, ok=ok)
    record["outcome_state"] = outcome.value
    record["recovery_options"] = list(recovery_options(record))
    # ``ok`` remains for old readers.  Unknown outcomes intentionally remain
    # pending rather than being coerced to a false failure.
    record["ok"] = ok if outcome is EffectOutcome.OUTCOME_UNKNOWN else (
        True if outcome is EffectOutcome.SUCCEEDED else
        False if outcome is EffectOutcome.FAILED else None
    )


def _idempotency_secret_store(path: Path) -> SecretStore:
    return SecretStore(path.parent / _IDEMPOTENCY_SECRET_FILE)


def _idempotency_salt(path: Path, *, create: bool) -> str:
    """Return a local stable HMAC salt without ever retaining a remote key."""
    secret_path = path.parent / _IDEMPOTENCY_SECRET_FILE
    lock_path = secret_path.with_name(secret_path.name + ".lock")
    with _io.file_lock(lock_path, timeout=_LOCK_TIMEOUT):
        store = _idempotency_secret_store(path)
        salt = store.get(_IDEMPOTENCY_SALT_REF)
        if salt:
            return salt
        if not create:
            return ""
        salt = secrets.token_urlsafe(48)
        store.set(_IDEMPOTENCY_SALT_REF, salt)
        return salt


def idempotency_proof_fingerprint(idempotency_key: object, path=None, *, create: bool = False) -> str | None:
    """Return a domain-separated proof fingerprint; never serialize the raw key.

    The only durable secret is a machine-local HMAC salt in ``SecretStore``.
    The effect ledger stores the resulting non-reversible fingerprint only.
    """
    if not isinstance(idempotency_key, str) or not idempotency_key.strip():
        return None
    ledger = Path(path) if path is not None else Path(EFFECTS_FILE)
    try:
        salt = _idempotency_salt(ledger, create=create)
    except (OSError, TimeoutError, SecretStoreError):
        return None
    if not salt:
        return None
    payload = b"xiaoshe/effect-recovery/idempotency-proof/v1\0" + idempotency_key.encode("utf-8")
    return "hmac-sha256:" + hmac.new(salt.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def _new_record(tool: str, args, ctx=None, ok: bool | None = True,
                 action_id: str | None = None, run_id: str | None = None, *,
                 started: bool = True, response_known: bool = True,
                 idempotency_key: object = None, idempotency_class: object = None,
                 effects_path: Path | None = None) -> dict:
    """Build a redacted ledger record without persisting it."""
    idempotency_kind, idempotency_proven = _idempotency_metadata(
        tool=tool, idempotency_key=idempotency_key, requested=idempotency_class)
    rec = {"id":f"eff_{uuid.uuid4().hex}", "summary_version":_SUMMARY_VERSION,
           "ts":datetime.now(UTC).isoformat().replace("+00:00","Z"),
           "tool": tool, "target": _safe_target(tool, args),
           "idempotency_class": idempotency_kind,
           "idempotency_proven": idempotency_proven,
           "evidence_ref": ""}
    if idempotency_kind == "keyed":
        fingerprint = idempotency_proof_fingerprint(
            idempotency_key, effects_path or Path(EFFECTS_FILE), create=True,
        )
        if fingerprint is None:
            # A hand-provided label is never replay authority.  If the local
            # proof cannot be bound durably, preserve the effect but make its
            # interrupted outcome manual-only.
            rec["idempotency_class"] = "non_idempotent"
            rec["idempotency_proven"] = False
        else:
            rec[_IDEMPOTENCY_FINGERPRINT_FIELD] = fingerprint
    irrev, why = judge_irreversible(tool, args)
    rec["irreversible"] = irrev
    if irrev:
        rec["irrev_why"] = why
    if isinstance(ctx, dict) and ctx.get("session_id"):
        rec["session"] = ctx["session_id"]
    task_id = _task_id(ctx)
    if task_id:
        rec["task_id"] = task_id
    if (safe_id := safe_action_id(action_id)) is not None:
        rec["action_id"] = safe_id
    if (safe_run_id := _safe_internal_id(run_id, _RUN_ID_RE)) is not None:
        rec["run_id"] = safe_run_id
    # This is an internal ledger identifier, never a command, request body,
    # idempotency key, or caller-controlled diagnostic string.
    rec["evidence_ref"] = rec["id"]
    _set_outcome(rec, started=started, response_known=response_known, ok=ok)
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


def _assert_action_id_unused(records: list[dict], action_id: object) -> None:
    safe_id = safe_action_id(action_id)
    if safe_id is None:
        return
    if any(record.get("action_id") == safe_id for record in records):
        raise EffectRecordError("EFFECT_ACTION_DUPLICATE")


def begin_task_effect(tool: str, args, ctx=None, path=None, *, action_id: str | None = None,
                      run_id: str | None = None, idempotency_key: object = None,
                      idempotency_class: object = None, fence_held: bool = False) -> str:
    """Durably mark a task effect pending before external execution begins."""
    if tool not in SIDE_EFFECT_TOOLS:
        raise ValueError("task effect must be side-effecting")
    p = Path(path) if path else EFFECTS_FILE
    record = _new_record(
        tool, args, ctx, ok=None, action_id=action_id, run_id=run_id,
        started=False, response_known=False, idempotency_key=idempotency_key,
        idempotency_class=idempotency_class, effects_path=p,
    )

    def persist() -> None:
        _assert_action_id_unused(load(p), action_id)
        _append_record(p, record)
    try:
        if fence_held:
            persist()
        else:
            with _io.file_lock(p, timeout=_TASK_FENCE_TIMEOUT):
                persist()
    except (OSError, TimeoutError) as exc:
        raise EffectRecordError("EFFECT_RECORD_PERSIST_FAILED") from exc
    return record["id"]


def mark_task_effect_started(effect_id: str, path=None, *, fence_held: bool = False) -> None:
    """Persist the dispatch boundary before an external request can be sent.

    A crash after this call may have reached the peer, so it is deliberately
    recorded as ``outcome_unknown`` until a trustworthy response is written.
    """
    p = Path(path) if path else EFFECTS_FILE

    def persist() -> None:
        records = load(p)
        record = next((item for item in records if item.get("id") == effect_id), None)
        if record is None:
            raise EffectRecordError("EFFECT_RECORD_MISSING")
        if record.get("outcome_state") == EffectOutcome.NOT_STARTED.value:
            _set_outcome(record, started=True, response_known=False, ok=None)
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


def complete_task_effect(effect_id: str, ok: bool | None, path=None, *, undoable=None,
                          snapshot_skip=None, fence_held: bool = False,
                          runtime_session=None, runtime_event_mirror=None) -> None:
    """Finalize a pending task effect without ever deleting its durable evidence."""
    p = Path(path) if path else EFFECTS_FILE

    completed_record = None

    def persist() -> None:
        nonlocal completed_record
        records = load(p)
        record = next((item for item in records if item.get("id") == effect_id), None)
        if record is None:
            raise EffectRecordError("EFFECT_RECORD_MISSING")
        response_known = ok is True or ok is False
        _set_outcome(record, started=True, response_known=response_known, ok=ok)
        if undoable is not None:
            record["undoable"] = bool(undoable)
        if isinstance(snapshot_skip, str) and snapshot_skip:
            record["snapshot_skip"] = snapshot_skip
        p.parent.mkdir(parents=True, exist_ok=True)
        _io.atomic_write_text(p, "\n".join(json.dumps(item, ensure_ascii=False) for item in records) + "\n")
        completed_record = dict(record)

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
    if completed_record is not None and runtime_session is not None and runtime_event_mirror is not None:
        try:
            enqueue = getattr(runtime_event_mirror, "enqueue_effect", None)
            if callable(enqueue):
                enqueue(completed_record, runtime_session)
        except Exception:
            # Runtime evidence is observational and must not alter the fenced
            # legacy effect outcome after its durable completion is committed.
            pass


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


def is_complete_not_started_task_effect(record: object, *, task_id: object,
                                        run_id: object) -> bool:
    """Verify the full v2 record shape before a lease can retry an effect.

    This deliberately validates the persisted recovery summary as well as its
    outcome fields.  It is the single source of truth shared by effects and
    lease recovery, so a hand-edited or partial JSONL line cannot acquire
    replay authority merely by saying ``not_started``.
    """
    if not isinstance(record, dict) or not is_safe_task_reference(task_id):
        return False
    if record.get("summary_version") != _SUMMARY_VERSION:
        return False
    effect_id = record.get("id")
    if not is_safe_effect_reference(effect_id) or record.get("evidence_ref") != effect_id:
        return False
    if record.get("task_id") != task_id or not is_safe_task_reference(record.get("task_id")):
        return False
    if run_id is None:
        if record.get("run_id") is not None:
            return False
    elif record.get("run_id") != run_id or not is_safe_run_reference(run_id):
        return False
    if safe_action_id(record.get("action_id")) is None:
        return False
    tool = record.get("tool")
    if not isinstance(tool, str) or tool not in SIDE_EFFECT_TOOLS:
        return False
    if _effect_time(record.get("ts"))[1] is None:
        return False
    irreversible = record.get("irreversible")
    if type(irreversible) is not bool:
        return False
    if irreversible:
        if record.get("irrev_why") not in _RECOVERY_REASONS:
            return False
    elif "irrev_why" in record:
        return False
    kind, proven = record.get("idempotency_class"), record.get("idempotency_proven")
    if type(proven) is not bool:
        return False
    if kind == "non_idempotent":
        if proven:
            return False
    elif kind == "keyed":
        if not proven:
            return False
    # A side-effecting record cannot establish a runtime read-only proof.
    else:
        return False
    return (
        record.get("outcome_state") == EffectOutcome.NOT_STARTED.value
        and record.get("ok") is None
        and record.get("recovery_options") == ["retry"]
        and recovery_options(record) == ("retry",)
    )


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
            and is_safe_effect_reference(effect_id)
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
        if not is_safe_effect_reference(effect_id):
            effect_id = f"eff_legacy_{index}"
        result.append({"id":effect_id,"action":action,"time":time_text,"target":target,
                       "reason":reason,"evidence_ref":effect_id})
    return result


def record_effect(tool: str, args, ctx=None, ok: bool = True, path=None,
                  undoable=None, snapshot_skip=None, action_id: str | None = None,
                  run_id: str | None = None, *, fence_held: bool = False,
                  require_persistence: bool = False, runtime_session=None,
                  runtime_event_mirror=None, idempotency_key: object = None,
                  idempotency_class: object = None) -> bool:
    """记一条副作用（只对 SIDE_EFFECT_TOOLS）。观测失败绝不冒泡/阻塞工具执行。

    undoable/snapshot_skip 由调用方（agent._run_tool）按 checkpoint 快照结果给：
    undoable=True=可撤；undoable=False+snapshot_skip=未快照不可撤（太大/敏感/二进制）；
    非文件工具传 None=不适用（不落 undoable 字段，别把「不适用」记成「不可撤」）。"""
    if tool not in SIDE_EFFECT_TOOLS:
        return True
    p = Path(path) if path else EFFECTS_FILE
    rec = _new_record(
        tool, args, ctx, ok=bool(ok), action_id=action_id, run_id=run_id,
        idempotency_key=idempotency_key, idempotency_class=idempotency_class,
        effects_path=p,
    )
    if undoable is not None:
        rec["undoable"] = bool(undoable)
    if isinstance(snapshot_skip, str) and snapshot_skip:
        rec["snapshot_skip"] = snapshot_skip
    persisted = True
    def persist() -> None:
        nonlocal persisted
        p.parent.mkdir(parents=True, exist_ok=True)
        eps = load(p)
        safe_id = safe_action_id(action_id)
        if safe_id is not None and any(item.get("action_id") == safe_id for item in eps):
            persisted = False
            return
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
    if persisted and runtime_session is not None and runtime_event_mirror is not None:
        try:
            enqueue = getattr(runtime_event_mirror, "enqueue_effect", None)
            if callable(enqueue):
                enqueue(rec, runtime_session)
        except Exception:
            # The event stream is observational until a later closure task;
            # it must never turn a successful legacy ledger write into failure.
            pass
    return True


def recent(limit: int = 20, session_id=None, path=None) -> list:
    """取回账本里最近 limit 条副作用（时序、末条在后）；session_id 给定则只回该会话的。供 :effects 展示。"""
    eps = load(path)
    if session_id is not None:
        eps = [e for e in eps if e.get("session") == session_id]
    return eps[-max(1, limit):]


def load(path=None) -> list:
    """逐行读副作用账本（坏行跳过不崩）。"""
    p = Path(path) if path else EFFECTS_FILE
    out = []
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(r, dict):
            out.append(r)
    return out
