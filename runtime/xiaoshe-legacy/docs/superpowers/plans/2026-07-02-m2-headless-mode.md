# M2 无头模式 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 harness 加免值守入口：`python run.py -p "任务"` 一条命令进、结果出；`--allow` 白名单实现「创建时刻 = 审批时刻」；`--workdir` 切工作区；全程档案与日志留痕。

**Architecture:** 新模块 `harness/headless.py` 承载单次执行（复用 `agent.run_once` 引擎与 M1 的会话档案/分会话日志，approver 恒拒 + `--allow` 预填 `ctx["_approved_tools"]`——与交互模式答 `a` 是同一机制，不新造权限通道）；`run.py` 用 argparse 分流（无参数 = 交互 repl 一切如旧）。硬护栏（越界/敏感文件/命令扫描）在任何模式下不可豁免。命名任务档案（把白名单存成文件反复用）留给 M3 调度一起做。

**Tech Stack:** Python 3.10+ 纯标准库（argparse/contextlib/unittest），中文测试名。

**约定：** 仓库根 `/Users/example/Desktop/Harness交接包/Harness`，main 直接提交；当前基线 **110 条全绿**（HEAD `02a9f5d`）；提交信息结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；push 前必须 `export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897`。

---

### Task 1: `harness/headless.py` 核心（免值守单次执行）

**Files:**
- Create: `harness/headless.py`
- Create: `tests/test_m2.py`

- [ ] **Step 1: 写失败测试** — 新建 `tests/test_m2.py`：

```python
"""M2 无头模式：免值守单次执行 / 白名单审批 / 工作区切换 的回归测试。

运行：仓库根目录 `python -m unittest discover -s tests -v`
"""
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from harness import config, headless, permission, session

_ROOT = Path(__file__).resolve().parent.parent


def _脚本模型(responses):
    """依次弹出预设响应的假模型（不联网）。"""
    seq = list(responses)

    def fn(history, tools=None):
        return seq.pop(0)

    return fn


def _写文件调用(path, content="hi"):
    return {"content": "", "tool_calls": [{"id": "t1", "function": {
        "name": "write_file",
        "arguments": json.dumps({"path": path, "content": content}, ensure_ascii=False)}}]}


_完成 = {"content": "任务完成", "tool_calls": []}


class 无头模式核心(unittest.TestCase):
    def _sandbox(self, d):
        """把工作区、会话档案目录、日志目录全部指到临时目录。"""
        base = Path(d).resolve()
        (base / "ws").mkdir()
        return (mock.patch.object(permission, "ROOT", base / "ws"),
                mock.patch.object(session, "SESSIONS_DIR", base / "sessions"),
                mock.patch.object(session, "LOGS_DIR", base / "logs"))

    def test_安全任务_免值守跑完_打印结果且留档案和日志(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            with p1, p2, p3:
                buf = io.StringIO()
                with redirect_stdout(buf):
                    code = headless.run_headless("说句结论", model_fn=_脚本模型([
                        {"content": "结论是四十二", "tool_calls": []}]))
                self.assertEqual(code, 0)
                self.assertIn("结论是四十二", buf.getvalue())
                archives = list(session.SESSIONS_DIR.glob("headless-*.json"))
                self.assertEqual(len(archives), 1)
                logs = list(session.LOGS_DIR.glob("headless-*.jsonl"))
                self.assertEqual(len(logs), 1)

    def test_危险工具默认拒_文件不落盘且日志留痕(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            with p1, p2, p3:
                with redirect_stdout(io.StringIO()):
                    code = headless.run_headless("写个文件", model_fn=_脚本模型([
                        _写文件调用("a.txt"), _完成]))
                self.assertEqual(code, 0)
                self.assertFalse((permission.ROOT / "a.txt").exists())
                log_text = next(session.LOGS_DIR.glob("headless-*.jsonl")).read_text(encoding="utf-8")
                self.assertIn("拒绝", log_text)

    def test_allow白名单放行_文件真落盘(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            with p1, p2, p3:
                with redirect_stdout(io.StringIO()):
                    code = headless.run_headless("写个文件", allow=("write_file",),
                                                 model_fn=_脚本模型([_写文件调用("a.txt"), _完成]))
                self.assertEqual(code, 0)
                self.assertEqual((permission.ROOT / "a.txt").read_text(encoding="utf-8"), "hi")

    def test_白名单不越过硬护栏_敏感文件仍拒(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            with p1, p2, p3:
                with redirect_stdout(io.StringIO()):
                    headless.run_headless("写敏感文件", allow=("write_file",),
                                          model_fn=_脚本模型([_写文件调用(".env", "K=1"), _完成]))
                self.assertFalse((permission.ROOT / ".env").exists())

    def test_workdir切换工作区_用完恢复原值(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            other = Path(d).resolve() / "other"
            other.mkdir()
            with p1, p2, p3:
                before = permission.ROOT
                with redirect_stdout(io.StringIO()):
                    code = headless.run_headless("在别处写文件", allow=("write_file",),
                                                 workdir=str(other),
                                                 model_fn=_脚本模型([_写文件调用("b.txt"), _完成]))
                self.assertEqual(code, 0)
                self.assertTrue((other / "b.txt").exists())
                self.assertEqual(permission.ROOT, before)  # 用完恢复

    def test_workdir不存在_退出码1且不跑模型(self):
        with tempfile.TemporaryDirectory() as d:
            p1, p2, p3 = self._sandbox(d)
            with p1, p2, p3:
                def 不该被调用(history, tools=None):
                    raise AssertionError("workdir 非法时不应调用模型")
                code = headless.run_headless("x", workdir=str(Path(d) / "nope"), model_fn=不该被调用)
                self.assertEqual(code, 1)
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `python3 -m unittest tests.test_m2 -v`
Expected: 6 条均 ERROR（`ImportError`/`AttributeError`：`harness.headless` 不存在）。

- [ ] **Step 3: 实现** — 新建 `harness/headless.py`：

```python
"""无头模式（M2）：一条命令进、结果出，免值守。

安全语义：
- 无人值守，approver 恒拒——危险工具默认全拒（继承「无 TTY 默认 deny」拍板）。
- --allow 显式放行 = 敲命令的人在那一刻完成的审批（创建时刻=审批时刻），
  预填进会话白名单 ctx["_approved_tools"]，与交互模式答 'a' 是同一机制，粒度到工具名。
- 硬护栏（路径越界 / 敏感文件 / 命令密钥扫描）任何模式下不可放行。
- --workdir 把本次运行的工作区 ROOT 切到指定目录（敲命令的人自选；用完恢复）。
- 全程留痕：会话档案 headless-<id>.json + 独立日志 .state/logs/headless-<id>.jsonl。
"""
from __future__ import annotations

