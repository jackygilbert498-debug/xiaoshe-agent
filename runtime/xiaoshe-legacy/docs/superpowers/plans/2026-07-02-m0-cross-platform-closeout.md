# M0 换机闭环 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 v1 在 Mac 上回到「82+ 条测试全绿」的可信基线，抹掉 Windows 残留，建立双机私有 git 同步——为 v2 所有后续里程碑铺地基。

**Architecture:** 三个独立小改动 + 一次仓库运维：① 权限层在比对路径时展开 ROOT（修 macOS 符号链接误判，7 条红的唯一根因）；② 错误提示/文档改为平台无关表述；③ 记忆文件入 git 并配一条冲突合并命令；④ 接私有远程、写下双机同步纪律。引擎逻辑零改动。

**Tech Stack:** Python 3.10+ 纯标准库（unittest / pathlib / json / tempfile），git。测试跑法固定为仓库根目录下 `python -m unittest discover -s tests -v`。

**约定：** 所有工作在 `/Users/example/Desktop/Harness交接包/Harness`（下称仓库根）进行；测试方法名用中文（说清行为）；每个 Task 收尾提交 git，提交信息结尾加 `Co-Authored-By:` 行（见各 Task）。

---

### Task 1: 权限层加固——ROOT 未展开（符号链接）也不误判越界

背景：macOS 的 `/var` 是指向 `/private/var` 的符号链接。测试用 `tempfile` 拿到 `/var/...` 路径直接 patch `permission.ROOT`，而 `permission.resolve()` 对文件路径做了 `.resolve()`（得到 `/private/var/...`），`_within_root()` 却拿未展开的 ROOT 做 `relative_to` 比对——两边对不上，一切操作被误判「越出工作区」。这就是 7 条红的唯一根因。修法：**比对时把 ROOT 也展开**。既修测试，也让生产代码对「用户工作区路径里有符号链接」天然免疫。7 条既有红测试**不改动**——它们转绿本身就是回归证明。

**Files:**
- Create: `tests/test_m0.py`
- Modify: `harness/permission.py:63-75`（`_within_root` 与 `resolve`）

- [ ] **Step 1: 写失败测试**

新建 `tests/test_m0.py`，内容如下：

```python
"""M0 换机闭环：跨平台加固与迁移收尾的回归测试。

运行：仓库根目录 `python -m unittest discover -s tests -v`
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import permission


def _symlink_workspace(base: Path):
    """造一个「真目录 + 指向它的符号链接」，复刻 macOS /var → /private/var 陷阱。
    返回 (real, alias)；本环境不允许建符号链接时返回 None。"""
    real = base / "work"
    real.mkdir()
    alias = base / "alias"
    try:
        os.symlink(real, alias, target_is_directory=True)
    except (OSError, NotImplementedError):
        return None
    return real, alias


class 跨平台工作区(unittest.TestCase):
    def test_工作区ROOT是未展开的符号链接_路径判定不误判越界(self):
        with tempfile.TemporaryDirectory() as d:
            pair = _symlink_workspace(Path(d).resolve())
            if pair is None:
                self.skipTest("本环境不允许创建符号链接")
            real, alias = pair
            (real / "a.txt").write_text("hi", encoding="utf-8")
            with mock.patch.object(permission, "ROOT", alias):  # 故意不 resolve
                self.assertEqual(permission.check("read_file", {"path": "a.txt"}).action, "approve")
                self.assertEqual(permission.safe_path("a.txt"), real / "a.txt")

    def test_符号链接ROOT下_越界路径依然被拒(self):
        with tempfile.TemporaryDirectory() as d:
            pair = _symlink_workspace(Path(d).resolve())
            if pair is None:
                self.skipTest("本环境不允许创建符号链接")
            real, alias = pair
            with mock.patch.object(permission, "ROOT", alias):
                self.assertEqual(
                    permission.check("read_file", {"path": "../../etc/hosts"}).action, "deny")
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `python3 -m unittest tests.test_m0 -v`
Expected: `test_工作区ROOT是未展开的符号链接_路径判定不误判越界` **FAIL**（`AssertionError: 'deny' != 'approve'`）；`test_符号链接ROOT下_越界路径依然被拒` PASS（回归护栏，修完不许变）。

- [ ] **Step 3: 实现最小修复**

`harness/permission.py`：把 63–75 行的 `_within_root` 和 `resolve` 换成（新增 `_root()`，其余不动）：

```python
def _root() -> Path:
    # ROOT 可能是未展开的路径（macOS 下 /var 是 /private/var 的符号链接；测试也会 patch 进临时目录）。
    # 判定一律用展开后的 ROOT，避免"文件路径展开了、ROOT 没展开"的误判越界。
    return Path(ROOT).resolve()


