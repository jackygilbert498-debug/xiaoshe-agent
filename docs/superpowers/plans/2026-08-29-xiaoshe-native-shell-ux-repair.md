# 小蛇原生产品壳体验修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-08-29 三轮产品体验审计发现的问题，使会话、输入、检查栏、设置、插件与记忆在 Windows 正式壳中形成一致、可解释、可访问的真实体验，并留下可由 macOS 设备继续验收的交接证据。

**Architecture:** `@xiaoshe/native-shell-legacy-adapted` 继续只做公开 Client 服务的组合与呈现；会话、主题、模型、权限、记忆和插件治理仍由各自 Provider 持有事实。壳只保存菜单、焦点、草稿、折叠等瞬时 UI 状态，不建立与 Provider 竞争的影子状态。

**Tech Stack:** TypeScript、React Client plugin、Cordis/DSH 公共 Client 服务、Vitest、CSS、正式 `127.0.0.1:3080` 浏览器验收。

**Spec:** `docs/superpowers/specs/2026-08-27-xiaoshe-native-shell-refinement-settings-memory-design.md`

## Global Constraints

- 旧版小蛇的品牌色、三栏结构、品牌 Logo 与中央舞台仍是视觉母版；只修复已审计的问题。
- 一切业务事实继续由插件公开服务提供；禁止为主题、模型、权限、记忆或插件安装创建壳内影子真源。
- 保留顶层、`runtime/DSH`、`runtime/xiaoshe-legacy` 三个脏工作树；禁止 reset、clean、stash、覆盖或无关重构。
- 新行为先以用户可见合同写失败测试，再实施最小修复；浏览器 DOM、键盘和控制台是最终 Web 验收证据。
- macOS 实机验收不在本机冒充完成，交接记录必须明确标为待另一台设备执行。

---

### Task 1: 统一主题、标题与会话事实

**Files:**
- Modify: `packages/native-shell-legacy-adapted/src/client/index.ts`
- Modify: `packages/native-shell-legacy-adapted/src/client/adapted.css`
- Modify: `packages/native-shell-legacy-adapted/tests/fixture.ts`
- Modify: `packages/native-shell-legacy-adapted/tests/interaction-contract.test.ts`
- Modify: `packages/native-shell-legacy-adapted/tests/client-lifecycle.test.ts`

**Interfaces:**
- Consumes: DSH `theme` 服务的 `getTheme()` / `setTheme()` 与 `theme/change` 事件；`taskTimeline`、Runtime receipt。
- Produces: 单一主题事实、可换行标题事实区、分离的 reasoning、带原因和恢复动作的历史错误卡。

- [x] **Step 1: 写主题、长标题、reasoning 与错误恢复的失败测试**
- [x] **Step 2: 运行聚焦测试并确认缺失行为导致 RED**
- [x] **Step 3: 将壳主题切换接到 `theme` 插件，删除 `xs-theme` 影子偏好**
- [x] **Step 4: 让长标题和状态在窄桌面自然分层，不发生省略冲突**
- [x] **Step 5: 将推理块折叠为可选查看，将失败归属到具体轮次并显示原因、详情与可执行恢复动作**
- [x] **Step 6: 运行聚焦测试至 GREEN**

### Task 2: 让停止、调整方向、斜杠命令与定位控件可理解

**Files:**
- Modify: `packages/native-shell-legacy-adapted/src/client/index.ts`
- Modify: `packages/native-shell-legacy-adapted/src/client/adapted.css`
- Modify: `packages/native-shell-legacy-adapted/tests/interaction-contract.test.ts`
- Modify: `packages/native-shell-legacy-adapted/tests/responsive-state.test.ts`

**Interfaces:**
- Consumes: `agentRuntimeSession.stopRun()`、`sendTurn(..., mode: 'steer')`、`forkSession()` 与现有面板动作。
- Produces: 运行时明确的停止按钮与调整方向模式；可分页的真实命令菜单；当前轮次/新消息可感知的消息导航和回底按钮。

- [x] **Step 1: 写运行态按钮、命令集合、导航计数、回底新消息提示的失败测试**
- [x] **Step 2: 运行测试并确认 RED**
- [x] **Step 3: 在运行态显示明确“停止”与“调整方向”语义，移动端不再隐藏关键说明**
- [x] **Step 4: 将 `/system` 更名为 `/capabilities`，加入真实可执行的 `/compact` 与 `/resume` 时才展示；不可用命令给出原因**
- [x] **Step 5: 重做用户轮次导航的视觉、触摸区域、当前位置与预览，并给回底按钮增加非抢眼的新消息提示**
- [x] **Step 6: 运行聚焦测试至 GREEN**