import sys
from pathlib import Path

from . import _io, agent, jobs, mcp_client, memory, permission, session
from .kimi_client import KimiError
from .kimi_client import chat as kimi_chat


def _deny_all(tool_name, args, reason):
    return False  # 无头模式没有人可问：白名单外一律拒


def _print_reply(text: str) -> None:
    try:
        print(text)
    except UnicodeEncodeError:  # GBK 等窄编码终端：宁可替换字符也不崩
        enc = sys.stdout.encoding or "utf-8"
        print(text.encode(enc, errors="replace").decode(enc, errors="replace"))


def run_headless(prompt: str, allow: tuple[str, ...] = (), workdir: str | None = None,
                 model_fn=kimi_chat) -> int:
    """免值守跑完一条任务：结果打到 stdout，返回进程退出码（0=完成，1=出错/参数非法）。"""
    old_root = permission.ROOT
    if workdir:
        wd = Path(workdir).expanduser().resolve()
        if not wd.is_dir():
            _io.warn(f"[!] --workdir 不是一个目录：{wd}")
            return 1
        permission.ROOT = wd
    if "run_command" in allow or "run_in_background" in allow:
        _io.warn("[i] 已放行命令执行工具——命令文本的密钥扫描硬护栏仍然生效。")
    sid = "headless-" + session.new_session_id()
    log_file = session.session_log_file(sid)
    ctx = {"todos": [], "memory_file": memory.MEMORY_FILE,
           "_approved_tools": set(allow)}
    msg = memory.system_message()
    history = [msg] if msg else []
    try:
        mcp_client.connect_configured()  # 有 mcp.json 就接上（工具仍受白名单管）
        reply = agent.run_once(prompt, history, model_fn=model_fn,
                               approver=_deny_all, log_file=log_file, ctx=ctx)
        _print_reply(reply)
        if agent._ends_clean(history):
            try:
                session.save_session(sid, history, ctx.get("todos", []))
            except OSError as e:
                _io.warn(f"[!] 会话存档失败（结果已输出，不影响本次）：{e}")
        return 0
    except KimiError as e:
        _io.warn(f"[!] 无头任务失败：{e}")
        return 1
    finally:
        permission.ROOT = old_root
        jobs.shutdown()
        mcp_client.shutdown()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python3 -m unittest tests.test_m2 -v` → 6 条 PASS。
Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3` → `Ran 116 tests`，`OK`。

- [ ] **Step 5: Commit**