def _within_root(p: Path) -> bool:
    try:
        p.relative_to(_root())
        return True
    except ValueError:
        return False


def resolve(path_str: str) -> Path:
    p = Path(path_str)
    if not p.is_absolute():
        p = _root() / p
    return p.resolve()
```

- [ ] **Step 4: 跑全量测试确认 84 条全绿**

Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -5`
Expected: `Ran 84 tests`，`OK`（含原 7 条红全部转绿；2 条实链测试有 key+网络才真跑）。

- [ ] **Step 5: Commit**

```bash
git add tests/test_m0.py harness/permission.py
git commit -m "M0：权限层展开 ROOT 再比对——修 macOS 符号链接误判越界（7 条红转绿）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 错误提示与文档去 Windows 残留

**Files:**
- Modify: `tests/test_m0.py`（追加 1 条测试）
- Modify: `harness/kimi_client.py:4,86`、`harness/agent.py:199`、`harness/permission.py:9`
- Modify: `README.md:8`、`CONTRACT.md:37,53`、`tests/test_smoke.py:6`、`tests/test_tools_permission.py:5`
- Modify（仓库外，不进 git）: `/Users/example/Desktop/Harness交接包/迁移手册.md:14,107`

- [ ] **Step 1: 写失败测试**

在 `tests/test_m0.py` 末尾追加：

```python
class 提示信息跨平台(unittest.TestCase):
    def test_缺key的报错提示_不含写死的Windows路径且指向env文件(self):
        from harness import kimi_client
        with mock.patch.object(kimi_client.config, "API_KEY", ""):
            with self.assertRaises(kimi_client.KimiError) as ctx:
                kimi_client.chat([{"role": "user", "content": "hi"}])
        msg = str(ctx.exception)
        self.assertNotIn("D:\\", msg)
        self.assertIn(".env", msg)
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `python3 -m unittest tests.test_m0.提示信息跨平台 -v`
Expected: **FAIL**（`AssertionError: 'D:\\' unexpectedly found in ...`）。

- [ ] **Step 3: 改两处运行时提示**

`harness/kimi_client.py:86` 改为：

```python
        raise KimiError(f"没读到 KIMI_API_KEY——请在 {config.ROOT / '.env'} 里填上你的 Kimi key。")
```

`harness/agent.py:199` 改为：

```python
        print(f"[!] 没读到 KIMI_API_KEY——请确认 {config.ROOT / '.env'} 里填了 key。")
```

- [ ] **Step 4: 改五处文档/注释表述**

逐条精确替换：

`harness/permission.py:9`：
- 旧：`工作区根 ROOT 默认 = 整个 D:\\Harness 仓库；测试可 patch 本模块的 ROOT 换成临时目录。`
- 新：`工作区根 ROOT 默认 = 整个仓库目录；测试可 patch 本模块的 ROOT 换成临时目录。`

`harness/kimi_client.py:4`（文件头注释里的 `curl.exe（schannel）` 一句）：
- 新表述：`传输：走系统自带的 curl（Windows 为 curl.exe/schannel，macOS 自带 curl 同样适用）——本机访问 api.kimi.com 需经本地代理，`

