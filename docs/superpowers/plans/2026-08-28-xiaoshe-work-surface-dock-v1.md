# 小蛇工作现场侧舱 V1 实施计划

**状态：** 2026-08-28 本地工程主线完成；浏览器手动交互、目标显示器和跨平台视觉复验为 `release-held`。

## 目标与范围

在不改变老版三栏基线、不修改 `runtime/xiaoshe-legacy/ui` 的前提下，把中央任务区扩展为可选的“对话 / 工作现场”分屏。V1 只交付显示与用户手动操作：

- 从 DSH 当前会话公开快照中的结构化工具结果登记网页、文件、图片、视频、PDF、终端和桌面现场；
- 多标签、关闭、固定、刷新、复制安全来源、外部打开、拖动调宽与会话级恢复；
- 仅允许无凭据的 loopback HTTP(S) 页面内嵌；外部、带敏感参数或不安全协议明确降级；
- 文件读取、diff 和终端输出使用 DSH 已持久化的结构化结果，只读展示，不新增任意文件读取 HTTP 口；
- 窄屏使用覆盖式现场，不制造永久第四栏。

V1 不实现“小蛇接管操作”。现有桌面桥、权限、审批和完成凭证保持原样；本轮不调用屏幕、鼠标、键盘或系统授权界面。

## 边界与数据流

1. `@xiaoshe/runtime-contract` 定义 `WorkSurfaceRegistry` 与可判别的只读视图。
2. `@xiaoshe/runtime-dsh-provider` 从当前 DSH Session 的 `ToolResultNode`、`callView`、`resultView` 投影现场；不解析助手自然语言来猜现场。
3. `@xiaoshe/native-shell-legacy-adapted` 只消费公开 Registry。会话级 UI 偏好仅保存 surface id、宽度、开合与固定状态，不保存 URL、路径、输出或凭据。
4. 历史回放由 DSH 会话快照重新投影，所以跨刷新恢复不复制 Session Log，也不创建第二事实源。

## 威胁模型

- URL 用户信息、敏感 query、hash、非 HTTP(S) 协议一律不可内嵌；显示值必须脱敏。
- 只有精确 `localhost`、`127.0.0.1`、`[::1]` 可内嵌；其他地址只提供明确的外部打开降级。
- iframe 使用最小 sandbox、`no-referrer`，不允许顶层导航；“仅观看”模式阻断页面指针输入。
- 输出、文本、行数和现场数量有硬上限，避免历史会话拖垮界面。
- 不新增任意本地路径读取端点，不持久化文件内容、终端输出或 URL。

## 测试与验收

- Product 契约：类型、状态、能力与快照稳定性。
- Provider：结构化 web/read/diff/terminal/media 投影、loopback 判断、凭据脱敏、边界上限、会话切换与订阅释放。
- Client：自动出现、关闭/固定/恢复、宽度约束、嵌入与安全降级、窄屏契约。
- 工程门禁：三个相关包 typecheck/build/test、根 `pnpm check`、正式 Profile 静态资源与端点。
- 本轮不抢占前台，因此真实浏览器点击、目标显示器主观视觉、外部页面 CSP/XFO 行为和用户手动交互保留为明确 `release-held`，不得以单测冒充。

## 回滚点

侧舱关闭时 DOM 与布局回到既有三栏；Product 契约和 Provider 都是新增服务。回滚只需从正式 Client 注入中移除 `workSurfaceRegistry` 并删除中央分屏渲染，不影响会话、工具、审批、记忆或桌面桥。

## 实施结果

- 契约、DSH Provider、正式 adapted Client、会话级偏好与响应式样式均已落盘。
- 全工作区 typecheck/test/build 与根 `pnpm run check` 均通过；结构化验收见 `docs/evidence/work-surface-dock-v1/acceptance.md`。
- Phase 7 离线工件已重建，侧舱代码随正式 Product 闭包跨设备交付。
- 本轮遵守“不要抢电脑控制权”：未打开浏览器，未调用屏幕、鼠标、键盘或桌面动作。