```bash
git add harness/headless.py tests/test_m2.py
git commit -m "M2：无头模式核心——免值守单次执行，--allow 即审批，硬护栏不可豁免

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> **修订（2026-07-02，T1 质量审查）**：① --allow 未知工具名告警（拼写错不再静默无效）；② new_session_id 支持前缀、探测带前缀名——同进程同秒连调 run_headless 档案不再互覆；③ docstring 注明独占进程假定与非 KimiError 冒泡语义。护栏 +3（T2 后全量 122）。

---

### Task 2: `run.py` 入口分流 + 实链验证

**Files:**
- Modify: `run.py`（整文件替换，现在只有 5 行）
- Modify: `tests/test_m2.py`（追加 3 条测试）

- [ ] **Step 1: 写失败测试** — `tests/test_m2.py` 末尾追加：

```python
class 入口参数(unittest.TestCase):
    def test_无p时给allow参数_报用法错误不进对话(self):
        r = subprocess.run([sys.executable, "run.py", "--allow", "write_file"],
                           cwd=str(_ROOT), capture_output=True, text=True,
                           encoding="utf-8", timeout=30)
        self.assertEqual(r.returncode, 2)
        self.assertIn("只在", r.stderr)

    def test_帮助信息_包含无头模式三个参数(self):
        r = subprocess.run([sys.executable, "run.py", "--help"],
                           cwd=str(_ROOT), capture_output=True, text=True,
                           encoding="utf-8", timeout=30)
        self.assertEqual(r.returncode, 0)
        for opt in ("--prompt", "--allow", "--workdir"):
            self.assertIn(opt, r.stdout)


class 实链无头(unittest.TestCase):
    def test_实链_无头一句话任务真跑通(self):
        if not config.API_KEY:
            self.skipTest("无 KIMI_API_KEY，跳过实链")
        r = subprocess.run([sys.executable, "run.py", "-p", "只回复两个字：收到"],
                           cwd=str(_ROOT), capture_output=True, text=True,
                           encoding="utf-8", timeout=180)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("收到", r.stdout)
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `python3 -m unittest tests.test_m2.入口参数 -v`
Expected: 两条均 FAIL（现 run.py 无 argparse：`--allow` 未识别时 python 直接进 repl 或报错行为不符断言——以实际观察为准，记录进汇报）。

- [ ] **Step 3: 实现** — `run.py` 整文件替换为：

```python
"""入口：默认交互对话；-p 进无头模式（一条命令进、结果出，免值守）。

用法：
  python run.py                                交互对话（一切如旧）
  python run.py -p "看看 README 讲了啥"          无头跑一条任务后退出
  python run.py -p "整理下载目录" --allow write_file --workdir ~/Downloads
"""
import argparse

from harness.agent import repl
from harness.headless import run_headless


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="run.py", description="Harness：你自己的 agent（无参数=交互对话）")
    parser.add_argument("-p", "--prompt",
                        help="无头模式：免值守跑完这一条任务后退出")
    parser.add_argument("--allow", default="",
                        help="无头模式放行的工具名，逗号分隔（如 write_file,run_command）；敲下即视为审批")
    parser.add_argument("--workdir",
                        help="无头模式的工作区目录（默认=仓库根；敏感文件硬护栏仍生效）")
    args = parser.parse_args()
    if args.prompt:
        allow = tuple(t.strip() for t in args.allow.split(",") if t.strip())
        return run_headless(args.prompt, allow=allow, workdir=args.workdir)
    if args.allow or args.workdir:
        parser.error("--allow/--workdir 只在 -p 无头模式下有效")
    repl()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试确认通过（含实链）**

Run: `python3 -m unittest tests.test_m2 -v` → 9 条 PASS（实链 1 条真连 Kimi）。
Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3` → `Ran 119 tests`，`OK`。
手工冒烟：`python3 run.py -p "看看 README.md 第一节讲了啥，一句话"` → 免值守输出总结、退出码 0（`echo $?` 验证）；`python3 run.py`（无参数）→ 交互模式一切如旧（列会话/对话/:exit）。观察写进汇报。

- [ ] **Step 5: Commit**

```bash
git add run.py tests/test_m2.py
git commit -m "M2：run.py 入口分流——无参数交互如旧，-p 免值守单次执行

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> **修订（2026-07-02，T2 质量审查）**：空/全空白 `-p` 由「静默进交互（自动化下假成功）」改为报用法错误 exit 2；new_session_id docstring 注明前缀约束。护栏 +1（T3 后全量 123）。

---

### Task 3: 契约 + README + 推送收尾

**Files:**
- Modify: `CONTRACT.md`（末尾追加 M2 段）
- Modify: `README.md`（「跑起来」节加无头模式；测试计数 119）

- [ ] **Step 1: CONTRACT.md 末尾追加**（逐字）：

```markdown
---

