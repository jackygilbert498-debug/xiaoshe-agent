"""会话存档 / 恢复（阶段3·错误恢复）：把对话历史 + 待办落盘，崩了/重开能接着干。

存档点 = 每完整跑完一轮用户输入后的干净状态（run_once 出错会回滚，且 repl 只在干净收尾时存档）。
原子写（见 _io.atomic_write_json：.tmp + flush + fsync + os.replace）：防交错读，也尽量抗掉电。
注意：存的是 compaction 之后的 history（早期轮次可能已被压成摘要）；要看原始逐条对话请查 `.state/logs/<会话id>.jsonl`（repl 会话；直接调 run_once 不传 log_file 时仍落 logs/agent.jsonl）。
"""
from __future__ import annotations

import itertools
import json
import os
import re
from datetime import datetime
from pathlib import Path

from . import _io, config, vision

_TS_RE = re.compile(r"(\d{8}-\d{6})")  # 从档名里抠首个「时间戳」段（容忍 headless-/sched-/legacy- 前缀与 -pid 后缀）
_sid_counter = itertools.count(1)      # 进程内单调发号（#35）：同秒同进程两次调用落盘前也不撞

SESSION_FILE = config.ROOT / ".session" / "last.json"

# —— M1 多会话档案：一会话一文件，存 .state/sessions/，本机私有不进 git —— #
SESSIONS_DIR = config.ROOT / ".state" / "sessions"
LOGS_DIR = config.ROOT / ".state" / "logs"
LEGACY_FILE = SESSION_FILE  # v1 单档案（迁移后改名 .migrated，不再读）
_MAX_SESSIONS = 50  # 交互档案上限：超过静默清最旧（原始逐条日志仍在 .state/logs/ 里，不算丢数据）
_MAX_BG_SESSIONS = 100  # 无头/调度档案单独一池（M3 分池：定时任务再多也挤不掉交互会话）
_BG_PREFIXES = ("headless-", "sched-")  # 非交互会话的 id 前缀
_PREVIEW_CHARS = 24


def save(history: list, todos: list, path: Path | str | None = None) -> None:
    _io.atomic_write_json(path or SESSION_FILE, {"history": history, "todos": todos})


def load(path: Path | str | None = None) -> dict | None:
    p = Path(path) if path else SESSION_FILE
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):  # 坏 JSON / 读失败 / 非 UTF-8 一律判不可读
        return None
    if (isinstance(data, dict) and isinstance(data.get("history"), list)
            and all(isinstance(m, dict) for m in data["history"])):  # 元素必须是消息对象，否则预览/恢复会崩
        if not isinstance(data.get("todos"), list):  # 缺失或坏类型（字符串/字典等）一律归空，别让坏 todos 穿透
            data["todos"] = []
        return data
    return None


def _mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except OSError:
        return 0.0  # 并发场景档案可能刚被别的进程清掉——按最旧处理，别崩


def _stem_ts(p: Path) -> float:
    """从档名时间戳段解析出时序（#10）；抠不到就回落 0.0（由 _mtime 兜）。"""
    m = _TS_RE.search(p.stem)
    if not m:
        return 0.0
    try:
        return datetime.strptime(m.group(1), "%Y%m%d-%H%M%S").timestamp()
    except ValueError:
        return 0.0


def _sort_key(p: Path):
    """复合排序键：档名时序 > mtime > 档名——全序、消除同秒/时钟回拨下的撞车不稳定。"""
    return (_stem_ts(p), _mtime(p), p.stem)


def new_session_id(prefix: str = "") -> str:
    """生成可读、可排序、跨进程不重复的会话 id：[前缀]时间戳-进程号-进程内序号；再撞则加 -2/-3 后缀；prefix 勿含路径分隔符。"""
    base = prefix + datetime.now().strftime("%Y%m%d-%H%M%S") + f"-{os.getpid()}-{next(_sid_counter)}"
    sid, n = base, 1
    while (SESSIONS_DIR / f"{sid}.json").exists():
        n += 1
        sid = f"{base}-{n}"
    return sid


def save_session(session_id: str, history: list, todos: list, notes: list | None = None,
                 task_id: str | None = None, run_id: str | None = None, *,
                 tasking_project_id: str | None = None) -> None:
    """按 id 存会话档案（原子写），随手清掉超上限的最旧档案。notes=工作笔记（跨 resume 存活；None/空则省略字段）。"""
    rec = {"id": session_id,
           "saved_at": datetime.now().astimezone().isoformat(timespec="seconds"),
           "history": history, "todos": todos}
    if notes:
        rec["notes"] = notes
    if task_id is not None:
        rec["task_id"] = task_id
    if run_id is not None:
        rec["run_id"] = run_id
    if tasking_project_id is not None:
        rec["tasking_project_id"] = tasking_project_id
    _io.atomic_write_json(SESSIONS_DIR / f"{session_id}.json", rec)
    files = sorted(SESSIONS_DIR.glob("*.json"), key=_sort_key, reverse=True)
    # 分池清理（M3）：交互与无头/调度各清各的，定时任务刷屏也挤不掉交互会话
    fg = [f for f in files if not f.stem.startswith(_BG_PREFIXES)]
    bg = [f for f in files if f.stem.startswith(_BG_PREFIXES)]
    # 注：恢复中尚未存档的旧会话可能被清；下轮存档会整份重建，逐条日志仍在 logs/，不算丢数据
    for old in fg[_MAX_SESSIONS:] + bg[_MAX_BG_SESSIONS:]:
        if old.stem == session_id:  # #10 当前正在写的这一档永不自删（撞车/时钟回拨保险）——不占额度、只在它真落进删除区时才护
            continue
        try:
            old.unlink()
        except OSError:
            pass
        vision.purge_session(old.stem)  # P3：视觉 blob 目录随会话档案一起清，别留孤儿
    _fts_upsert(session_id)             # 统一检索索引顺带 upsert 这一档（best-effort，失败不拖垮存档）