### Task 3: 修正设置、服务商、插件与记忆的信息架构

**Files:**
- Modify: `packages/native-shell-legacy-adapted/src/client/index.ts`
- Modify: `packages/native-shell-legacy-adapted/src/client/adapted.css`
- Modify: `packages/native-shell-legacy-adapted/tests/interaction-contract.test.ts`
- Modify: `packages/native-shell-legacy-adapted/tests/client-artifact.test.ts`

**Interfaces:**
- Consumes: `modelCatalog`、`pluginGovernance`、`memoryLifecycle` 与已有 settings slots。
- Produces: 用户可理解的模型/服务商与插件目录；无重复导航的设置页；可展开编辑的记忆区。

- [x] **Step 1: 写友好命名、去重计数、设置导航、记忆展开编辑的失败测试**
- [x] **Step 2: 运行测试并确认 RED**
- [x] **Step 3: 将内部模块名、phase、provider id 放入技术详情；主界面只显示用途、状态与来源**
- [x] **Step 4: 区分“已安装插件”“已加载组件”“运行实例”，解释部分启用与不可用原因**
- [x] **Step 5: 去掉设置导航伪序号和重复“能力方案”，只在相关页显示配置文件动作**
- [x] **Step 6: 服务商选择不再默认 Amazon Bedrock，按已配置/可配置分类并禁用未改动保存**
- [x] **Step 7: 记忆栏保留紧凑摘要并提供大编辑面板；创建、修订、遗忘、恢复仍走 Memory Provider**
- [x] **Step 8: 运行聚焦测试至 GREEN**

### Task 4: 完成键盘、读屏、触控与视觉质量修复

**Files:**
- Modify: `packages/native-shell-legacy-adapted/src/client/index.ts`
- Modify: `packages/native-shell-legacy-adapted/src/client/adapted.css`
- Modify: `packages/native-shell-legacy-adapted/tests/interaction-contract.test.ts`
- Modify: `packages/native-shell-legacy-adapted/tests/client-artifact.test.ts`
- Modify: `packages/native-shell-legacy-adapted/tests/responsive-state.test.ts`

**Interfaces:**
- Consumes: 现有 tabs、choice menus、stream、responsive panel contracts。
- Produces: 箭头键可操作的 tabs/menu、受控 live region、至少 40px 的关键触控目标、合格对比度与稳定跨平台字体。

- [x] **Step 1: 写 tab/menu 键盘、focus return、role=log、触控与主题 token 的失败测试**
- [x] **Step 2: 运行测试并确认 RED**
- [x] **Step 3: 实现 roving tab index、menu 上下箭头/Home/End/Enter/Escape 与焦点恢复**
- [x] **Step 4: 将整段流的 `aria-live` 改为 `role=log`，另设短暂状态播报区**
- [x] **Step 5: 将关键控件命中区提高到 40–44px，移动端保留发送/调整方向说明**
- [x] **Step 6: 提升浅色和暗色的次级文字对比，稳定标题/品牌字体栈，保持旧版玉色语言**
- [x] **Step 7: 删除伪步骤编号和最脆弱的哈希类选择器，改用壳拥有的稳定语义选择器**
- [x] **Step 8: 运行聚焦测试至 GREEN**

### Task 5: 全量验证、正式浏览器验收与交接

**Files:**
- Modify: `docs/evidence/native-shell-legacy-adapted/2026-08-29-ux-repair-acceptance.md`
- Modify: `交接工具/当前状态.md`

**Interfaces:**
- Consumes: Tasks 1–4 的实现与测试。
- Produces: Windows 可复验命令、截图、DOM/控制台证据、已知边界与 macOS 待验收清单。

- [x] **Step 1: 运行适配壳全部测试、typecheck 与生产 build**
- [x] **Step 2: 若触及 DSH 公共包，运行其最窄 GUI/包级测试与类型检查**
- [x] **Step 3: 在正式 `3080` 页面验证亮/暗主题同步、长标题、停止/steer、命令、设置、插件、记忆和键盘操作**
- [x] **Step 4: 覆盖 1440×900、1280×720、1024×768、760×900、390×844；记录横向溢出与控制台结果**
- [x] **Step 5: 更新 Windows 完成证据与跨设备交接；macOS 实机项目保持 `PENDING`**
- [x] **Step 6: 对照本计划逐项复核，不把未实测项写成完成**
