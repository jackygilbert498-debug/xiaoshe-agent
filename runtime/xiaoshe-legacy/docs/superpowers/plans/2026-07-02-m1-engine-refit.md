# M1 引擎整备 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让多个 harness 进程可以同时开工互不打架：机器本地状态收拢进 `.state/`，一会话一档案 + 启动列表恢复，共享文件（memory.json）跨平台文件锁，日志按会话分文件。

**Architecture:** 三块独立改动 + 一次 repl 集成：① `_io.file_lock` 跨平台文件锁原语（POSIX fcntl / Windows msvcrt，锁旁车 `.lock` 文件，超时抛 TimeoutError 绝不静默）；② `memory.py` 的读改写路径全部上锁（拿不到锁 = 告警 + 不写，fail-safe）；③ `session.py` 新增多会话档案函数族（`new_session_id`/`save_session`/`load_session`/`list_sessions`/`pick_session`/`migrate_legacy`/`session_log_file`），**旧的 `save(history,todos,path)`/`load(path)` 原样保留**（存量测试用位置参数传路径，零破坏）；④ `agent.repl` 换用会话列表恢复 + 按会话分日志。memory.json 仍在仓库根（git 同步的共享大脑），`.state/` 是本机私有（gitignore）。

**Tech Stack:** Python 3.10+ 纯标准库（fcntl/msvcrt/contextlib/tempfile/unittest），中文测试名。

**约定：** 仓库根 `/Users/example/Desktop/Harness交接包/Harness`，main 直接提交，测试跑法 `python3 -m unittest discover -s tests -v`，当前基线 **90 条全绿**。提交信息结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

**目标状态目录布局（本机私有，不进 git）：**

```
.state/
  sessions/<会话id>.json    会话档案 {"id","saved_at","history","todos"}
  logs/<会话id>.jsonl       该会话的逐条消息日志
memory.json                 仍在仓库根（git 同步；锁文件 memory.json.lock 被 memory.json.* 规则忽略）
```

---

### Task 1: `_io.file_lock` 跨平台文件锁

**Files:**
- Modify: `harness/_io.py`（文件顶部 import 区 + 文件末尾追加）
- Create: `tests/_lock_holder.py`（子进程夹具）
- Create: `tests/test_m1.py`

- [ ] **Step 1: 建子进程夹具** — 新建 `tests/_lock_holder.py`（下划线开头，不被 unittest 收集）：

```python
"""测试夹具：锁住指定文件一段时间（供跨进程文件锁测试用）。
用法：python _lock_holder.py <目标文件路径> <持锁秒数>
拿到锁后向 stdout 打一行 LOCKED（供主测试进程同步时机）。"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from harness import _io

if __name__ == "__main__":
    target, hold = sys.argv[1], float(sys.argv[2])
    with _io.file_lock(target, timeout=5.0):
        print("LOCKED", flush=True)
        time.sleep(hold)
```

- [ ] **Step 2: 写失败测试** — 新建 `tests/test_m1.py`：

```python
"""M1 引擎整备：文件锁 / 记忆并发 / 多会话档案 / 会话选择 的回归测试。

运行：仓库根目录 `python -m unittest discover -s tests -v`
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import _io

_HOLDER = Path(__file__).resolve().parent / "_lock_holder.py"


def _hold_lock(target: Path, seconds: float) -> subprocess.Popen:
    """起一个子进程锁住 target，等它打出 LOCKED 再返回（保证锁已在手）。"""
    proc = subprocess.Popen([sys.executable, str(_HOLDER), str(target), str(seconds)],
                            stdout=subprocess.PIPE, text=True, encoding="utf-8")
    assert proc.stdout.readline().strip() == "LOCKED"
    return proc


class 文件锁(unittest.TestCase):
    def test_锁被其他进程持有时_等待超时抛TimeoutError(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "shared.json"
            proc = _hold_lock(target, 2.0)
            try:
                with self.assertRaises(TimeoutError):
                    with _io.file_lock(target, timeout=0.3):
                        pass
            finally:
                proc.wait()

    def test_锁释放后_能再次获得(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "shared.json"
            with _io.file_lock(target, timeout=1.0):
                pass
            with _io.file_lock(target, timeout=1.0):
                pass  # 顺序两次都拿得到，说明释放干净

    def test_锁内代码抛异常_锁仍被释放(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "shared.json"
            try:
                with _io.file_lock(target, timeout=1.0):
                    raise ValueError("锁内故意炸")
            except ValueError:
                pass
            with _io.file_lock(target, timeout=0.5):
                pass  # 异常后还能拿到锁
```