`README.md:8`：
- 旧：`前提：Windows，已装 Python 3、系统自带 \`curl\`，本地代理开着（\`127.0.0.1:7897\`），\`.env\` 里填了 Kimi key。`
- 新：`前提：Windows 或 macOS，已装 Python 3.10+、系统自带 \`curl\`，能连通 api.kimi.com（需代理时在 \`.env\` 的 \`KIMI_PROXY\` 配好，默认 \`127.0.0.1:7897\`），\`.env\` 里填了 Kimi key。`

`CONTRACT.md:53`：
- 旧：`在 \`D:\Harness\` 下跑：\`python -m unittest discover -s tests -v\``
- 新：`在仓库根目录跑：\`python -m unittest discover -s tests -v\``

`CONTRACT.md:37`：句中 `系统自带的 \`curl.exe\`（schannel）稳` 改为 `系统自带的 \`curl\` 稳（Windows 为 curl.exe/schannel；macOS 自带 curl 亦实测可用）`。

`tests/test_smoke.py:6` 与 `tests/test_tools_permission.py:5` 的 docstring：`在 D:\\Harness 下` 均改为 `在仓库根目录下`。

- [ ] **Step 5: 修迁移手册笔误（仓库外文件，不进 git）**

`/Users/example/Desktop/Harness交接包/迁移手册.md`：
- 第 14 行 `项目记忆备份/        ← 3 个记忆文件` 改为 `项目记忆备份/        ← 4 个记忆文件（3 条记忆 + 1 个索引 MEMORY.md）`；
- 第 107 行 `把 \`项目记忆备份/\` 里的 3 个 \`.md\` 拷到新机` 改为 `把 \`项目记忆备份/\` 里的 4 个 \`.md\` 拷到新机`；
- 第 2 节开头加一行：`> 2026-07 起双机并用（Mac + Windows），Mac 上一切前提相同（curl/Python 自带，代理按 .env 的 KIMI_PROXY）。`

- [ ] **Step 6: 全量回归**

Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3`
Expected: `Ran 85 tests`，`OK`。
Run: `grep -rn 'D:\\' --include='*.py' --include='*.md' . | grep -v superpowers | grep -v 离生产级`
Expected: 无输出（`docs/离生产级还差什么.md` 里的历史表述保留不改，它记录的是 v1 时代事实）。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "M0：错误提示与文档去 Windows 残留，双平台表述

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 记忆合并命令 + memory.json 入库

背景（spec 决策 2）：记忆进 git 双机共享；git 冲突时「两边都留、自动去重」。冲突时 `memory.json` 会被 git 塞进 `<<<<<<<`/`=======`/`>>>>>>>` 标记变成非法 JSON，所以合并命令要能直接解析带冲突标记的文件。

**Files:**
- Modify: `tests/test_m0.py`（追加 2 条测试）
- Modify: `harness/memory.py`（追加 `merge_facts`、`resolve_conflict_file`、`__main__` 入口）
- Modify: `.gitignore`（`memory.json*` → `memory.json.*`）

- [ ] **Step 1: 写失败测试**

在 `tests/test_m0.py` 末尾追加：

```python
from harness import memory


