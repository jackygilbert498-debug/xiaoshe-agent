# G1 · Task 工作台证据索引

本目录只记录可复跑的验收命令与结果摘要；不保存 token、密钥、会话内容或数据库副本。

## 当前实现边界

- 基线提交：`71b11f87a4f2926a5b4ea4607951de7189b8b5ec`。
- 工作树在实施中，证据适用于该提交之上的未提交 Tasking 变更；提交前须重新执行本页全部命令。
- Task 工作台默认关闭：`XIAOSHE_TASKING_V2=off`。`on` 启用 SQLite 与 v2 API；`shadow` 不打开数据库也不挂载 UI。
- 数据库：`.state/tasking/tasks.db`（当前 schema v3）；旧 v1/v2 数据库升级前自动复制到同级 `backups/<UTC>-v<旧版本>/`，高版本数据库拒绝打开。

## 已验证（macOS · Python 3.13）

执行日期：2026-08-03。

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/miniconda3/bin/python3.13 -X utf8 -W error::ResourceWarning \
  -m unittest tests.test_task_model tests.test_task_store tests.test_task_engine \
  tests.test_task_run_adapter tests.test_task_session_metadata tests.test_session_import \
  tests.test_task_api tests.test_tasking_feature_flag tests.test_tasking_baseline \
  tests.test_rounds_boundary tests.test_effects tests.test_effects_irreversible -v
```

结果：`74 tests OK`（退出码 0）。覆盖状态闭集、50 轮乐观并发、20 并发创建/导入、原子事件、Run attempt/active run、异常工具闭合、旧会话幂等导入、v2 REST、REST/WS 同一事件序列化、事件补拉、off/on/shadow，以及 UTF-8/环境不可判定出口。测试中出现的“环境不可判定”一行来自受控失败分支断言，并非本次回归失败。

```sh
node --test tests/tasking_store.test.mjs
```

结果：`3 pass / 0 fail`。覆盖项目局部派生、重复事件忽略、seq gap 触发 REST 重同步，以及重同步后旧序号不残留。

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/miniconda3/bin/python3.13 -X utf8 scripts/smoke_serve.py
```

结果：`33 PASS / 0 FAIL`。覆盖真实 loopback 服务、WS、REST、ETag、安全门与 CSP（假模型，不调用外部供应商）。

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/miniconda3/bin/python3.13 -X utf8 tests/ui_contract/validate_contract.py
```

结果：`0 ERROR / 0 WARN`。

浏览器验收（macOS 本机 loopback、临时 state 目录、假模型、无敏感数据提交）：

- `on`：创建“浏览器验收任务”后未 reload（navigation=1），详情呈现中文“草稿”与机器锚点 `Draft`，`project-switcher`、`task-title`、`task-state` 均存在；“＋ 新任务”弹出可访问表单，填写验收标准后按钮切为“创建任务”。
- `on`：当前会话可预览并导入为草稿任务；导入弹窗明确提供“继续旧会话 / 导入为任务”，导入后所有 12 个状态组均显示计数。
- `390px`：侧栏默认收起时，聊天头的“任务”按钮可展开工作台，`new-task` 可见并可操作。
- `off`：任务工作台不渲染，旧会话 UI 正常。

冻结产物哈希（SHA-256）：

- `docs/baselines/tasking-g0.json`：`4c238d4397833f7a00a36e3a1e555a48437e2aaee16b1bda36a318cafc5c678c`
- `tests/fixtures/tasking/schema_v1.sql`：`c3a4c474d05472986434099bd2b54d06bed2ad294f251824332a43a51c6145f4`
- `tests/ui_contract/fixtures/task_v2_events.json`：`fd5a326884ac00a7a6143fff75d04a05226ad6dc5059256a3e4386b3536cf947`
- `tests/ui_contract/fixtures/task_v2_responses.json`：`4dd12de64b665c2ad70a6f475af0510cbd6041f0a053bae93704cd006802ea0b`

## Windows 原生复现（发布前必过）

在 Windows PowerShell、仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify_windows.ps1
```

脚本会强制 `PYTHONUTF8=1`，并依次运行 UI 契约、Task 前端缓存测试、服务烟测、协议 E2E 与完整 `unittest discover`。当前 macOS 环境没有 PowerShell/Windows 文件系统，不能把交叉平台静态检查冒充为 Windows 原生通过；该命令的退出码和原始日志是 G1 的最后平台证据。

## 追溯矩阵

| 要求 | 直接证据 |
| --- | --- |
| 状态与版本冲突原子性 | `tests.test_task_engine`、`tests.test_task_store` |
| Run 与旧 Agent 兼容 | `tests.test_task_run_adapter`、`tests.test_task_session_metadata` |
| 旧 Session 不破坏 | `tests.test_session_import`、会话预览/导入 API |
| REST/WS 可重同步 | `tests.test_task_api`、`tests/tasking_store.test.mjs`、`scripts/smoke_serve.py` |
| off/shadow 回退 | `tests.test_tasking_feature_flag`、浏览器 off 验收 |
| UI 不解析聊天文本 | `ui/js/tasking/store.js` 仅接收 v2 snapshot/event；`TASK_STATUS`/`TASK_EVENT_TYPE` 三方契约镜像 |
| 中文与契约 | `tests.test_tasking_baseline`、`-X utf8` 命令、`tests/ui_contract/validate_contract.py` |