- [ ] **Step 3: 跑新测试确认失败**

Run: `python3 -m unittest tests.test_m1 -v`
Expected: 3 条均 ERROR（`AttributeError: module 'harness._io' has no attribute 'file_lock'`）。

- [ ] **Step 4: 实现** — `harness/_io.py`：import 区补 `import time` 与 `from contextlib import contextmanager`（现有 import 为 json/os/sys/pathlib.Path），文件末尾追加：

```python
@contextmanager
def file_lock(path, timeout: float = 5.0):
    """跨进程互斥锁：锁 <path>.lock 旁车文件（POSIX 用 fcntl.flock，Windows 用 msvcrt.locking）。

    超时抛 TimeoutError——由调用方决定怎么降级（告警/放弃），绝不静默继续写共享文件。
    旁车文件命名 <name>.lock：对 memory.json 即 memory.json.lock，天然命中 .gitignore 的 memory.json.*。
    """
    lock_path = Path(str(path) + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(lock_path, "a+b")
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    fh.seek(0)
                    msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"等待文件锁超时：{lock_path.name}")
                time.sleep(0.05)
        try:
            yield
        finally:
            try:
                if os.name == "nt":
                    import msvcrt
                    fh.seek(0)
                    msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
    finally:
        fh.close()
```

- [ ] **Step 5: 跑测试确认通过**

Run: `python3 -m unittest tests.test_m1 -v` → 3 条 PASS。
Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3` → `Ran 93 tests`，`OK`。

- [ ] **Step 6: Commit**

```bash
git add harness/_io.py tests/_lock_holder.py tests/test_m1.py
git commit -m "M1：_io.file_lock 跨平台文件锁（超时即抛、绝不静默）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: memory 读改写上锁（并发不丢记忆）

**Files:**
- Modify: `harness/memory.py`（`remember` 与 `resolve_conflict_file` 包锁；模块顶部加 `_LOCK_TIMEOUT`）
- Create: `tests/_mem_writer.py`（并发写夹具）
- Modify: `tests/test_m1.py`（追加 3 条测试）

- [ ] **Step 1: 建并发写夹具** — 新建 `tests/_mem_writer.py`：

```python
"""测试夹具：向指定记忆文件 remember 一条事实（供并发写测试用）。
用法：python _mem_writer.py <memory.json 路径> <事实文本>"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from harness import memory

if __name__ == "__main__":
    memory.remember(sys.argv[2], path=sys.argv[1])
```

- [ ] **Step 2: 写失败测试** — `tests/test_m1.py` 顶部 import 区补 `from harness import memory`，末尾追加：

```python
_WRITER = Path(__file__).resolve().parent / "_mem_writer.py"


class 记忆并发(unittest.TestCase):
    def test_六个进程同时记事_一条都不丢(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "memory.json"
            facts = [f"事实{i}" for i in range(6)]
            procs = [subprocess.Popen([sys.executable, str(_WRITER), str(p), f])
                     for f in facts]
            for proc in procs:
                proc.wait()
            self.assertEqual(sorted(memory.load(p)), sorted(facts))

    def test_记忆文件被锁住_remember不写入且返回False(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "memory.json"
            proc = _hold_lock(p, 1.5)
            try:
                with mock.patch.object(memory, "_LOCK_TIMEOUT", 0.2):
                    self.assertFalse(memory.remember("锁着呢", p))
                self.assertFalse(p.exists())  # 一个字都没写
            finally:
                proc.wait()

    def test_合并命令拿不到锁_文件不动且返回False(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "memory.json"
            conflicted = '[\n<<<<<<< HEAD\n  "a"\n=======\n  "b"\n>>>>>>> other\n]\n'
            p.write_text(conflicted, encoding="utf-8")
            proc = _hold_lock(p, 1.5)
            try:
                with mock.patch.object(memory, "_LOCK_TIMEOUT", 0.2):
                    self.assertFalse(memory.resolve_conflict_file(p))
                self.assertEqual(p.read_text(encoding="utf-8"), conflicted)
            finally:
                proc.wait()
```