class 记忆合并(unittest.TestCase):
    def test_合并两份记忆_并集去重且保持先后顺序(self):
        self.assertEqual(memory.merge_facts(["a", "b"], ["b", "c"]), ["a", "b", "c"])

    def test_解析含git冲突标记的记忆文件_两边事实都保留(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "memory.json"
            p.write_text(
                '[\n<<<<<<< HEAD\n  "a",\n  "b"\n=======\n  "a",\n  "c"\n>>>>>>> other\n]\n',
                encoding="utf-8")
            self.assertTrue(memory.resolve_conflict_file(p))
            self.assertEqual(memory.load(p), ["a", "b", "c"])
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `python3 -m unittest tests.test_m0.记忆合并 -v`
Expected: 两条均 **FAIL**（`AttributeError: module 'harness.memory' has no attribute 'merge_facts'`）。

- [ ] **Step 3: 实现**

在 `harness/memory.py` 的 `refresh_pinned_system` 之后追加：

```python
def merge_facts(*fact_lists) -> list[str]:
    """多份记忆求并集：去重、保持首次出现的先后顺序。"""
    merged: list[str] = []
    for facts in fact_lists:
        for f in facts:
            f = str(f).strip()
            if f and f not in merged:
                merged.append(f)
    return merged


def resolve_conflict_file(path: Path | str | None = None) -> bool:
    """把带 git 冲突标记的记忆文件按"两边都留、去重保序"修好（原子写）。返回是否动了文件。"""
    p = Path(path) if path else MEMORY_FILE
    if not p.exists():
        return False
    text = p.read_text(encoding="utf-8")
    if "<<<<<<<" not in text:
        return False
    ours: list[str] = []
    theirs: list[str] = []
    side = "both"
    for line in text.splitlines(keepends=True):
        if line.startswith("<<<<<<<"):
            side = "ours"
        elif line.startswith("=======") and side == "ours":
            side = "theirs"
        elif line.startswith(">>>>>>>"):
            side = "both"
        elif side == "ours":
            ours.append(line)
        elif side == "theirs":
            theirs.append(line)
        else:
            ours.append(line)
            theirs.append(line)

    def _parse(lines: list[str]) -> list[str]:
        try:
            data = json.loads("".join(lines))
        except json.JSONDecodeError:
            return []
        return [str(x) for x in data] if isinstance(data, list) else []

    _io.atomic_write_json(p, merge_facts(_parse(ours), _parse(theirs)), indent=2)
    return True


if __name__ == "__main__":  # 用法：python -m harness.memory merge [memory.json 路径]
    import sys
    if len(sys.argv) >= 2 and sys.argv[1] == "merge":
        target = Path(sys.argv[2]) if len(sys.argv) >= 3 else MEMORY_FILE
        print("已合并去重。" if resolve_conflict_file(target) else "无冲突标记，未改动。")
    else:
        print("用法：python -m harness.memory merge [memory.json 路径]")
```

- [ ] **Step 4: 跑新测试确认通过**

Run: `python3 -m unittest tests.test_m0.记忆合并 -v`
Expected: 两条 PASS。

- [ ] **Step 5: .gitignore 让 memory.json 入库**

`.gitignore` 中 `memory.json*` 一行改为：

```
memory.json.*
```

（`memory.json` 本体入库随 git 同步；`memory.json.tmp` / `memory.json.corrupt*` 仍忽略。当前仓库尚无 memory.json 运行残留，首次生成后如实入库；**首提前需用户过目内容确认无敏感信息**——这是记忆透明纪律的一部分。）

- [ ] **Step 6: 全量回归 + Commit**

Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3`
Expected: `Ran 87 tests`，`OK`。

```bash
git add -A
git commit -m "M0：记忆合并命令（python -m harness.memory merge）+ memory.json 入库随双机同步

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 私有远程与双机同步纪律

**Files:**
- Modify: `README.md`（追加「双机同步」小节）
- 仓库运维：git remote / push（需用户提供私有仓库地址）

- [ ] **Step 1: 推送前安全自检**

```bash
git ls-files | grep -E '(^|/)\.env$'
git log --all -S 'sk-kimi' --oneline
```

Expected: 两条命令都**无输出**（.env 从未被跟踪、密钥从未进过任何提交——本会话已核验过一次，推送前再走一遍仪式）。

- [ ] **Step 2: ⏸ 用户操作——创建私有仓库**

**此步暂停，等用户**：在 GitHub（或 Gitee）创建一个**私有**空仓库（不要初始化 README），把仓库地址（`https://...git` 或 `git@...git`）发回来。

- [ ] **Step 3: 接远程并推送**

```bash
git remote add origin <用户提供的地址>
git push -u origin main
```

Expected: 推送成功；到网页上确认仓库属性为 Private、文件列表里**没有 .env**。

- [ ] **Step 4: README 写下双机同步纪律**

`README.md` 末尾追加：

```markdown
## 双机同步（Mac + Windows）

- 代码与记忆（`memory.json`）走本私有仓库：**每次动手前先 `git pull`，收工 `git push`**。
- `.env`（密钥）永不进 git，换机走 U 盘等私密渠道。
- `memory.json` 若出现 git 冲突：跑 `python -m harness.memory merge`（两边都留、自动去重），再正常提交。
- 会话存档（`.session/`）、日志（`logs/`）、定时任务登记是本机私有，不同步。
```

- [ ] **Step 5: Commit + push**

```bash
git add README.md
git commit -m "M0：README 增双机同步纪律

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 5: CONTRACT.md 增 M0 契约段 + 收尾验收

**Files:**
- Modify: `CONTRACT.md`（文件末尾追加）

- [ ] **Step 1: 追加 M0 契约**

`CONTRACT.md` 末尾追加：

```markdown
---

# M0 · 换机闭环（v2 第一块）· 契约

## 1. 多了什么
v1 从「只在 Windows 可信」变成「Mac + Windows 双平台可信」，并接上双机私有 git 同步。

## 2. 对外行为（你能验收的）
| 你做什么 | 它应该 |
|---|---|
| 任一台机器上跑 `python -m unittest discover -s tests -v` | 87 条全绿（2 条实链无 key/网络自动跳过） |
| 缺 key 启动 | 错误提示指向本机真实的 .env 路径，而非写死的 D:\ |
| memory.json 出现 git 冲突后跑 `python -m harness.memory merge` | 两边记忆都保留、去重、文件恢复为合法 JSON |
| 在符号链接指向的工作区里用文件工具 | 不误判「越出工作区」；真越界依然被拒 |

## 3. 关键决定
- 权限层比对路径时展开 ROOT（macOS /var 符号链接免疫；对生产同样生效）。
- `memory.json` 入 git 随双机同步（首提前用户过目）；`.env`、会话、日志、任务登记不同步。
- 文档表述双平台化；《离生产级还差什么》保留 v1 时代原文不改。

## 4. 已知取舍
- 双机同步靠纪律（先 pull 后动手）而非工具强制；记忆冲突有 merge 命令兜底。
- Windows 侧全绿验证留待用户下次在原机执行（clone → 拷 .env → 跑测试）。
```

- [ ] **Step 2: 全量回归**

Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3`
Expected: `Ran 87 tests`，`OK`。

- [ ] **Step 3: Commit + push**

```bash
git add CONTRACT.md
git commit -m "M0 收尾：契约落档——双平台可信基线 + 双机同步

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 4: 用户亲自验收清单（交付给用户执行）**

1. 仓库根目录跑 `python3 -m unittest discover -s tests -v` → 87 条全绿；
2. `python3 run.py` 说「帮我看看 README 讲了啥」→ 正常读文件并总结（真机链路）；
3. 跑 `python3 -m harness.memory merge` → 显示「无冲突标记，未改动。」；
4. 【下次到 Windows 原机】`git clone <私有仓库>` → 拷入 `.env` → 跑测试全绿。

---

## Self-review 记录

- **Spec 覆盖**：M0 四项交付（修红/清残留/git 同步/记忆合并）分别对应 Task 1/2/4+3/3；spec 决策 2「memory.json 从 .gitignore 摘出 + 用户过目」在 Task 3 Step 5。
- **无占位符**：所有代码/命令/预期输出均为实文。
- **类型一致**：`merge_facts(*fact_lists) -> list[str]`、`resolve_conflict_file(path) -> bool` 在测试与实现中签名一致；`_root()` 仅 permission.py 内部使用。
- **测试计数**：82（存量）+ 2（Task1）+ 1（Task2）+ 2（Task3）= 87，各 Task 的 Expected 与之一致。