def _fts_upsert(session_id: str) -> None:
    """写路径顺带同步统一检索索引（best-effort）：索引是衍生数据，失败只告警，绝不拖垮会话存档。"""
    try:
        from . import fts   # 惰性：fts 读侧回导本模块，防循环
        fts.upsert_session(session_id)
    except Exception:
        _io.warn("[!] 检索索引同步没成（不影响本次会话存档）——下次启动会自动校验重建。")


def search_sessions(query: str, limit: int = 8) -> dict:
    """会话存档搜索入口（统一检索消费点）：FTS5 命中；索引不可用自动降级逐字扫描，结果带 degraded 标记。

    返回 {"results": [{"kind","ref","text"}], "degraded", "engine"}；ref=会话 id，text=首条 user 消息摘要。
    结果文本经 memory.oneline 中和折行——检索结果按不可信内容处理（照 episodic 防线），别原文喂模型。"""
    from . import fts, memory   # 惰性：fts 读侧回导本模块，防循环
    r = fts.search(query, kinds=["session"], limit=limit)
    for hit in r["results"]:
        hit["text"] = memory.oneline(hit.get("text", ""))
    return r


def load_session(session_id: str) -> dict | None:
    data = load(SESSIONS_DIR / f"{session_id}.json")  # 复用旧 load 的校验（history 必须是 list）
    if data is not None:
        # 旧档案没有关联字段时只在读取视图中补 None，绝不反写或触碰原文件。
        data.setdefault("task_id", None)
        data.setdefault("run_id", None)
        data.setdefault("tasking_project_id", None)
    return data


def list_sessions(limit: int = 5) -> list[dict]:
    """最近的交互会话在前：[{"id","n_messages","preview"}]。坏档案跳过不报错。

    无头/调度档案（headless-/sched- 前缀）不进恢复列表（M3 分池）——它们是任务留痕，
    不是「接着聊」的对象；要查它们看 .state/logs/ 或 schedule history。
    """
    if not SESSIONS_DIR.exists():
        return []
    out = []
    files = sorted(SESSIONS_DIR.glob("*.json"), key=_sort_key, reverse=True)
    for f in files:
        if f.stem.startswith(_BG_PREFIXES):
            continue
        data = load(f)
        if not data:
            continue
        preview = "（空会话）"
        for msg in data["history"]:
            if msg.get("role") == "user":
                # 压空白成单行再截断（换行会撕乱列表显示）；压完是空串则保留占位语义
                preview = " ".join(str(msg.get("content", "")).split())[:_PREVIEW_CHARS] or "（空会话）"
                break
        out.append({"id": f.stem, "n_messages": len(data["history"]), "preview": preview})
        if len(out) >= limit:
            break
    return out


def pick_session(sessions: list[dict], answer: str) -> str | None:
    """把用户在恢复列表的输入变成会话 id：回车/非法输入=None（开新会话），合法编号=对应 id。"""
    answer = (answer or "").strip()
    if answer.isdecimal() and 1 <= int(answer) <= len(sessions):  # isdecimal：全角「１」可用，「②」「²」int 不认、直接排除
        return sessions[int(answer) - 1]["id"]
    return None


def session_log_file(session_id: str) -> Path:
    """该会话的日志文件路径（.state/logs/<id>.jsonl，一会话一份）。"""
    return LOGS_DIR / f"{session_id}.jsonl"


def migrate_legacy() -> bool:
    """把 v1 的单会话档案 .session/last.json 迁进会话列表（只发生一次，原文件改名 .migrated）。"""
    data = load(LEGACY_FILE)
    if not data:
        return False
    try:
        sid = "legacy-" + datetime.fromtimestamp(LEGACY_FILE.stat().st_mtime).strftime("%Y%m%d-%H%M%S")
    except OSError:
        return False  # 并发迁移：另一进程已抢先改名，当无事发生
    try:
        save_session(sid, data["history"], data.get("todos", []))
    except OSError as e:
        # 双开同刻首启会抢同一迁移临时文件（Windows 共享冲突）——启动不许崩，旧档不动、下次再试
        _io.warn(f"[!] 旧会话迁移这次没成（{e}），不影响启动；旧档案还在，下次启动会再试。")
        return False
    try:
        LEGACY_FILE.replace(LEGACY_FILE.with_name(LEGACY_FILE.name + ".migrated"))
    except OSError:
        pass
    _io.warn(f"[i] 已把上个版本的会话存档迁入会话列表（{sid}）。")
    return True