- [ ] **Step 3: 跑新测试确认失败**

Run: `python3 -m unittest tests.test_m1.记忆并发 -v`
Expected: 第 2、3 条 ERROR（`AttributeError: ... '_LOCK_TIMEOUT'`）；第 1 条可能侥幸通过（无锁时小概率丢写，这正是要修的竞态）。

- [ ] **Step 4: 实现** — `harness/memory.py`：

模块常量区（`MEMORY_FILE = ...` 之后）加：

```python
_LOCK_TIMEOUT = 5.0  # 等共享文件锁的秒数；拿不到 = 告警 + 不写（fail-safe），绝不带锁外写
```

`remember` 整体替换为（读改写全程持锁）：

```python
def remember(fact: str, path: Path | str | None = None) -> bool:
    """追加一条事实（去重）。原子写。返回是否真的新增了。

    读改写全程持文件锁：两个进程同时记事不互相覆盖（M1）。拿不到锁 = 告警 + 放弃本条。
    """
    p = Path(path) if path else MEMORY_FILE
    fact = (fact or "").strip()
    if not fact:
        return False
    try:
        with _io.file_lock(p, timeout=_LOCK_TIMEOUT):
            facts = load(p)
            if fact in facts:
                return False
            facts.append(fact)
            _io.atomic_write_json(p, facts, indent=2)
            return True
    except TimeoutError:
        _io.warn("[!] 记忆文件正被其他进程占用，这条没记上——稍后再说一遍即可。")
        return False
```

`resolve_conflict_file` 的函数体在读文件之前上锁：把现有实现中从 `text = p.read_text(...)` 到最后 `return True` 的整段包进 `with _io.file_lock(p, timeout=_LOCK_TIMEOUT):` 块（`if not p.exists(): return False` 留在锁外），并在函数最外层加：

```python
    try:
        with _io.file_lock(p, timeout=_LOCK_TIMEOUT):
            ...  # 现有的 read_text / 标记判定 / 拆边 / _parse / 写回逻辑原样内移一层缩进
    except TimeoutError:
        _io.warn("[!] 记忆文件正被其他进程占用，合并未执行——稍后重试。")
        return False
```

（除缩进内移与外包 try 外，锁内逻辑一行都不改。）

- [ ] **Step 5: 跑测试确认通过**

Run: `python3 -m unittest tests.test_m1 -v` → 6 条 PASS。
Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3` → `Ran 96 tests`，`OK`。

- [ ] **Step 6: Commit**

```bash
git add harness/memory.py tests/_mem_writer.py tests/test_m1.py
git commit -m "M1：记忆读改写全程持锁——多进程同时记事不丢、拿不到锁不写不装成功

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> **修订（2026-07-02，T2 质量审查）**：remember 锁超时由「返回 False」改为「告警后抛 TimeoutError」——False 会被 tools 层渲染成「早就记着了」构成假报成功；抛错交给 tools.execute 信任边界收敛为 is_error，模型可感知。测试同步改为 assertRaises + 新增工具层护栏一条。

---

### Task 3: 多会话档案（一会话一文件 + 列表 + 迁移 + 上限清理）

**Files:**
- Modify: `harness/session.py`（追加函数族；旧 `save`/`load` 一行不动）
- Modify: `tests/test_m1.py`（追加 5 条测试）

- [ ] **Step 1: 写失败测试** — `tests/test_m1.py` import 区补 `import os` 与 `from harness import session`，末尾追加：

