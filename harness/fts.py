"""FTS5 统一检索层：记忆条目 / 战术小抄 / episodic 复盘 / 会话存档摘要，一份索引、一个查询口、一条降级路径。

出处：docs/离生产级还差什么.md「FTS5 统一全文检索层 + 统一降级」。此前四类内容各查各的（difflib 相关性、
逐字预览、全量注入），没有统一检索；本层只依赖标准库 sqlite3（FTS5 为 SQLite 内置扩展）。

分词选型（实测决定，见 tests/test_fts.py）：
- FTS5 trigram tokenizer（3.34+ 内置）对 **2 字中文查询不命中**（trigram 需 ≥3 字符才产生 token），
  中文两字词（部署/方案/记忆）恰是高频查询，弃用；
- 采用 **unicode61 + 自做 bigram 预处理**：索引与查询走同一条 `_bigramize`——连续 CJK 段拆成
  重叠 bigram + 单字 unigram（空格分隔成独立 token），ASCII 词交给 unicode61（大小写折叠）。
  两字/单字/混排查询都命中，无 SQLite 版本门槛。
- MATCH 注入防线：查询绝不原样进 MATCH——先 `_tokens` 抽出词元（`\\w+`，天然剔掉 `"` `*` `(` `:` `{` 等
  MATCH 元字符），再逐词元双引号包裹（内嵌 `"` 双写转义）空格相连（FTS5 AND 语义）。攻击者输入只剩词元。

同步策略（最小方案，不做后台监听）：
- **写路径顺带更新**：memory/cheatsheet/episodic/session 写成功后调 `sync_kind`/`upsert_session`
  （各源模块内 try/except 包裹——索引同步失败只告警，绝不拖垮主写路径）；显式 path 的写入（测试）不同步；
- **启动时校验重建**：`ensure()` 校验 db 完整性（坏档删档重建）+ 各 kind 源文件签名（mtime/size），
  签名变了（带外改源文件/换机恢复）自动重同步该 kind。签名存 meta 表。

降级（统一口径）：FTS5 缺失 / db 损坏且重建失败 → `search()` 自动落到逐字扫描（同样滤 superseded、
同样 kinds/limit 语义），返回里 `degraded=True`、`engine="scan"` 如实可观测。

注入面：索引正文与检索结果都是**不可信内容**（可能源自 tool_output/web_untrusted 的记忆、复盘里的失败
信号原文）。`search()` 返回原文（调用方可能要做展示外的事）；**进上下文/展示前必须中和**——消费点入口
memory.search / session.search_sessions 已照 episodic 防线中和折行，别绕过它们直接喂模型。
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from . import _io, config

DB_FILE = config.ROOT / ".state" / "fts.db"   # gitignored 运行态，可整体重建，丢了不心疼
KINDS = ("memory", "cheatsheet", "episodic", "session")
_SESSION_TEXT_MAX = 300   # 会话存档只索引「摘要」（首条 user 消息截断），不整份历史入库
_EP_TEXT_MAX = 600

# 连续 CJK 段（中日韩表意 + 假名 + 韩文音节）——bigram 预处理的作用范围
_CJK_RUN = re.compile("[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+")
_WORD = re.compile(r"\w+")   # Python \w 含 CJK——与 unicode61 的词元口径近似，用于抽查询词元

_schema = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5("
    "body, kind UNINDEXED, ref UNINDEXED, orig UNINDEXED)"  # body=bigram 预处理后的检索面；orig=原文（结果回显用）
)


def reset_cache() -> None:
    """清进程内可用性缓存（测试/模拟新进程启动用）。"""
    _state["ok"] = None


_state: dict = {"ok": None}   # 进程内一次性判定：True=FTS5 可用且 db 完好，False=本进程降级扫描


def _bigramize(text: str) -> str:
    """CJK 连续段 → 单字 unigram + 重叠 bigram（空格分隔）；其余原样留给 unicode61 分词。
    索引与查询必须走同一条，否则词元对不上。"""
    parts, pos = [], 0
    for m in _CJK_RUN.finditer(str(text)):
        if m.start() > pos:
            parts.append(text[pos:m.start()])
        run = m.group(0)
        parts.append(" ".join(run))
        if len(run) >= 2:
            parts.append(" ".join(run[i:i + 2] for i in range(len(run) - 1)))
        pos = m.end()
    parts.append(text[pos:])
    return " ".join(p for p in parts if p.strip())


def _tokens(query: str) -> list[str]:
    """查询 → 词元列表（bigram 预处理后抽 \\w+）——MATCH 元字符在这一步全被剔掉（注入防线第一道）。"""
    return _WORD.findall(_bigramize(query))


def _match_expr(tokens: list[str]) -> str:
    """词元 → 安全 MATCH 表达式：逐词元双引号包裹（内嵌引号双写），空格相连 = AND。"""
    return " ".join('"' + t.replace('"', '""') + '"' for t in tokens)


def _fts5_missing(exc: BaseException) -> bool:
    """该异常是否说明本机 SQLite 没编译 FTS5（→ 本进程整体降级，别再试建索引）。"""
    return "no such module" in str(exc).lower()


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return sqlite3.connect(str(db_path), timeout=5.0)


def _sig_memory() -> str:
    from . import memory
    return _file_sig(memory.MEMORY_FILE)


def _sig_cheatsheet() -> str:
    from . import cheatsheet
    return _file_sig(cheatsheet.CHEATSHEET_FILE)


def _sig_episodic() -> str:
    from . import episodic
    return _file_sig(episodic.EPISODIC_FILE)


def _sig_session() -> str:
    from . import session
    files = _session_files()
    if not files:
        return "none"
    return f"{len(files)}:{max(_mtime_ns(f) for f in files)}"


def _file_sig(p: Path) -> str:
    try:
        st = Path(p).stat()
        return f"{st.st_mtime_ns}:{st.st_size}"
    except OSError:
        return "none"


def _mtime_ns(p: Path) -> int:
    try:
        return p.stat().st_mtime_ns
    except OSError:
        return 0


def _session_files() -> list[Path]:
    """交互会话档案（无头/调度档案不进检索，与 list_sessions 同口径）。"""
    from . import session
    d = session.SESSIONS_DIR
    if not d.exists():
        return []
    return [f for f in d.glob("*.json") if not f.stem.startswith(session._BG_PREFIXES)]


_SIG_FN = {"memory": _sig_memory, "cheatsheet": _sig_cheatsheet,
           "episodic": _sig_episodic, "session": _sig_session}


def _items(kind: str) -> list[tuple[str, str]]:
    """枚举某 kind 当前应进索引的 (ref, 原文)——FTS 重建与降级扫描**共用这一份**，保证两条路径口径一致。

    记忆只取**可注入**（有效且未被取代）的条目——与 system_message/:memory 同口径（superseded 软失效不进检索）。
    """
    if kind == "memory":
        from . import memory
        return [(str(r.get("id") or i), str(r.get("text", "")))
                for i, r in enumerate(memory.load_records())
                if memory._is_injectable(r) and str(r.get("text", "")).strip()]
    if kind == "cheatsheet":
        from . import cheatsheet
        return [(str(e.get("id") or i), str(e.get("text", "")))
                for i, e in enumerate(cheatsheet.load_entries()) if str(e.get("text", "")).strip()]
    if kind == "episodic":
        from . import episodic
        out = []
        for i, e in enumerate(episodic.load()):
            text = " ".join(str(e.get(k, "")) for k in ("task", "lesson", "what", "why", "how") if e.get(k))
            if text.strip():
                out.append((str(i), text[:_EP_TEXT_MAX]))  # ref=当前行序（轮转会变，签名校验会追上）
        return out
    if kind == "session":
        from . import session
        out = []
        for f in sorted(_session_files()):
            data = session.load(f)
            if not data:
                continue
            text = ""
            for msg in data["history"]:           # 摘要=首条 user 消息（与 list_sessions 预览同口径）
                if msg.get("role") == "user":
                    text = " ".join(str(msg.get("content", "")).split())
                    break
            out.append((f.stem, text[:_SESSION_TEXT_MAX]))
        return out
    return []


def _create_schema(db: sqlite3.Connection) -> None:
    db.execute(_schema)
    db.execute("CREATE TABLE IF NOT EXISTS meta(kind TEXT PRIMARY KEY, sig TEXT)")
    db.commit()


def _sync_kind_db(db: sqlite3.Connection, kind: str) -> None:
    """（在已打开的 db 上）整体重建某 kind 的索引行 + 更新签名。内容小（≤200 条/类），整体重建最不易漂。"""
    db.execute("DELETE FROM docs WHERE kind = ?", (kind,))
    db.executemany("INSERT INTO docs(body, kind, ref, orig) VALUES(?, ?, ?, ?)",
                   [(_bigramize(text), kind, ref, text) for ref, text in _items(kind)])
    db.execute("INSERT INTO meta(kind, sig) VALUES(?, ?) "
               "ON CONFLICT(kind) DO UPDATE SET sig = excluded.sig", (kind, _SIG_FN[kind]()))
    db.commit()


def ensure() -> bool:
    """启动校验：FTS5 可用性 + db 完整性 + 各 kind 签名；坏档删档重建、过期 kind 重同步。返回是否可用 FTS。

    进程内只判一次（_state 缓存）；判 False = 本进程整体降级逐字扫描。"""
    if _state["ok"] is not None:
        return _state["ok"]
    db_path = Path(DB_FILE)
    try:
        db = _connect(db_path)
        try:
            _create_schema(db)
            db.execute("SELECT count(*) FROM docs").fetchone()   # 坏档在这里炸 DatabaseError
        except sqlite3.OperationalError:
            raise
        except sqlite3.DatabaseError:
            raise _CorruptDb
    except _CorruptDb:
        pass
    except sqlite3.OperationalError as e:
        if _fts5_missing(e):
            _io.warn("[i] 本机 SQLite 未编译 FTS5，统一检索降级为逐字扫描（功能可用、结果带 degraded 标记）。")
            _state["ok"] = False
            return False
        _io.warn(f"[!] 检索索引不可用（{e}），本次降级逐字扫描。")
        _state["ok"] = False
        return False
    except OSError as e:
        _io.warn(f"[!] 检索索引打不开（{e}），本次降级逐字扫描。")
        _state["ok"] = False
        return False
    else:
        return _check_sigs(db)
    # 坏档重建：删档重来 + 全量重同步（索引是衍生数据，源文件才是真相）
    try:
        db.close()
    except Exception:
        pass
    try:
        db_path.unlink(missing_ok=True)
        db = _connect(db_path)
        _create_schema(db)
        for kind in KINDS:
            _sync_kind_db(db, kind)
        _io.warn("[i] 检索索引文件损坏，已删档按源数据重建。")
        return _finish(db, True)
    except sqlite3.OperationalError as e:
        if _fts5_missing(e):
            _io.warn("[i] 本机 SQLite 未编译 FTS5，统一检索降级为逐字扫描（功能可用、结果带 degraded 标记）。")
        else:
            _io.warn(f"[!] 检索索引重建失败（{e}），本次降级逐字扫描。")
        _state["ok"] = False
        return False
    except (sqlite3.DatabaseError, OSError) as e:
        _io.warn(f"[!] 检索索引重建失败（{e}），本次降级逐字扫描。")
        _state["ok"] = False
        return False


def _finish(db: sqlite3.Connection, ok: bool) -> bool:
    try:
        db.close()
    except Exception:
        pass
    _state["ok"] = ok
    return ok


def _check_sigs(db: sqlite3.Connection) -> bool:
    """签名比对：源文件带外变更 → 重同步该 kind；任何一步炸 → 降级不崩。"""
    try:
        known = {row[0]: row[1] for row in db.execute("SELECT kind, sig FROM meta")}
        for kind in KINDS:
            if known.get(kind) != _SIG_FN[kind]():
                _sync_kind_db(db, kind)
        return _finish(db, True)
    except (sqlite3.DatabaseError, OSError) as e:
        _io.warn(f"[!] 检索索引校验失败（{e}），本次降级逐字扫描。")
        return _finish(db, False)


class _CorruptDb(Exception):
    """内部信号：db 文件损坏（走删档重建分支）。"""


def sync_kind(kind: str) -> None:
    """写路径钩子：某 kind 源写成功后顺带整体重同步该 kind。调用方已 try/except，这里失败抛出不吞。"""
    if kind not in KINDS:
        return
    if not ensure():
        return
    db = _connect(Path(DB_FILE))
    try:
        _sync_kind_db(db, kind)
    finally:
        db.close()


def upsert_session(session_id: str) -> None:
    """会话存档写路径钩子：只 upsert 当前这一档（别整类重建——档案可能上百个）。调用方已 try/except。"""
    from . import session
    if not ensure():
        return
    data = session.load_session(session_id)
    text = ""
    if data:
        for msg in data["history"]:
            if msg.get("role") == "user":
                text = " ".join(str(msg.get("content", "")).split())
                break
    db = _connect(Path(DB_FILE))
    try:
        db.execute("DELETE FROM docs WHERE kind = 'session' AND ref = ?", (session_id,))
        db.execute("INSERT INTO docs(body, kind, ref, orig) VALUES(?, 'session', ?, ?)",
                   (_bigramize(text[:_SESSION_TEXT_MAX]), session_id, text[:_SESSION_TEXT_MAX]))
        db.execute("INSERT INTO meta(kind, sig) VALUES('session', ?) "
                   "ON CONFLICT(kind) DO UPDATE SET sig = excluded.sig", (_sig_session(),))
        db.commit()
    finally:
        db.close()


def search(query: str, kinds: list | tuple | None = None, limit: int = 10) -> dict:
    """统一查询：{"results": [{"kind","ref","text"}], "degraded": bool, "engine": "fts5"|"scan"}。

    FTS 路径与降级扫描共用 `_items` 数据源、同滤 superseded、同 kinds/limit 语义——结果口径一致，
    只差排序（fts5 按 bm25，scan 按源顺序）与 degraded 标记。结果文本是**原文**（不可信内容，进上下文前中和）。
    """
    kind_list = [k for k in (kinds or KINDS) if k in KINDS]
    toks = _tokens(query or "")
    if not kind_list or not toks or limit < 1:
        return {"results": [], "degraded": not ensure(), "engine": "fts5" if ensure() else "scan"}
    if ensure():
        try:
            return {"results": _search_fts(toks, kind_list, limit), "degraded": False, "engine": "fts5"}
        except (sqlite3.DatabaseError, OSError) as e:   # 查询期才暴露的坏档/IO 错 → 当场降级
            _io.warn(f"[!] 检索索引查询失败（{e}），本次降级逐字扫描。")
            _state["ok"] = False
    return {"results": _search_scan(query or "", kind_list, limit), "degraded": True, "engine": "scan"}


def _search_fts(tokens: list[str], kinds: list[str], limit: int) -> list[dict]:
    db = _connect(Path(DB_FILE))
    try:
        marks = ",".join("?" for _ in kinds)
        rows = db.execute(
            f"SELECT kind, ref, orig FROM docs WHERE docs MATCH ? AND kind IN ({marks}) "
            f"ORDER BY rank LIMIT ?", (_match_expr(tokens), *kinds, limit)).fetchall()
        return [{"kind": k, "ref": r, "text": t} for k, r, t in rows]
    finally:
        db.close()


def _search_scan(query: str, kinds: list[str], limit: int) -> list[dict]:
    """降级路径：逐字（大小写折叠子串）扫描。与 FTS 路径共用 `_items`，过滤口径一致。"""
    terms = str(query).casefold().split()
    if not terms:
        return []
    out = []
    for kind in kinds:
        for ref, text in _items(kind):
            hay = text.casefold()
            if all(t in hay for t in terms):   # 空白分词 AND——对齐 FTS 路径的多词元 AND 语义
                out.append({"kind": kind, "ref": ref, "text": text})
                if len(out) >= limit:
                    return out
    return out
