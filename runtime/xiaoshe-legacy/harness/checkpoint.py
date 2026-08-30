"""可靠性 · 文件级 undo（检查点）：write_file/edit **执行前**快照目标文件旧字节，:undo 一键还原。

对不读代码的用户最实在的可靠性网——「撤销刚才那步文件改动」。接在 effects 账本理念上，但比记账更进一步：
写前把目标文件旧内容存进 `.state/undo/`（不存在则标 absent），改成功后压进 undo 栈；undo_last 人确认后
把文件还原成改前（旧内容 / 删掉新建的），**还原前先把当前内容存一份 recovery 副本**（误撤能找回）。

安全（对抗审查硬化）：
- **`.state/undo` 进敏感硬护栏**（permission._is_sensitive）——agent 的 write_file/edit/run_command 碰不了栈文件，
  从入口断掉「篡改栈」这条威胁。纵深再加：**token 当不可信路径分量校验**（纯 hex 白名单 + 结果必须就在 undo 目录下），
  即便栈被别的途径改坏，也绝不能用 token 拼出越界的 blob/recovery/unlink 路径（HIGH：否则可越界任意读/写/删）。
- 只覆盖 write_file/edit（run_command 任意副作用不可靠 undo，不碰）；快照/commit 任何 I/O 失败绝不冒泡阻塞工具执行。
- undo 还原目标复校验 safe_path（越界/敏感拒）；**还原用原子写、recovery 存不下则 fail-closed 中止**（绝不在没兜住时摧毁当前内容）。
- 快照**选择性**（§6.2）：敏感文件（.env 类）绝不进快照（快照=把密钥复制进 .state/undo，泄密面放大）、
  二进制与超体积上限的不快照——跳过时经 skip_reason 如实上报原因，账本区分「可撤/未快照不可撤/本质不可逆」三态；
  体积上限 _MAX_SNAP_BYTES 抽常量留校准口；pending/blob/recovery 全走 file_lock；
  启动 reconcile 回收孤儿 + recovery 有界。`.state/` 已 gitignore，不进 git、不泄漏。
- undo 还原与快照清理有**墙钟上限**（§6.3：_UNDO_WALL_TIMEOUT / _PRUNE_WALL_TIMEOUT）——大还原/慢磁盘不卡死会话；
  超时如实报部分状态（recovery 存没存、还原执没执行、清理跳没跳过），clock 可注入（不真 sleep）。
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from . import _io, config, permission

UNDO_DIR = config.ROOT / ".state" / "undo"
_MAX_UNDO = 50               # undo 栈上限（含 blob）——防无界增长；超限丢最旧
_MAX_RECOVERY = 20           # recovery 副本上限——防无界堆积（对抗审查 LOW）
_MAX_SNAP_BYTES = 5 * 1024 * 1024   # 快照体积上限：超此不纳入 undo（对齐 edit 5MB 护栏，防 OOM/磁盘放大，对抗审查 MED）——校准口
_BINARY_SNIFF_BYTES = 8192   # 二进制嗅探：头部含 NUL 即判二进制，不进快照（校准口）
_UNDO_WALL_TIMEOUT = 30.0    # undo 还原墙钟上限（秒）——大还原/慢磁盘不卡死会话，超时如实报部分状态（校准口）
_PRUNE_WALL_TIMEOUT = 10.0   # 快照清理（reconcile/prune）墙钟上限（秒）——到点收手留到下轮，不卡会话启动（校准口）
_LOCK_TIMEOUT = 5
_UNDOABLE = {"write_file", "edit"}   # 只有这两个是「可靠可还原的文件改动」；run_command 等不碰
_TOKEN_RE = re.compile(r"^[0-9a-f]{1,32}$")   # token 恒为 uuid4().hex[:16]，纯 hex 白名单（HIGH：当路径分量校验）


def _base(base=None) -> Path:
    return Path(base) if base else UNDO_DIR


def _stack_path(base=None) -> Path:
    return _base(base) / "stack.jsonl"


def _pending_path(base=None) -> Path:
    return _base(base) / "pending.jsonl"


def _safe_child(b: Path, prefix: str, token) -> Path | None:
    """把 token 拼成 b/<prefix><token> 并**双重校验**：token 纯 hex + 结果 resolve 后就在 b 下。

    HIGH 修：token 是第二个路径输入，undo 只对 abs 复校验、token 却原样拼路径——纯 hex 白名单 + parent==b
    杜绝 `..\\..\\` 词法穿越（Windows 对 blob-.. 做尾点归一逃出 ROOT）。非法返 None（该条不可用、跳过）。"""
    if not isinstance(token, str) or not _TOKEN_RE.match(token):
        return None
    cand = b / f"{prefix}{token}"
    try:
        if cand.resolve().parent != b.resolve():
            return None
    except (OSError, ValueError):
        return None
    return cand


def _load_stack(base=None) -> list:
    p = _stack_path(base)
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


def _save_stack(stack: list, base=None) -> None:
    _base(base).mkdir(parents=True, exist_ok=True)
    _io.atomic_write_text(_stack_path(base),
                          "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in stack))


def _load_pending(base=None) -> list:
    p = _pending_path(base)
    out = []
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return out
    for line in text.splitlines():
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(r, dict):
            out.append(r)
    return out


def _atomic_write_bytes(p: Path, data: bytes) -> None:
    """原子写字节：临时文件 + os.replace（对抗审查 LOW：undo 还原用它，掉电/ENOSPC 也不留半截坏文件）。"""
    tmp = p.with_name(f".{p.name}.tmp-{os.getpid()}-{uuid.uuid4().hex[:8]}")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, p)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _note_skip(out, reason: str) -> None:
    """快照被选择性跳过时，把机器键原因（too_big/sensitive/binary）经 out 列表如实上报给调用方（→ effects 账本）。"""
    if isinstance(out, list):
        out.append(reason)


def snapshot(tool: str, args, ctx=None, base=None, skip_reason=None) -> str | None:
    """write_file/edit **执行前**调：快照目标文件当前字节（不存在则标 absent），返回 token。

    只对可 undo 的文件工具；非文件工具/解析失败/读失败一律返回 None（绝不阻塞工具执行）。
    选择性快照（§6.2）：敏感（.env 类，进快照=泄密面放大）/超体积/二进制不快照，
    跳过时往 skip_reason（list，可选）追加原因键——调用方据此把「未快照不可撤」记进账本。
    pending 落文件（token 唯一）+ blob 全在 file_lock 内（对抗审查 MED：防双开并发丢档）。"""
    if tool not in _UNDOABLE or not isinstance(args, dict):
        return None
    path_arg = args.get("path")
    if not isinstance(path_arg, str) or not path_arg:
        return None
    try:
        p = permission.resolve(path_arg)   # 与工具同款解析（相对→ROOT）；敏感/越界已在 permission.check 硬拒、到不了这
    except (OSError, ValueError):
        return None
    b = _base(base)
    try:
        if permission._is_sensitive(p):   # 纵深：即便审批层被绕过，敏感文件字节也绝不复制进 .state/undo
            _note_skip(skip_reason, "sensitive")
            return None
        existed = p.exists() and p.is_file()
        if existed:
            if p.stat().st_size > _MAX_SNAP_BYTES:
                _note_skip(skip_reason, "too_big")
                return None   # 大文件不纳入 undo（防整份读入内存 OOM + blob 磁盘放大，绕过 edit 护栏）
            with p.open("rb") as f:
                if b"\x00" in f.read(_BINARY_SNIFF_BYTES):   # 二进制：blob 复制价值低、体积大，不进快照
                    _note_skip(skip_reason, "binary")
                    return None
        b.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex[:16]
        with _io.file_lock(b, timeout=_LOCK_TIMEOUT):
            if existed:
                (b / f"blob-{token}").write_bytes(p.read_bytes())
            with open(_pending_path(base), "a", encoding="utf-8") as f:
                f.write(json.dumps({"token": token, "tool": tool, "abs": str(p),
                                    "rel": _rel(p), "existed": existed}, ensure_ascii=False) + "\n")
        return token
    except (OSError, TimeoutError):
        return None   # 含锁等待超时：本次跳过 undo，绝不上抛阻塞工具执行


def _rel(p: Path) -> str:
    try:
        return p.relative_to(permission.active_root()).as_posix()
    except (ValueError, OSError):
        return p.name


def commit(token, tool: str, args, ctx=None, ok: bool = True, base=None) -> None:
    """工具执行后调：成功则把这次快照压进 undo 栈；失败/被拒则丢弃 blob（不留垃圾）。绝不冒泡。

    pop pending 与压栈在**同一 file_lock 临界区**（对抗审查 MED：与 snapshot 的 append 串行化，防丢档）。"""
    if not token:
        return
    b = _base(base)
    try:
        b.mkdir(parents=True, exist_ok=True)
        with _io.file_lock(b, timeout=_LOCK_TIMEOUT):
            # pop pending（同锁内）
            pending, kept = None, []
            for r in _load_pending(base):
                if r.get("token") == token and pending is None:
                    pending = r
                else:
                    kept.append(r)
            _io.atomic_write_text(_pending_path(base),
                                  "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in kept))
            blob = _safe_child(b, "blob-", token)
            if not ok:
                if blob:
                    blob.unlink(missing_ok=True)   # 没真改，丢快照
                return
            if not pending:
                return   # 无对应快照意图（重复 commit / 已被清）——别入残缺记录
            rec = dict(pending)
            rec["ts"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            try:   # 身份指纹（对抗审查 LOW）：记改动后的 size+mtime，undo 时据此判「文件是否又被外部改过」
                p = permission.resolve(rec.get("abs") or rec.get("rel", ""))
                if p.exists():
                    st = p.stat()
                    rec["after_size"], rec["after_mtime"] = st.st_size, int(st.st_mtime)
            except (OSError, ValueError):
                pass
            stack = _load_stack(base)
            stack.append(rec)
            while len(stack) > _MAX_UNDO:   # 有界：超限丢最旧（连 blob 一起删）
                old = stack.pop(0)
                ob = _safe_child(b, "blob-", old.get("token", ""))
                if ob:
                    ob.unlink(missing_ok=True)
            _save_stack(stack, base)
    except (OSError, TimeoutError):
        pass


def _changed_since(rec: dict) -> bool:
    """当前文件是否与「改动后记录的指纹」不符（=改动后又被外部（编辑器等）动过）。无指纹则 False。"""
    if "after_size" not in rec:
        return False
    try:
        p = permission.resolve(rec.get("abs") or rec.get("rel", ""))
        if not p.exists():
            return True   # 我们写完时它在（记了 after_size），现在没了=被外部删过
        st = p.stat()
        return st.st_size != rec.get("after_size") or int(st.st_mtime) != rec.get("after_mtime")
    except (OSError, ValueError):
        return False


def peek(base=None) -> dict | None:
    """栈顶（最近一次可 undo 的文件改动）；空栈返 None。附 changed_since=改动后是否又被外部改过。"""
    stack = _load_stack(base)
    if not stack:
        return None
    top = dict(stack[-1])
    top["changed_since"] = _changed_since(top)
    return top


def count(base=None) -> int:
    return len(_load_stack(base))


def undo_last(ctx=None, base=None, clock=None, timeout=None) -> tuple[bool, str]:
    """还原最近一次文件改动。人确认由调用方（REPL :undo）负责；这里只做还原本身。

    复校验路径（safe_path 越界/敏感拒）+ token 纯 hex 白名单（HIGH）；还原前先存 recovery 副本，
    **存不下则 fail-closed 中止**（绝不在没兜住时摧毁当前内容，LOW）；改前存在→原子写回旧字节，改前不存在→删新建的。
    墙钟上限（§6.3）：大还原/慢磁盘不卡死会话；超时如实报部分状态——还原**前**到点=中止（目标没动、栈顶保留可重试），
    还原**后**到点=还原已成、只跳过清理并如实交代。clock 可注入（测试不真 sleep）。"""
    clock = clock or time.monotonic
    limit = _UNDO_WALL_TIMEOUT if timeout is None else timeout
    t0 = clock()
    b = _base(base)
    try:
        b.mkdir(parents=True, exist_ok=True)
        with _io.file_lock(b, timeout=_LOCK_TIMEOUT):
            stack = _load_stack(base)
            if not stack:
                return (False, "没有可撤销的文件改动。")
            rec = stack[-1]
            rel = rec.get("rel", "?")
            token = rec.get("token", "")
            try:
                p = permission.safe_path(rec.get("abs") or rel)   # 复校验还原目标：越界/敏感拒
            except permission.PathError as e:
                stack.pop(); _save_stack(stack, base)
                return (False, f"拒绝撤销：{e}")
            blob = _safe_child(b, "blob-", token)   # HIGH：token 纯 hex + 就在 undo 目录下
            recov = _safe_child(b, "recovery-", token)
            if rec.get("existed") and blob is None:
                stack.pop(); _save_stack(stack, base)
                return (False, "撤销失败：快照标识非法（栈可能被篡改），已跳过该条。")
            # 还原前存 recovery（当前内容），存不下则中止——安全网存不下就不许拆网（fail-closed）
            recov_saved = False
            if p.exists() and p.is_file():
                if recov is None:
                    stack.pop(); _save_stack(stack, base)
                    return (False, "撤销失败：recovery 标识非法，已跳过该条。")
                try:
                    recov.write_bytes(p.read_bytes())
                    recov_saved = True
                except OSError:
                    return (False, f"撤销已中止：存不下 {rel} 当前内容的 recovery 副本，不敢覆盖你现在的文件。")
            if clock() - t0 > limit:   # 墙钟到点、还原还没动 → 中止：目标保持现状，栈顶保留可重试（绝不装已撤）
                return (False, f"撤销超时（>{limit:g} 秒）："
                               f"{'recovery 副本已存，但' if recov_saved else ''}还原未执行——{rel} 保持现状（未还原），"
                               f"这条仍在栈里可重试。")
            if rec.get("existed"):
                if not blob.exists():
                    stack.pop(); _save_stack(stack, base)
                    return (False, f"撤销失败：{rel} 的快照已丢失（可能被清理）。")
                p.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write_bytes(p, blob.read_bytes())   # 原子写回旧字节（二进制安全、掉电不留半截）
                msg = f"已把 {rel} 还原到改动前。"
            else:
                if p.exists():
                    p.unlink()
                msg = f"已删除新建的 {rel}（还原到不存在）。"
            stack.pop()
            _save_stack(stack, base)
            if clock() - t0 > limit:   # 还原已成、清理超预算 → 跳过清理（blob/prune 留到下轮），如实交代
                return (True, msg + "（超时：快照清理已跳过，不影响还原结果）")
            if blob:
                blob.unlink(missing_ok=True)
            _prune_recovery(b)
            return (True, msg)
    except (OSError, TimeoutError) as e:
        return (False, f"撤销时出错：{e}")


def _prune_recovery(b: Path, deadline=None, clock=None) -> None:
    """recovery 副本有界：按 mtime 只留最近 _MAX_RECOVERY 份（对抗审查 LOW：防无界堆积）。

    deadline（绝对时刻）给定时与 clock 配合做墙钟截断（§6.3）：到点收手，剩下的留到下轮。"""
    try:
        recs = sorted(b.glob("recovery-*"), key=lambda f: f.stat().st_mtime, reverse=True)
        for f in recs[_MAX_RECOVERY:]:
            if deadline is not None and clock is not None and clock() > deadline:
                break   # 墙钟到点：没清完如实体现在残留上，不卡死
            f.unlink(missing_ok=True)
    except OSError:
        pass


def reconcile(base=None, clock=None, timeout=None) -> None:
    """启动对账（对抗审查 LOW）：回收孤儿 blob（token 不在栈里）+ 清理 pending 里已入栈的陈旧行 + recovery 有界。

    snapshot→commit 非原子，进程在两者间被 kill 会留孤儿 blob+pending；本函数在会话初把它们扫掉，防只增不清。
    墙钟上限（§6.3）：清理到点提前收手（剩下的下轮再清），undo 目录再大也不卡会话启动；clock 可注入。"""
    clock = clock or time.monotonic
    limit = _PRUNE_WALL_TIMEOUT if timeout is None else timeout
    b = _base(base)
    if not b.exists():
        return
    try:
        t0 = clock()
        deadline = t0 + limit
        with _io.file_lock(b, timeout=_LOCK_TIMEOUT):
            live = {r.get("token") for r in _load_stack(base) if isinstance(r, dict)}
            for f in b.glob("blob-*"):
                if clock() > deadline:
                    break   # 墙钟到点：剩下的孤儿留到下轮（没清完如实体现在残留上），不卡会话启动
                if f.name[len("blob-"):] not in live:   # 孤儿 blob（token 不在栈）——crash/eviction 残留
                    f.unlink(missing_ok=True)
            if clock() <= deadline:
                # pending：删掉 token 已在栈里的（陈旧已 commit）+ 无对应 blob 的孤儿；genuine 未 commit 的（有 blob、不在栈）保留
                kept = [r for r in _load_pending(base)
                        if r.get("token") not in live and (b / f"blob-{r.get('token', '')}").exists()]
                _io.atomic_write_text(_pending_path(base),
                                      "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in kept))
            _prune_recovery(b, deadline=deadline, clock=clock)
    except (OSError, TimeoutError):
        pass


def list_recent(n: int = 5, base=None) -> list:
    """最近 n 条可 undo 的文件改动（供 :undo 展示）。栈顶在前。"""
    return list(reversed(_load_stack(base)))[:max(1, n)]
