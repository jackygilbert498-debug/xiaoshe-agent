# Plan 01 — 沙箱、联网与在线心跳控制中心

> 按顺序执行。每个 Task 都必须遵循 RED → GREEN → 自审 → 独立审查 → 精确提交。

**Goal:** 在不削弱权限、效果账本和任务租约安全的前提下，让用户从界面独立控制脚本隔离、工具联网和在线心跳，并提供真正可运行的宿主直接模式。

**Design:** `docs/superpowers/specs/2026-08-09-runtime-controls-product-integration-design.md`

## Global Constraints

- 关闭沙箱必须执行宿主脚本，不能返回“无法运行”或自动退回隔离。
- `sandbox_enabled`、`network_mode`、`heartbeat_enabled` 相互独立；直接模式只是一键组合。
- 沙箱开启时只调用真实隔离后端，不可静默裸跑；沙箱内继续断网。
- 关闭沙箱不绕过 permission、approval、effects、budget、timeout 或 cancellation。
- TaskWorker 租约心跳和 WebSocket 保活不可由新开关关闭。
- 状态只落 `.state/runtime-controls.json`，不写 `.env`、Git 或浏览器长期存储。
- 工作树已有大量继承改动；只暂存精确新增文件/补丁块，不得整文件带入无关差异。

## Task 1 — 持久化运行控制与纯函数网络环境

**Files:**
- Create: `harness/runtime_controls.py`
- Modify: `harness/netguard.py`
- Modify: `harness/execution_environment.py`
- Create: `tests/test_runtime_controls.py`
- Modify: `tests/test_execution_environment.py`

1. RED：覆盖默认值、原子持久化、非法/未知字段拒绝、部分更新、直接模式派生状态和并发读写；覆盖 `off/proxy/open` 环境构造不修改模块全局值。
2. GREEN：实现版本化 `RuntimeControlStore`；把 netguard 子进程环境构造改为显式 mode 输入的纯入口，旧 `session_child_env()` 保持兼容。
3. 验证 DPAPI/模型配置、`.env` 和 Tasking 数据库均未被触碰。
4. 精确暂存本 Task 补丁，独立提交并审查。

## Task 2 — 隔离/宿主执行路由与 Run 冻结策略

**Files:**
- Modify: `harness/sandbox.py`
- Modify: `harness/tools.py`
- Modify: `harness/agent.py`
- Modify: `harness/task_engine.py`
- Modify: `harness/task_worker.py`
- Modify: `harness/ui_server.py`
- Modify/Create focused tests under `tests/`

1. RED：矩阵覆盖沙箱开/关 × 网络 off/proxy/open；验证 ON 只调用隔离后端、OFF 只调用宿主后端且使用独立网络环境；验证 `run_sandboxed` 和已批准 user tool 都遵守同一控制。
2. GREEN：增加显式宿主执行入口，返回 `{backend, isolated, annotation}`；交互 ctx 使用当前快照，TaskWorker 在 Run 启动时把快照冻结进 `policy_json` 并传入普通 Agent runtime。
3. 回归：停止/取消、权限审批、effects、预算、超时和 TaskWorker lease heartbeat 行为不变。
4. 精确暂存补丁块；尤其 `tools.py`、`agent.py`、`task_worker.py` 已有继承差异，不得整文件暂存。

## Task 3 — REST 控制面与“小蛇工坊”系统卡片

**Files:**
- Modify: `harness/ui_server.py`
- Modify: `harness/ui_schema.py`
- Modify: `ui/js/net.js`
- Modify: `ui/js/panels/system.js`
- Modify: `ui/js/main.js` only if panel wiring requires it
- Modify: `ui/styles/panels.css`
- Modify/Create focused UI server and JS contract tests

1. RED：`GET/PATCH /api/runtime-controls` 和 `GET /api/runtime-controls/heartbeat` 的鉴权、校验、返回形状、持久化和不泄密契约；UI 控制事件与风险状态测试。
2. GREEN：系统面板增加“运行控制”卡片，沿用工坊绿/米白风格；脚本隔离、工具联网、在线心跳分别可操作；直接模式以高风险色和明确文案显示。
3. 心跳开启后前端每 15 秒探测一次并显示最后响应；关闭只停止这一探测。任何探测不得写入聊天消息。
4. 真实浏览器验收键盘可达、窄屏不溢出、减少动态效果设置有效；完成独立审查和提交。

## Batch Acceptance

- 运行控制 focused suite 全绿；TaskWorker/lease、sandbox、netguard、UI server 相关回归全绿。
- 实机通过 API 切到直接模式后，受审批脚本在宿主执行；切回沙箱后重新进入 AppContainer。
- 网络 off/open 用不会泄露凭据的本地/外部探针分别验证；结果如实记录。
- 系统面板的最后心跳更新，关闭后停止更新；后台任务租约仍正常续期。
