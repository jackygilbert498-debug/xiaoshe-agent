# 轻量交接包完整性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通 Git clone 能完整取得 v15 交接说明、体验优化基线、报告交付物、源材料、报告工具链与对标壳固定版本恢复入口，同时不把约 560 MB 的三套对标源码镜像或嵌套 `.git` 带进主仓库。

**Architecture:** 仓库只保存“可审阅的小文件 + 可重复恢复的清单/脚本”。体验优化原始资料按精确白名单复制到工作包的 `体验优化基线/`；三套对标壳只在 `对标壳清单.json` 固定 URL/commit，由纯标准库 Python 脚本恢复到被精准忽略的 `对标壳源码/`。恢复脚本把已存在但版本不匹配的目录视为错误，不静默覆盖用户文件。

**Tech Stack:** Git、PowerShell 7/Windows PowerShell、Python 3.10+ 标准库（argparse/json/pathlib/subprocess/unittest）。

## Global Constraints

- 仓库根：`C:\Users\example\Desktop\Harness交接\Harness交接`；当前分支：`codex/handoff-ux-p0`。
- 本计划必须在 Windows/契约计划和 P0 UX 计划之前完成。
- 不跟踪 `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/对标壳源码/` 下任何文件，不引入 Git LFS/submodule，不提交嵌套 `.git`。
- 不复制 `体验优化/体验优化/源代码/` 与 `Kimi_Agent_商用体验优化方案/`，因为前者是旧快照，后者已在新工作包的报告源材料中有更新版本。
- 不读取、复制或提交 `.env`、token、日志、会话状态和模型依赖。
- 文件复制是文档交付动作，不需要先造单元测试；清单解析和仓库恢复逻辑必须 TDD。
- 每个任务完成后都要看 `git status --short`，不得顺手纳入范围外文件。

---

### Task 1: 精准忽略三套本地镜像并复制体验基线

**Files:**
- Modify: `.gitignore`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/README.md`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/00-导读.md`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/01-项目与体验现状总览.md`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/02-浏览器界面代码级走查.md`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/03-终端与启动体验走查.md`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/04-设计系统与视觉资产.md`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/05-已知体验问题与摩擦点清单.md`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/06-体验决策背景与设计迭代史.md`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/现状截图/ui-亮主题-云白薄荷流光.png`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/现状截图/ui-暗主题-暗夜影院.png`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/现状截图/ui-组件测试台-dev.png`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/设计素材/bplus-empty.png`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/设计素材/fresh-L4-云白薄荷流光.png`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/设计素材/竞品截图索引-说明.md`

- [ ] **Step 1: 先验证现状确实会纳入镜像**

Run:

```powershell
git check-ignore -q -- 'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/对标壳源码/Kimi/README.md'
if ($LASTEXITCODE -ne 0) { throw 'RED：镜像路径目前尚未被忽略' }
```

Expected: 命令抛出 `RED：镜像路径目前尚未被忽略`，证明当前 `.gitignore` 尚未保护镜像目录。

- [ ] **Step 2: 在 `.gitignore` 增加单一、精准规则**

追加：

```gitignore

# 体验优化专项的三套对标壳本地镜像：由固定 commit 清单恢复，不进主仓库
docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/对标壳源码/
```

Run:

```powershell
git check-ignore -v -- 'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/对标壳源码/Kimi/README.md'
```

Expected: 输出命中刚加入的精准规则；不得出现覆盖整个 `docs/handoff/` 的宽泛规则。

- [ ] **Step 3: 按白名单复制 13 个基线文件**

```powershell
$source = 'C:\Users\example\Desktop\体验优化\体验优化'
$dest = 'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线'
New-Item -ItemType Directory -Force -Path $dest, "$dest/现状截图", "$dest/设计素材" | Out-Null
$files = @(
  '00-导读.md','01-项目与体验现状总览.md','02-浏览器界面代码级走查.md',
  '03-终端与启动体验走查.md','04-设计系统与视觉资产.md',
  '05-已知体验问题与摩擦点清单.md','06-体验决策背景与设计迭代史.md',
  '现状截图/ui-亮主题-云白薄荷流光.png','现状截图/ui-暗主题-暗夜影院.png',
  '现状截图/ui-组件测试台-dev.png','设计素材/bplus-empty.png',
  '设计素材/fresh-L4-云白薄荷流光.png','设计素材/竞品截图索引-说明.md'
)
foreach ($rel in $files) { Copy-Item -LiteralPath (Join-Path $source $rel) -Destination (Join-Path $dest $rel) }
```

- [ ] **Step 4: 写基线索引并做逐文件哈希验证**

`体验优化基线/README.md` 必须说明：来源目录、复制日期、13 项白名单、为何排除旧源码快照/重复报告、图片仅作设计参照且不得擅改品牌几何。

Run:

