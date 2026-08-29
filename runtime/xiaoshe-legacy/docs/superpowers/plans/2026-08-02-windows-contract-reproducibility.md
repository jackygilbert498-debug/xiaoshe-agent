# Windows 与契约可复现基线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让契约夹具在新 clone 中可得且校验为零错误，并让 Windows 通过一个入口稳定复现契约、serve smoke、E2E 与全量单测结果。

**Architecture:** 先修仓库卫生层：用 `.gitignore` 精确反向例外纳入 `state.json` 夹具，并补齐已经由校验器要求的 `autonomy/model`。再只修测试的跨平台假设：Mac 单元测试用注入 runner 时注入一个存在的 `sandbox-exec` 路径，Windows 不创建非法文件名；Docker 断言跟随生产的正斜杠规范化；curl 输出黑洞用 `os.devnull`。生产沙箱的 fail-closed 检查不放宽。最后由 `scripts/verify_windows.ps1` 设置 UTF-8 并串起四道门。

**Tech Stack:** Python 3.10+ 标准库/unittest、PowerShell、Git、现有 smoke/E2E 工具。

## Global Constraints

- 前置条件：`2026-08-02-handoff-package-integrity.md` 已完成并提交。
- 不修改契约 v1 的事件、路由、枚举或审批语义；只补回当前校验器已要求的 fixture 字段。
- 不弱化 `harness/sandbox.py` 对真实 `/usr/bin/sandbox-exec` 缺失时的 fail-closed；跨平台修复应落在测试夹具/注入边界。
- 不用 `PYTHONIOENCODING` 隐式污染用户环境；验证脚本只在自身进程范围设置 `PYTHONUTF8=1`。
- 当前已知 Windows 基线（修复前）：`Ran 2237 tests`，3 failures、14 errors、43 skipped、3 expected failures。主要成因已逐项定位，实施时先复现再改。
- 修改行为测试要先红后绿；纯文档和 PowerShell 入口可用命令级验收代替单元测试。

---

### Task 1: 让契约 `state.json` 成为可追踪、可验证的 fixture

**Files:**
- Modify: `.gitignore`
- Modify/Add: `tests/ui_contract/fixtures/state.json`
- Create: `tests/test_repository_hygiene.py`

- [ ] **Step 1: 写失败测试，钉住 fixture 不得再被通用规则吞掉**

```python
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = Path("tests/ui_contract/fixtures/state.json")


class 仓库卫生(unittest.TestCase):
    def test_契约state夹具不被gitignore吞掉(self):
        proc = subprocess.run(
            ["git", "check-ignore", "-q", "--", FIXTURE.as_posix()],
            cwd=ROOT,
        )
        self.assertEqual(proc.returncode, 1, "契约 fixture 必须能进入普通 clone")

    def test_state夹具含当前快照附加键(self):
        doc = json.loads((ROOT / FIXTURE).read_text(encoding="utf-8"))
        self.assertIs(type(doc.get("autonomy")), bool)
        self.assertIsInstance(doc.get("model"), str)
        self.assertTrue(doc["model"].strip())
```

- [ ] **Step 2: 跑测试和契约校验确认红灯**

```powershell
py -3 -m unittest tests.test_repository_hygiene -v
py -3 tests/ui_contract/validate_contract.py
```

Expected: 第一条至少 `test_契约state夹具不被gitignore吞掉` FAIL；校验器报告：

```text
state.json.autonomy 应为 bool
state.json.model 应为非空字符串
```

- [ ] **Step 3: 加精确反向例外并补 fixture**

在 `.gitignore` 的 `state.json` 紧邻位置加入：

```gitignore
state.json
!tests/ui_contract/fixtures/state.json
```

在 `tests/ui_contract/fixtures/state.json` 顶层加入（建议放在 `server_time` 后）：

```json
"autonomy": false,
"model": "kimi-for-coding",
```

同时更新 `$doc`，明确两键是 UI 批次 D 的会话级快照附加键，不落盘。

- [ ] **Step 4: 验证绿灯并确认 Git 可见**

```powershell
py -3 -m unittest tests.test_repository_hygiene -v
py -3 tests/ui_contract/validate_contract.py
git check-ignore -v -- 'tests/ui_contract/fixtures/state.json'
git status --short -- 'tests/ui_contract/fixtures/state.json'
```