# M2 · 无头模式（免值守入口）· 契约

## 1. 多了什么
`python run.py -p "任务"`：一条命令进、结果出、中途没人值守。`--allow` 把工具白名单在敲命令那一刻一次性批好（创建时刻 = 审批时刻，与交互模式答 `a` 同一机制）；`--workdir` 把本次工作区切到指定目录。无头会话同样留痕：档案 `headless-<id>.json` + 独立日志。

## 2. 对外行为（你能验收的）
| 你做什么 | 它应该 |
|---|---|
| `python run.py -p "看看 README 讲了啥"` | 免值守打印总结后退出，退出码 0 |
| `-p` 让它写文件（没给 `--allow`） | 文件不落盘，模型被告知「用户拒绝」，日志留痕 |
| 加 `--allow write_file` 重跑 | 文件真落盘 |
| `--allow` 下让它碰 `.env`/越界路径/密钥类命令 | 硬护栏照拒——白名单救不了 |
| `--workdir ~/somewhere` | 本次以该目录为工作区（人敲的 = 人批的） |
| `python run.py`（无参数） | 交互模式一切如旧 |
| 跑 `python -m unittest discover -s tests -v` | 119 条全绿（3 条实链无 key/网络自动跳过） |

## 3. 关键决定
- 无头 approver 恒拒（没有人可问）；`--allow` 预填会话白名单，粒度到工具名、不到参数。
- 硬护栏（越界 / 敏感文件 / 命令密钥扫描）在任何模式下不可豁免。
- 命名任务档案（把白名单存成文件反复用）留 M3 与调度一起做——M2 的「创建时刻=审批时刻」由命令行本身承载。

## 4. 已知取舍
- 无 wall-clock 总超时：单轮有 curl 超时 + 20 轮工具上限兜底，真挂起要人杀——M3 调度器统一加超时。
- `--workdir` 扩大工作区是敲命令者的自选；`--allow run_command` 等于整体放行该工具（命令扫描仍拦密钥类）——别在无头模式跑不可信内容。
- 无头模式也会连 mcp.json 里的 server（工具仍受白名单管）；不需要时删掉 mcp.json 即可。
```

- [ ] **Step 2: README.md** —「跑起来（你验收用）」一节、第 1 小节之后插入：

```markdown
2. 无头模式（免值守跑一条任务）：
   ```
   python run.py -p "看看 README 讲了啥"
   python run.py -p "在 note.txt 写一句 hello" --allow write_file
   ```
   - 不给 `--allow` 时危险操作一律拒（并记日志）；`--allow` = 敲命令那一刻你已审批。
   - `--workdir 目录` 可把这次的工作区切到别处；`.env`/私钥等硬护栏在哪都拒。
```

（原「2. 看日志……」顺延为 3；核对全节编号连续。）测试计数行 `共 110 条` 改为 `共 119 条`，`（含 2 条需 KIMI_API_KEY 的实链）` 改为 `（含 3 条需 KIMI_API_KEY 的实链）`。

- [ ] **Step 3: 全量回归 + Commit + Push**

Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3` → `Ran 119 tests`，`OK`。

```bash
git add CONTRACT.md README.md
git commit -m "M2 收尾：契约落档——免值守入口与命令行审批语义

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897
git push
```

- [ ] **Step 4: 用户亲自验收清单（交付给用户）**

1. `python3 run.py -p "看看 README 讲了啥，一句话总结"` → 免值守出总结；
2. `python3 run.py -p "在 note.txt 里写一句 hello"` → 被拒、note.txt 不存在；
3. `python3 run.py -p "在 note.txt 里写一句 hello" --allow write_file` → note.txt 落盘；
4. `python3 -m unittest discover -s tests -v` → 119 条全绿。

---

## Self-review 记录

- **Spec 覆盖**：M2 = 单次执行入口 ✓（Task 1/2）+ 任务白名单机制 ✓（--allow 预填 _approved_tools，Task 1）+ 验收「一句命令免值守干完活；越权任务被拒并留日志」✓（测试 1/2 + 用户清单 1/2）。spec 决策 1 的「命名任务档案」明确留 M3（契约第 3 节声明）。
- **无占位符**：全部代码/命令/预期实文。
- **类型一致**：`run_headless(prompt, allow=(), workdir=None, model_fn=kimi_chat) -> int` 在实现、run.py 调用、全部测试中一致；`_脚本模型`/`_写文件调用`/`_完成` 夹具签名一致。
- **测试计数**：110 + 6（T1）+ 3（T2，含实链 1）= 119，各 Task Expected 一致。
- **不破坏存量**：run.py 无参数路径 = 原 repl；headless 不改任何既有模块。