```powershell
$source = 'C:\Users\example\Desktop\体验优化\体验优化'
$dest = 'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线'
$files = @(
  '00-导读.md','01-项目与体验现状总览.md','02-浏览器界面代码级走查.md',
  '03-终端与启动体验走查.md','04-设计系统与视觉资产.md',
  '05-已知体验问题与摩擦点清单.md','06-体验决策背景与设计迭代史.md',
  '现状截图/ui-亮主题-云白薄荷流光.png','现状截图/ui-暗主题-暗夜影院.png',
  '现状截图/ui-组件测试台-dev.png','设计素材/bplus-empty.png',
  '设计素材/fresh-L4-云白薄荷流光.png','设计素材/竞品截图索引-说明.md'
)
foreach ($rel in $files) {
  $a = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $source $rel)).Hash
  $b = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $dest $rel)).Hash
  if ($a -ne $b) { throw "hash mismatch: $rel" }
}
```

Expected: 零输出、退出码 0。

- [ ] **Step 5: 审计暂存范围**

```powershell
git status --short
git status --short --ignored | Select-String '对标壳源码'
```

Expected: 工作包和 v15 仍未跟踪，`对标壳源码/` 只以 ignored 显示；不得出现其子仓库文件。

---

### Task 2: 用单元测试钉住恢复工具的安全边界

**Files:**
- Create: `tests/test_restore_benchmarks.py`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/对标壳清单.json`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/报告工具链/restore_benchmarks.py`

- [ ] **Step 1: 写失败测试**

`tests/test_restore_benchmarks.py` 使用 `importlib.util.spec_from_file_location` 从中文路径加载脚本，至少含以下测试：

