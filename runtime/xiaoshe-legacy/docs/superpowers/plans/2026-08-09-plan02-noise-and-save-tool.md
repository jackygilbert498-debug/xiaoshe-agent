# Plan 02 — 会话降噪与任务完成后保存工具

> 依赖 Plan 01 完成。每个 Task 都必须遵循 RED → GREEN → 自审 → 独立审查 → 精确提交。

**Goal:** 保留完整审计信息但不再把内部设定铺满聊天流，并让完成任务中的可信新增 PowerShell 脚本可由用户显式保存为待审工具。

**Design:** `docs/superpowers/specs/2026-08-09-runtime-controls-product-integration-design.md`

## Global Constraints

- 普通 system message 只折叠不删除；warn/error alert 继续流内显眼显示。
- 不靠消息文字判断严重性。
- 保存按钮只在 Task `Succeeded` 且存在当前、未 stale、哈希验证成功的 `.ps1` 新增文本 artifact 时出现。
- 保存只调用 `user_tools.propose()`；不批准、不激活、不热加载。
- 不从实时工作区读脚本，不接受 tracked patch、敏感/二进制 artifact 或其他语言。
- 工作树已有继承改动；只暂存本任务精确补丁块。

## Task 1 — 系统消息始终折叠

**Files:**
- Modify: `ui/js/main.js`
- Modify/Create: focused JS/browser regression tests

1. RED：有用户消息时，多条 `role=system` 仍只能渲染一个默认收起的 `.sysfold`；后续 system append 更新计数而不增加独立系统条；warn/error alert 仍为 `.sysalert`。
2. GREEN：复用现有 `sysFoldEl()`，让空态、离开空态、快照重建和实时 append 共用一个同步入口。
3. 保留搜索文本和原始 store 数据；完成键盘/屏幕阅读器标签检查。
4. 精确暂存 `main.js` 的本 Task 补丁块并独立提交、审查。

## Task 2 — 完成任务的工具提案后端

**Files:**
- Create: `harness/task_tool_proposals.py`
- Modify: `harness/task_api.py`
- Modify: `harness/ui_server.py`（显式注入 canonical `.state/user_tools`，避免误写 `.state/tasking/user_tools`）
- Create: `tests/test_task_tool_proposals.py`
- Modify: `tests/test_task_api.py` only where integration coverage is necessary
- Track: clean-checkout focused 验证所必需、当前尚未纳入 Git 的最小直接/传递依赖闭包；单独 prerequisite commit，禁止夹带无关交接差异

1. RED：覆盖成功提案和所有拒绝边界：非 Succeeded、跨任务/非 current ChangeSet、stale、越界 key、非 `.ps1`、敏感/二进制、artifact 篡改、重建 SHA 不符、无效工具定义。
2. GREEN：以固定新增文件 patch 格式恢复原字节并复核 manifest SHA；严格 UTF-8 解码后调用 `user_tools.propose()`。
3. 新增 `POST /api/v2/tasks/{task_id}/tool-proposals`，成功返回 201 pending 提案；错误使用稳定 Tasking 错误码，不泄露脚本正文或路径外信息。
4. 验证 active/manifest 未被写入、当前会话未加载；独立提交与审查。

## Task 3 — 任务完成卡片的“保存为工具”入口

**Files:**
- Modify: `ui/js/tasking/api.js`
- Modify: `ui/js/tasking/inbox.js`
- Create: `ui/js/tasking/tool-proposal-view.js`
- Modify: `ui/styles/panels.css`
- Modify: `harness/task_tool_proposals.py`（提供只读、服务端完整验证的候选列表；不得返回正文或哈希）
- Modify: `harness/task_api.py`（为当前任务暴露候选 GET，与 POST 共用同一验证链）
- Modify: `harness/ui_schema.py`（与前端 `TASK_STATUS` 镜像保持 clean-HEAD 对称）
- Modify/Create focused JS/browser tests

1. RED：只有 Succeeded + 合格候选显示按钮；其他状态或无候选不显示。提交成功文案必须为“已进入待审提案”，不得称“已启用”。
2. GREEN：完成任务详情异步读取由后端对 current ChangeSet、工作区新鲜度、artifact 哈希、敏感路径和脚本字节完整验证后的候选列表，列出候选脚本；前端不得凭 manifest 自行判定可用。表单收集名称、说明和参数；stale/hash/API 错误保留输入并清晰显示。瞬时 availability 失败必须有受控重试，不能永久静默缓存；成功候选也必须使用短 TTL，并在用户点击入口后、打开表单前再次 GET 复验，变化或 409 时隐藏入口且不打开表单。
3. 任务完成优先：按钮不抢占完成流程、不自动弹窗、不自动创建提案。
4. 真实浏览器验收鼠标、键盘、窄屏和错误态；独立提交与审查。

## Batch Acceptance

- 有历史和实时 system message 的会话都只显示一个默认折叠入口；warn/error 仍在流内。
- 走一条真实 Task v2 完成链，新增 `.ps1`，按钮出现；保存后只产生 pending，人工批准前不可调用。
- 篡改 artifact、漂移工作区或改为 `.py` 后按钮/接口均 fail closed。