Expected: tests OK、契约 `0 ERROR / 0 WARN`；`git check-ignore -v` 显示 negation 规则或返回非 ignored，`git status` 显示 fixture 可添加。

- [ ] **Step 5: Commit**

```powershell
git add -- .gitignore tests/ui_contract/fixtures/state.json tests/test_repository_hygiene.py
git commit -m 'fix(contract): track complete state fixture'
```

---

### Task 2: 修正 Mac seatbelt 单测在 Windows 上的注入边界

**Files:**
- Modify: `tests/test_sandbox_mac.py`

- [ ] **Step 1: 复现失败并记录生产检查先于 runner 的事实**

Run: `py -3 -m unittest tests.test_sandbox_mac.单元_契约与profile生成 -v`

Expected: Windows 上多数测试 ERROR，原因是 `_MAC_SANDBOX_EXEC=/usr/bin/sandbox-exec` 不存在，尚未走到注入 runner；恶意引号路径还可能先被 Windows 文件系统以非法名称拒绝。

- [ ] **Step 2: 在单元测试 setUp 注入“存在的可执行文件”，不改生产代码**

在 import 区加入 `import sys`，在 `单元_契约与profile生成` 类开头加入：

```python
def setUp(self):
    self._sandbox_exec = mock.patch.object(
        sandbox, "_MAC_SANDBOX_EXEC", sys.executable
    )
    self._sandbox_exec.start()
    self.addCleanup(self._sandbox_exec.stop)
```

已有 `test_sandbox_exec缺失_fail_closed` 继续在测试体内将常量 patch 成 `/nonexistent/sandbox-exec`，因此真实缺失的安全断言不丢。

- [ ] **Step 3: 把恶意路径用例移到纯字符串边界，不在 Windows 创建非法文件名**

将 `test_恶意workdir路径注入_fail_closed` 改为直接断言 `_sbpl_path`，用 mock 控制 `os.path.realpath`：

```python
def test_恶意workdir路径注入_fail_closed(self):
    for evil in ('/tmp/evil"(deny default)', "/tmp/evil\n(allow file-read*)", "/tmp/evil\\x"):
        with self.subTest(evil=evil), \
             mock.patch.object(sandbox.os.path, "realpath", return_value=evil):
            with self.assertRaises(sandbox.SandboxError):
                sandbox._sbpl_path(Path("safe-placeholder"))
```

这仍测试同一安全边界：`_sbpl_path` 对引号、换行和反斜杠 fail-closed；只是避免让宿主文件系统先行拦截。

- [ ] **Step 4: 跑目标测试和相关降级链**

```powershell
py -3 -m unittest tests.test_sandbox_mac.单元_契约与profile生成 -v
py -3 -m unittest tests.test_sandbox_docker.单元_降级链 -v
```

Expected: 单元层全绿；仅 Darwin 真机类按装饰器 skip；生产 `harness/sandbox.py` 无 diff。

- [ ] **Step 5: Commit**

```powershell
git add -- tests/test_sandbox_mac.py
git commit -m 'test(sandbox): make Mac unit fakes host-neutral'
```

---

### Task 3: 修正 Docker 挂载断言与 curl 黑洞的 Windows 假设

**Files:**
- Modify: `tests/test_sandbox_docker.py`
- Modify: `tests/test_netguard.py`

- [ ] **Step 1: 复现两个失败**

```powershell
py -3 -m unittest tests.test_sandbox_docker.单元_docker命令行拼装.test_argv含断网内存pids封顶只读根fs与workdir挂载 -v
py -3 -m unittest tests.test_netguard.真机出网行为.test_真机_proxy模式curl白名单内通_白名单外断 -v
```

Expected: Docker 断言把 Windows `Path` 的反斜杠当成期望值，但生产已规范为 `/`；curl 虽得到 HTTP 200，却因 `-o /dev/null` 在 Windows 写出失败而 returncode 23。

- [ ] **Step 2: 改断言与平台黑洞路径**

`tests/test_sandbox_docker.py`：

```python
self.assertEqual(
    argv[argv.index("-v") + 1],
    f"{str(wk).replace(chr(92), '/')}:/work",
)
```

若 lint/可读性允许，也可先声明 `mount_src = str(wk).replace("\\", "/")` 再断言；不要改回生产的正斜杠规范化。