```python
class 会话档案(unittest.TestCase):
    def _tmp(self, d):
        return mock.patch.object(session, "SESSIONS_DIR", Path(d) / "sessions")

    def test_新会话id_同秒重复时自动加后缀(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            sid1 = session.new_session_id()
            session.save_session(sid1, [{"role": "user", "content": "hi"}], [])
            sid2 = session.new_session_id()
            self.assertNotEqual(sid1, sid2)

    def test_按id存取会话_往返内容一致(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            hist = [{"role": "user", "content": "你好"}, {"role": "assistant", "content": "嗯"}]
            todos = [{"content": "A", "status": "pending"}]
            session.save_session("s1", hist, todos)
            data = session.load_session("s1")
            self.assertEqual(data["history"], hist)
            self.assertEqual(data["todos"], todos)

    def test_会话列表_最近的排前面且带预览(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            session.save_session("old", [{"role": "user", "content": "旧会话的第一句话"}], [])
            session.save_session("new", [{"role": "system", "content": "记忆"},
                                         {"role": "user", "content": "新会话的第一句话"}], [])
            f_old = session.SESSIONS_DIR / "old.json"
            os.utime(f_old, (f_old.stat().st_mtime - 100, f_old.stat().st_mtime - 100))
            lst = session.list_sessions()
            self.assertEqual([s["id"] for s in lst], ["new", "old"])
            self.assertIn("新会话的第一句话"[:10], lst[0]["preview"])
            self.assertEqual(lst[0]["n_messages"], 2)

    def test_会话档案超过上限_自动清掉最旧的(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d), \
             mock.patch.object(session, "_MAX_SESSIONS", 3):
            for i in range(5):
                session.save_session(f"s{i}", [{"role": "user", "content": str(i)}], [])
                f = session.SESSIONS_DIR / f"s{i}.json"
                os.utime(f, (f.stat().st_mtime - (5 - i) * 10,) * 2)
            session.save_session("s5", [{"role": "user", "content": "5"}], [])
            left = {p.stem for p in session.SESSIONS_DIR.glob("*.json")}
            self.assertEqual(len(left), 3)
            self.assertIn("s5", left)

    def test_旧单档案存在_迁移进列表且原文件改名不再重复迁(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            legacy = Path(d) / ".session" / "last.json"
            legacy.parent.mkdir(parents=True)
            legacy.write_text('{"history": [{"role": "user", "content": "老会话"}], "todos": []}',
                              encoding="utf-8")
            with mock.patch.object(session, "LEGACY_FILE", legacy):
                self.assertTrue(session.migrate_legacy())
                self.assertFalse(legacy.exists())
                self.assertTrue(legacy.with_name("last.json.migrated").exists())
                self.assertEqual(len(session.list_sessions()), 1)
                self.assertFalse(session.migrate_legacy())  # 第二次无事可做
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `python3 -m unittest tests.test_m1.会话档案 -v`
Expected: 5 条均 ERROR（`AttributeError: module 'harness.session' has no attribute ...`）。

- [ ] **Step 3: 实现** — `harness/session.py`：import 区补 `from datetime import datetime`，在 `SESSION_FILE = ...` 行后追加：

```python
# —— M1 多会话档案：一会话一文件，存 .state/sessions/，本机私有不进 git —— #
SESSIONS_DIR = config.ROOT / ".state" / "sessions"
LOGS_DIR = config.ROOT / ".state" / "logs"
LEGACY_FILE = SESSION_FILE  # v1 单档案（迁移后改名 .migrated，不再读）
_MAX_SESSIONS = 50  # 档案数上限：超过静默清最旧（原始逐条日志仍在 .state/logs/ 里，不算丢数据）
_PREVIEW_CHARS = 24
```

文件末尾追加：

```python
def new_session_id() -> str:
    """生成可读、可排序、不重复的会话 id（时间戳；同秒冲突加 -2/-3 后缀）。"""
    base = datetime.now().strftime("%Y%m%d-%H%M%S")
    sid, n = base, 1
    while (SESSIONS_DIR / f"{sid}.json").exists():
        n += 1
        sid = f"{base}-{n}"
    return sid