```python
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/报告工具链/restore_benchmarks.py"


def load_tool():
    spec = importlib.util.spec_from_file_location("restore_benchmarks", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class 恢复对标壳(unittest.TestCase):
    def test_清单缺字段立即拒绝(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "manifest.json"
            p.write_text(json.dumps({"repos": [{"name": "Kimi"}]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "url.*commit"):
                tool.load_manifest(p)

    def test_dry_run不创建目录且返回三个计划动作(self):
        tool = load_tool()
        entries = [{"name": "Kimi", "url": "https://example.invalid/k.git", "commit": "a" * 40}]
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "repos"
            results = tool.restore_all(entries, target, dry_run=True)
            self.assertEqual(results[0]["action"], "clone")
            self.assertFalse(target.exists())

    def test_已存在但非git目录不覆盖(self):
        tool = load_tool()
        entries = [{"name": "Kimi", "url": "https://example.invalid/k.git", "commit": "a" * 40}]
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "repos"
            (target / "Kimi").mkdir(parents=True)
            (target / "Kimi" / "mine.txt").write_text("do not delete", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "不是 Git 仓库"):
                tool.restore_all(entries, target)
            self.assertTrue((target / "Kimi" / "mine.txt").exists())

    def test_本地仓库可切到固定commit并核对HEAD(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            origin = base / "origin"
            origin.mkdir()
            subprocess.run(["git", "init"], cwd=origin, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=origin, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=origin, check=True)
            (origin / "README.md").write_text("v1", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=origin, check=True)
            subprocess.run(["git", "commit", "-m", "one"], cwd=origin, check=True, capture_output=True)
            commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=origin, check=True,
                                    capture_output=True, text=True).stdout.strip()
            target = base / "restored"
            result = tool.restore_all([{"name": "Kimi", "url": str(origin), "commit": commit}], target)
            self.assertEqual(result[0]["head"], commit)
            self.assertEqual(subprocess.run(["git", "rev-parse", "HEAD"], cwd=target / "Kimi",
                                            check=True, capture_output=True, text=True).stdout.strip(), commit)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `py -3 -m unittest tests.test_restore_benchmarks -v`

Expected: import/file-not-found ERROR，因为脚本尚不存在。

---

### Task 3: 实现固定 commit 清单与幂等恢复脚本

**Files:**
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/对标壳清单.json`
- Create: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/报告工具链/restore_benchmarks.py`
- Modify: `tests/test_restore_benchmarks.py`（仅在真实接口差异需要时收紧断言，不降低安全断言）

- [ ] **Step 1: 写固定清单**

```json
{
  "schema_version": 1,
  "repos": [
    {"name": "Kimi", "url": "https://github.com/MoonshotAI/kimi-code.git", "commit": "93f16c32d71d974f30c3ea3b1134691936ac5f53"},
    {"name": "cc-haha", "url": "https://github.com/NanmiCoder/cc-haha.git", "commit": "6e6c87aa169ad45f8a1a745ad8dcdf51b8559ee1"},
    {"name": "CodeWhale", "url": "https://github.com/Hmbown/CodeWhale.git", "commit": "542719b14a9ddf84fd3b0b0a362d67475292d7d4"}
  ]
}
```

- [ ] **Step 2: 实现脚本的公共接口**

`restore_benchmarks.py` 必须暴露三个可测试入口：`load_manifest(path: Path) -> list[dict]`、
`restore_all(entries: list[dict], target: Path, dry_run: bool = False, run=subprocess.run) -> list[dict]`
和 `main(argv: list[str] | None = None) -> int`。

实现规则：

1. 清单只接受 `schema_version == 1`，`name/url/commit` 均为非空字符串，commit 必须匹配 40 位小写十六进制；名称不得含 `/`、`\`、`..`。
2. `--target` 默认是清单同目录下的 `对标壳源码`；`--dry-run` 不创建目录、不访问网络，只打印动作。
3. 目标子目录不存在时执行 `git clone --no-checkout <url> <dir>`；存在时必须是 Git 工作树且 `remote.origin.url` 等于清单 URL，否则报错并保留原目录。
4. 用 `git fetch origin <commit>` 补齐对象，再执行 `git checkout --detach <commit>`；不执行 reset/clean，不删除失败或部分下载。
5. 最后 `git rev-parse HEAD` 必须精确等于清单 commit，否则非零退出。
6. 每个仓库打印 `[clone|fetch|verify] name commit`，异常带仓库名并让进程返回 1。

- [ ] **Step 3: 跑单测确认通过**

```powershell
py -3 -m unittest tests.test_restore_benchmarks -v
```

Expected: 4 tests，OK。

- [ ] **Step 4: 验证真实清单的 dry-run**

```powershell
py -3 'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/报告工具链/restore_benchmarks.py' --dry-run
```

Expected: 精确列出 Kimi、cc-haha、CodeWhale 三个 clone/verify 计划；不改现有 `对标壳源码/`。

- [ ] **Step 5: Commit 恢复工具（先提交可独立审查的逻辑）**

```powershell
git add -- .gitignore tests/test_restore_benchmarks.py 'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/对标壳清单.json' 'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/报告工具链/restore_benchmarks.py'
git commit -m 'feat(handoff): add pinned benchmark restore tool'
```

---

### Task 4: 纳入工作包、v15 和完整性说明

**Files:**
- Modify: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/README.md`
- Modify: `docs/handoff/换机手册-v15-壳化转型工作包.md`
- Add: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/交付物/**`
- Add: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/报告源材料/**`
- Add: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/报告工具链/**`
- Add: `docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/**`

- [ ] **Step 1: 更新两份入口文档**

工作包 README 与 v15 必须写清：

- 当前优先事实源：报告 `xiaoshe-ux-report-v2.agent.final.md`，设计决策见 `docs/superpowers/specs/2026-08-02-handoff-ux-p0-design.md`。
- `体验优化基线/` 是精确白名单副本；`对标壳源码/` 是本地可恢复缓存，不是交付文件。
- 恢复命令：`py -3 报告工具链/restore_benchmarks.py [--target PATH] [--dry-run]`。
- 恢复失败时保留已下载内容；URL/commit 不符必须人工处理，脚本不覆盖。
- 接续施工顺序：本计划 → Windows/契约计划 → P0 UX 计划。

- [ ] **Step 2: 暂存精确范围并确认无嵌套仓库/大文件**

```powershell
git add -- 'docs/handoff/换机手册-v15-壳化转型工作包.md' 'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型'
$staged = git diff --cached --name-only
if ($staged -match '对标壳源码/') { throw '镜像源码误入暂存区' }
git diff --cached --summary | Select-String 'mode 160000'
```

Expected: 最后一条命令零命中；暂存列表不含 `对标壳源码/`。

```powershell
$large = git diff --cached --name-only --diff-filter=ACM | ForEach-Object {
  if (Test-Path -LiteralPath $_) { Get-Item -LiteralPath $_ }
} | Where-Object Length -gt 50MB
if ($large) { $large | Format-Table FullName,Length; throw '存在超过 50MB 的暂存文件' }
```

Expected: 零大文件。

- [ ] **Step 3: 验证 clone 所需内容均已跟踪**

```powershell
$required = @(
  'docs/handoff/换机手册-v15-壳化转型工作包.md',
  'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/README.md',
  'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/对标壳清单.json',
  'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/报告工具链/restore_benchmarks.py',
  'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/体验优化基线/00-导读.md',
  'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/交付物/小蛇体验优化专项报告-编码壳范式版.docx'
)
foreach ($p in $required) {
  git cat-file -e ":$p"
  if ($LASTEXITCODE -ne 0) { throw "未暂存交付物: $p" }
}
```

- [ ] **Step 4: 跑恢复工具回归与文档链接检查**

```powershell
py -3 -m unittest tests.test_restore_benchmarks -v
rg -n 'restore_benchmarks.py|体验优化基线|对标壳清单.json' 'docs/handoff/换机手册-v15-壳化转型工作包.md' 'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/README.md'
```

Expected: 单测全绿；两份入口文档均可 grep 到三类入口。

- [ ] **Step 5: Commit 轻量交接包**

```powershell
git commit -m 'docs(handoff): track lightweight UX transition package'
```

- [ ] **Step 6: 最终完整性闸门**

```powershell
git status --short --ignored
git ls-files -- 'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型' | Measure-Object
git ls-files -- 'docs/handoff/专项工作包-2026-08-02-小蛇壳化转型/对标壳源码'
```

Expected: 前两类交付文件已跟踪；最后一条零输出；本地镜像只显示 ignored。