`tests/test_netguard.py`：

```python
proc = subprocess.run(
    ["curl", "-sS", "-m", "5", "-o", os.devnull, "-w", "%{http_code}", url],
    env=env, capture_output=True, text=True, timeout=15,
)
```

- [ ] **Step 3: 运行目标模块**

```powershell
py -3 -m unittest tests.test_sandbox_docker -v
py -3 -m unittest tests.test_netguard -v
```

Expected: Windows 可运行的单元/本地回环测试全绿；平台真机测试只因明确条件 skip。

- [ ] **Step 4: Commit**

```powershell
git add -- tests/test_sandbox_docker.py tests/test_netguard.py
git commit -m 'test(windows): normalize host paths and null sink'
```

---

### Task 4: 建立唯一 Windows 验证入口

**Files:**
- Create: `scripts/verify_windows.ps1`
- Modify: `README.md`
- Modify: `docs/LOCAL_VERIFY.md`
- Modify: `docs/handoff/换机手册-v15-壳化转型工作包.md`

- [ ] **Step 1: 写 PowerShell 验证器**

`scripts/verify_windows.ps1`：

```powershell
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Invoke-VerifyStep {
    param([Parameter(Mandatory)][string]$Name,
          [Parameter(Mandatory)][string[]]$Arguments)
    Write-Host "`n==> $Name"
    & py -3 @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repo
try {
    Invoke-VerifyStep 'UI contract' @('tests/ui_contract/validate_contract.py')
    Invoke-VerifyStep 'Serve smoke' @('scripts/smoke_serve.py')
    Invoke-VerifyStep 'UI E2E' @('scripts/e2e/run_e2e.py')
    Invoke-VerifyStep 'Full unittest' @('-m','unittest','discover','-s','tests','-p','test_*.py','-v')
} finally {
    Pop-Location
}
Write-Host "`nWindows verification PASS"
```

不捕获并吞掉失败；任一子步骤非零即停止，最后 PASS 只能在四道门全部成功后输出。

- [ ] **Step 2: 在三份文档统一同一入口**

三处均使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify_windows.ps1
```

`docs/LOCAL_VERIFY.md` 同时修正过时的“tests 只有两套/74 条”描述：本仓库包含全量测试；测试总数是运行结果，不在文档硬编码易漂移数字。保留 Unix 分步命令，但 Windows 只推荐上述入口。

- [ ] **Step 3: 运行入口（这是本计划的完整验证）**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify_windows.ps1
```

Expected:

- 契约校验 `0 ERROR / 0 WARN`；
- serve smoke PASS；
- UI E2E PASS；
- 全量 unittest 无 failure/error；
- Mac/Linux 真机用例仅按既有 `skipUnless` 跳过；既有 expected failures 保持 expected，不改成硬通过。

- [ ] **Step 4: 确认 UTF-8 修复覆盖 eval emoji，而未改测试内容**

```powershell
$env:PYTHONUTF8='1'
py -3 -m unittest tests.test_eval -v
git diff -- tests/test_eval.py
```

Expected: `tests.test_eval` 4 条 PASS；第二条零 diff。

- [ ] **Step 5: Commit**

```powershell
git add -- scripts/verify_windows.ps1 README.md docs/LOCAL_VERIFY.md 'docs/handoff/换机手册-v15-壳化转型工作包.md'
git commit -m 'test(windows): add reproducible verification gate'
```

---

### Task 5: 本阶段收口审计

**Files:**
- Verify only

- [ ] **Step 1: 从干净进程重跑总入口**

```powershell
Remove-Item Env:PYTHONUTF8 -ErrorAction SilentlyContinue
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify_windows.ps1
```

Expected: 仍为 PASS，证明脚本自己建立 UTF-8 环境。

- [ ] **Step 2: 复核没有弱化生产安全代码**

```powershell
git diff HEAD~4..HEAD -- harness/sandbox.py harness/netguard.py
```

Expected: 零 diff；本阶段跨平台修复只动 fixture、测试和验证入口。

- [ ] **Step 3: 复核仓库状态**

```powershell
git status --short
git log --oneline -4
```

Expected: 只剩下一阶段尚未实施的明确文件；最近提交依次对应契约、Mac 测试、Docker/netguard、Windows 验证入口。