def save_session(session_id: str, history: list, todos: list) -> None:
    """按 id 存会话档案（原子写），随手清掉超上限的最旧档案。"""
    _io.atomic_write_json(SESSIONS_DIR / f"{session_id}.json",
                          {"id": session_id,
                           "saved_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                           "history": history, "todos": todos})
    files = sorted(SESSIONS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[_MAX_SESSIONS:]:
        try:
            old.unlink()
        except OSError:
            pass


def load_session(session_id: str) -> dict | None:
    return load(SESSIONS_DIR / f"{session_id}.json")  # 复用旧 load 的校验（history 必须是 list）


def list_sessions(limit: int = 5) -> list[dict]:
    """最近的会话在前：[{"id","n_messages","preview"}]。坏档案跳过不报错。"""
    if not SESSIONS_DIR.exists():
        return []
    out = []
    files = sorted(SESSIONS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for f in files[:limit]:
        data = load(f)
        if not data:
            continue
        preview = "（空会话）"
        for msg in data["history"]:
            if msg.get("role") == "user":
                preview = str(msg.get("content", ""))[:_PREVIEW_CHARS]
                break
        out.append({"id": f.stem, "n_messages": len(data["history"]), "preview": preview})
    return out


def pick_session(sessions: list[dict], answer: str) -> str | None:
    """把用户在恢复列表的输入变成会话 id：回车/非法输入=None（开新会话），合法编号=对应 id。"""
    answer = (answer or "").strip()
    if answer.isdigit() and 1 <= int(answer) <= len(sessions):
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
    sid = "legacy-" + datetime.fromtimestamp(LEGACY_FILE.stat().st_mtime).strftime("%Y%m%d-%H%M%S")
    save_session(sid, data["history"], data.get("todos", []))
    try:
        LEGACY_FILE.replace(LEGACY_FILE.with_name(LEGACY_FILE.name + ".migrated"))
    except OSError:
        pass
    _io.warn(f"[i] 已把上个版本的会话存档迁入会话列表（{sid}）。")
    return True
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python3 -m unittest tests.test_m1 -v` → 11 条 PASS。
Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3` → `Ran 102 tests`，`OK`（旧 `save`/`load` 未动，test_stage3/test_v1_hardening 全绿如常）。

- [ ] **Step 5: Commit**

```bash
git add harness/session.py tests/test_m1.py
git commit -m "M1：多会话档案——一会话一文件、列表恢复、上限清理、旧档案自动迁移

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> **修订（2026-07-02，T3 质量审查）**：① 会话 id 掺 pid——同秒双进程启动不再互覆档案；② 排序 stat 加容错 `_mtime`——并发 prune 不再崩进程；③ 列表先过滤后取额；④ 迁移竞态兜底。护栏测试 +3（后续计数相应 +3：T4 后全量应为 109）。

---

### Task 4: repl 集成——列表恢复 + 按会话分日志

**Files:**
- Modify: `harness/agent.py`（`repl` 的恢复块与存档行、BANNER 一句话）
- Modify: `tests/test_m1.py`（追加 4 条测试）

- [ ] **Step 1: 写失败测试** — `tests/test_m1.py` 末尾追加（`pick_session`/`session_log_file` 属 Task 3 已实现，此处测的是选择语义与路径约定，防 repl 集成时改坏）：

```python
class 会话选择与日志路径(unittest.TestCase):
    SESSIONS = [{"id": "a", "n_messages": 1, "preview": "x"},
                {"id": "b", "n_messages": 2, "preview": "y"}]

    def test_回车_开新会话(self):
        self.assertIsNone(session.pick_session(self.SESSIONS, ""))

    def test_输合法编号_恢复对应会话(self):
        self.assertEqual(session.pick_session(self.SESSIONS, "2"), "b")

    def test_非法输入_一律按新会话处理(self):
        for bad in ("abc", "0", "99", " 3 ", "-1"):
            self.assertIsNone(session.pick_session(self.SESSIONS, bad), bad)

    def test_会话日志路径_按会话id分文件(self):
        p = session.session_log_file("s1")
        self.assertEqual(p.name, "s1.jsonl")
        self.assertEqual(p.parent, session.LOGS_DIR)
```

（注：`" 3 "` 经 strip 后是合法数字但超范围 → None；该用例锁住「先 strip 再判界」的行为。）

- [ ] **Step 2: 跑新测试** — Run: `python3 -m unittest tests.test_m1.会话选择与日志路径 -v`
Expected: 4 条 PASS（Task 3 已实现纯函数；本任务的主体是 repl 集成，repl 是交互循环，用户真机验收）。若有 FAIL，说明 Task 3 实现与约定不符，先修。

- [ ] **Step 3: 改 repl** — `harness/agent.py`：

(a) BANNER 最后一行说明改为：

```python
输入你的话回车；:exit / :quit 退出，Ctrl+C 也行；重开可从列表接着历史会话。
```

(b) `repl()` 中从 `saved = session.load()` 到 `history = _fresh_history()`（含 else 分支，即当前第 202-216 行整块）替换为：

```python
    session.migrate_legacy()  # v1 旧单档案首次运行时自动迁入列表
    sessions = session.list_sessions()
    history, session_id = None, None
    if sessions:
        print(f"发现 {len(sessions)} 个历史会话：")
        for i, s in enumerate(sessions, 1):
            print(f"  {i}) {s['id']} · {s['n_messages']} 条 · 「{s['preview']}」")
        try:
            ans = input("回车=开新会话，输编号=接着那个会话： ")
        except (EOFError, KeyboardInterrupt):
            ans = ""
        chosen = session.pick_session(sessions, ans)
        if chosen:
            data = session.load_session(chosen)
            if data:
                history, session_id = data["history"], chosen
                ctx["todos"] = data.get("todos", [])
                memory.refresh_pinned_system(history)  # 用最新 memory 刷新开场 system，别用旧快照
                print(f"（已恢复会话 {chosen}）")
    if history is None:
        history = _fresh_history()
        session_id = session.new_session_id()
    ctx["session_id"] = session_id
    log_file = session.session_log_file(session_id)  # 一会话一份日志，多开进程互不写串
```

(c) 主循环里的 `reply = run_once(user_text, history, ctx=ctx)` 改为：

```python
                reply = run_once(user_text, history, log_file=log_file, ctx=ctx)
```

(d) 存档行 `session.save(history, ctx.get("todos", []))` 改为：

```python
                session.save_session(session_id, history, ctx.get("todos", []))
```

- [ ] **Step 4: 全量回归**

Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3` → `Ran 106 tests`，`OK`。

- [ ] **Step 5: 手工冒烟（实现者做，非用户）** — 在仓库根跑 `python3 run.py`：应直接开新会话（无历史列表或列表含迁移来的 legacy 会话）；随便聊一句（真机连 Kimi）；`:exit`；再 `python3 run.py`，应出现会话列表，输 `1` 能恢复，`.state/sessions/` 与 `.state/logs/` 下有对应 id 的文件。把观察结果写进汇报。

- [ ] **Step 6: Commit**

```bash
git add harness/agent.py tests/test_m1.py
git commit -m "M1：repl 会话列表恢复 + 一会话一份日志

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> **修订（2026-07-02，T4 质量审查）**：① pick_session 改用 isdecimal——「②」「²」这类 isdigit 为真但 int 不认的输入不再崩 repl；② 列表预览压成单行防换行撕乱显示；③ 恢复目标不可读时提示后开新会话。护栏测试 +1（T5 后全量应为 110）。

---

### Task 5: .gitignore + 契约 + README 收尾

**Files:**
- Modify: `.gitignore`、`CONTRACT.md`（末尾追加 M1 段）、`README.md`（结构说明与测试计数）

- [ ] **Step 1: .gitignore** — 「运行日志与状态」段加一行 `.state/`（保留 `logs/` 与 `.session/`——旧目录残留继续忽略）。

- [ ] **Step 2: CONTRACT.md 末尾追加**：

```markdown
---

# M1 · 引擎整备（多开不打架）· 契约

## 1. 多了什么
本机运行状态收拢进 `.state/`（不进 git）：一会话一档案（`.state/sessions/`）+ 一会话一份日志（`.state/logs/`）；`memory.json` 读改写全程持文件锁。多个终端同时开 harness 互不打架。

## 2. 对外行为（你能验收的）
| 你做什么 | 它应该 |
|---|---|
| `python run.py` 重开 | 列出最近会话（时间id · 条数 · 首句预览），回车开新的、输编号接着旧的 |
| 开两个终端同时对话 | 各自独立会话档案与日志，互不写串 |
| 两个终端同时让它「记住…」 | 两条都进 memory.json，一条不丢 |
| 记忆文件被别的进程占用超时 | 告警「这条没记上」，绝不静默丢或写坏 |
| 从 v1/M0 升级后首次运行 | 旧的 .session/last.json 自动迁入会话列表（原文件改名 .migrated） |
| 跑 `python -m unittest discover -s tests -v` | 106 条全绿（2 条实链无 key/网络自动跳过） |

## 3. 关键决定
- 锁的语义：拿不到锁 = 告警 + 放弃本次写（fail-safe），绝不带锁外写、绝不假报成功。
- `memory.json` 留在仓库根随 git 同步（共享大脑）；`.state/` 是本机私有（会话/日志属于这台机器）。
- 旧 `session.save/load(path)` 接口原样保留（存量测试与外部脚本不破坏）。

## 4. 已知取舍
- 会话档案上限 50 个，超过静默清最旧（逐条原始日志仍在 `.state/logs/`，不算丢数据）。
- 会话档案本身不加锁：一会话一文件、一进程一会话 id，天然无并发写。
- 锁只覆盖 harness 自己的进程；外部编辑器同时改 memory.json 不在保护范围。
```

- [ ] **Step 3: README.md** — 结构说明里 `tests/` 行的 `共 90 条` 改为 `共 106 条`；「结构」段落在 `run.py` 行前加一行说明：

```
.state/                      本机运行状态（会话档案+日志；不进 git、不同步）
```

- [ ] **Step 4: 全量回归 + Commit**

Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3` → `Ran 106 tests`，`OK`。

```bash
git add .gitignore CONTRACT.md README.md
git commit -m "M1 收尾：契约落档——多开不打架 + 状态目录收拢

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 5: 用户亲自验收清单（交付给用户）**

1. 跑 `python3 -m unittest discover -s tests -v` → 106 条全绿；
2. 开**两个终端**都跑 `python3 run.py`，各聊一句 → 互不干扰，`:exit` 后重开能看到两个会话都在列表里；
3. 输编号恢复其中一个 → 它记得刚才聊的内容；
4. 两个终端同时说「记住我喜欢X/记住我喜欢Y」→ 关掉重开，两条记忆都在。

---

## Self-review 记录

- **Spec 覆盖**：M1 三项交付（状态目录收拢→Task 3/5；会话多文件化+列表恢复→Task 3/4；共享文件锁→Task 1/2）齐；日志分会话（spec 第 5 节决策 4）→Task 4。
- **无占位符**：Task 2 Step 4 对 `resolve_conflict_file` 用「整段内移一层缩进」描述而非重抄 40 行——锁内逻辑明确为「一行不改」，实现者可机械执行，不构成 TBD。
- **类型一致**：`new_session_id()->str`、`save_session(id,hist,todos)`、`load_session(id)->dict|None`、`list_sessions(limit)->list[dict{id,n_messages,preview}]`、`pick_session(list,str)->str|None`、`session_log_file(id)->Path`、`migrate_legacy()->bool`、`_io.file_lock(path,timeout)`、`memory._LOCK_TIMEOUT` 在测试与实现两侧逐一核对一致。
- **测试计数**：90 +3（T1）+4（T2 含评审新增护栏 1 条）+5（T3）+4（T4）= 106，各 Task Expected 与之一致。
- **不破坏存量**：旧 `session.save/load` 位置参数用法（test_stage3:67-77、test_v1_hardening:170-171）零改动。
