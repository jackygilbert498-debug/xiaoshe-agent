# 小蛇外部能力参考审计

> 日期：2026-08-23
> 状态：Revision 3 现实复核基线，待产品确认后实施
> 审计对象：C:\Users\example\Desktop\壳对比 下的本地源码快照，以及小蛇当前实现 C:\Users\example\Desktop\XS
> 核心问题：哪些机制真正适合小蛇，哪些已经落地，哪些只是底层存在或写进了方案，哪些不应迁移
> 复核基线：XS `b10ef68d1320`；DSH `141eb6fef834` 的当前工作树；未提交内容只记为“工作树实现中”，不算已交付

## 1. 先给结论

这批项目里最值得小蛇吸收的，不是任何一个项目的完整外壳，而是五组互相补足的底层机制：

1. **Hermes 的连续性**：会话恢复、来源追踪、中文检索、上下文压缩、记忆生命周期、后台心跳。
2. **gstack 的隐形纪律**：自动编排、风险门禁、浏览器验收、完成凭证、基于事实的状态，而不是斜杠菜单和角色扮演。
3. **CodeWhale 与 Kimi 的运行契约**：统一根任务与子任务的执行模型，用有序事件、回放、重同步和持久账本把“正在做什么”变成可恢复事实。
4. **cc-haha 的验证与升级安全**：按影响面路由验证、区分 PR/基线/发布门禁、持久化向前迁移、默认不碰不可再生数据。
5. **OpenClaw 的控制面与安全边界**：会话隔离、审批、沙箱、心跳与定时任务分离、插件清单和健康检查。

最终产品不应呈现成“20 个 AI 角色”“一个 AI 公司”或“多渠道网关”。小蛇更合适的形态是：

> **对用户始终像一个统一、可靠、懂上下文的个人智能体；在内部自动使用多视角审查、子任务、风险门禁和验证凭证。**

现实复核后还必须补充一个前提：DSH 本身已经是 Cordis 插件树，Agent loop、会话日志、客户端运行时、搜索、压缩、设置、插件清单和 Profile 安装都已有正式扩展点。小蛇不应在它上面再造第二套会话日志、重放器、搜索服务或插件加载器；需要补的是小蛇自己的产品组合、稳定门面、完成凭证、真心跳和第三方扩展治理。

## 2. 审计方法与判定口径

本次不是看 README 后做功能愿望清单，而是按三步判断：

1. **源码机制证据**：确认项目里是否存在协议、持久化、恢复、门禁、测试或健康检查，而不只看宣传文案。
2. **小蛇定位过滤**：它是否直接增强“看懂电脑、接手任务、关键动作先问、完成后验证”的个人桌面 Agent。
3. **当前状态核对**：在 XS 的 src、tests 和现有方案中确认它是已经实现、部分实现、仅由 DSH 底层提供、只在方案中，还是完全缺失。

### 2.1 状态标签

| 标签 | 含义 |
|---|---|
| 已实现 | XS 当前代码和测试里已有可调用闭环 |
| 部分实现 | 有局部数据或界面，但没有统一契约、恢复或验收闭环 |
| 底层已有 | DSH 或历史实现中存在，但小蛇 Shell 尚未形成不可绕过的产品契约 |
| 工作树实现中 | 当前本地工作树已有代码或测试，但尚未提交并完成相应验证，不能算交付 |
| 方案已有 | 文档已设计，当前产品代码尚未交付 |
| 缺失 | 当前 XS 与既有方案都没有完整覆盖 |
| 不吸收 | 与小蛇定位冲突，或成本大于产品价值 |

“底层已有”不能写成“小蛇已经交付”。这是本审计最重要的口径。

## 3. 本地参考项目总览

| 项目 | 实际定位 | 最值得学习 | 明确不照搬 |
|---|---|---|---|
| hermes-agent-main | 可靠、可持续运行的个人 Agent | 恢复、检索、压缩、记忆、心跳 | 产品人格与完整 CLI 外壳 |
| DSH\gstack-main | 给单一模型增加团队级审查纪律 | 自动编排、风险门禁、浏览器 QA、完成凭证 | 20 多个角色、斜杠菜单、角色包装 |
| DSH\awesome-dsh-plugin-main | DSH 插件目录 | 发现、审计、安装、健康、回滚生命周期 | 智能体静默安装、直接信任第三方代码 |
| cc-haha | Claude Code 桌面工作站 | 影响面验证、发布门禁、持久化迁移、Doctor | IM/远程通道和现成桌面壳 |
| CodeWhale | Agent 运行平台与耐久任务系统 | 执行账本、恢复、上下文预算、子任务一致性 | Rust/TUI/Fleet 产品包装和大菜单 |
| kimi-code | Agent core + server + SDK | 有序事件、回放、重同步、DI、隔离子任务 | Kimi 身份、云登录、TUI 与视频优先级 |
| openclaw-main | 本地优先的个人助理控制平面 | 会话隔离、安全审批、心跳/定时、扩展健康 | 多渠道网关 OS 和庞大生态外壳 |
| Multica | 用户提供的概念参照，本地没有源码 | 人与多个 Agent 的任务归属、阻塞和状态协议 | 完整团队协作操作系统 |
| 界面截图 | 视觉参照 | 信息密度、状态层级、交互位置 | 不能作为能力已实现的证据 |

压缩包副本不重复计入审计，以解压后的源码目录为准。

## 4. 分项目结论

### 4.1 Hermes：让小蛇“不断线”

**吸收的机制**

- 会话在进程退出、机器休眠或切换设备后能够恢复。
- 会话分支、来源与后续关系可追踪，避免只剩一串标题。
- 中文搜索覆盖会话标题、正文、项目和记忆，而不是只做英文关键词匹配。
- 长会话通过检查点和压缩继续工作，且压缩前后的来源可追溯。
- 记忆有保存、修改、遗忘、恢复和审计生命周期。
- 心跳反映后台任务是否真实存活，不用假进度条。

**为什么值得学**

小蛇定位不是一次性问答，而是能在 Windows 上长期接手工作的搭档。恢复、检索和上下文治理决定用户第二天还能不能接着做，比增加更多“角色”更接近核心价值。

**不照搬**

不迁移 Hermes 的完整命令行体验或品牌人格。小蛇只吸收连续性机制，并把它们放进自己的会话、工作台和设置。

### 4.2 gstack：把团队纪律藏在小蛇内部

**吸收的机制**

- 根据任务自动选择产品、架构、工程、QA、安全等审查视角。
- 高风险任务先规划、再执行；低风险任务可直接完成。
- 浏览器任务必须留下截图、断言或可复验步骤。
- 完成状态必须有测试、日志、变更和未完成项作为凭证。
- 状态来自实际工具轨迹，不能由模型自行宣称“已经完成”。

**为什么值得学**

gstack 的价值不在“CEO、设计师、QA 主管”这些名字，而在同一个模型能被迫从不同风险角度检查自己。小蛇用户不应先学习该调用哪个角色，模型应自己决定何时需要设计审查、代码审查或浏览器验收。

**不照搬**

- 不暴露 20 多个角色。
- 不以斜杠菜单作为主导航。
- 不把普通任务包装成虚拟公司会议。
- 不复制 gstack 的角色名称和界面语言。

小蛇中的呈现应是“自动编排”，需要时只解释：为什么增加了某个检查、现在卡在哪、凭什么判定完成。

### 4.3 插件目录：先建安全通道，再谈自动安装

**吸收顺序**

1. 只读发现：列出插件、来源、版本、权限和依赖。
2. 安全审计：检查清单、脚本、网络、文件写入和秘密访问。
3. 用户确认安装：清楚显示将发生的变更。
4. 安装后健康检查：确认能力真的可调用。
5. 卸载与回滚：恢复安装前状态，并保留审计记录。

**边界**

- 智能体不得静默安装。
- 目录存在不代表插件可信。
- 安装成功不等于连接成功或能力可用。
- 高风险插件必须在隔离环境检查后才允许进入主运行时。

### 4.4 cc-haha：验证不是一个“跑测试”按钮

**源码证据**

- scripts\quality-gate\types.ts
- scripts\quality-gate\runner.ts
- scripts\quality-gate\reporter.ts
- scripts\quality-gate\modes.ts
- scripts\quality-gate\persistence-upgrade.ts
- scripts\quality-gate\provider-smoke\execute.ts
- scripts\quality-gate\desktop-smoke\execute.ts

**吸收的机制**

- 根据改动影响面选择测试，而不是任何改动都跑同一套命令。
- 区分日常变更、基线回归、正式发布三个强度。
- 线上 Provider 或浏览器检查必须显式允许；没有跑不能伪装成通过。
- 持久化升级要验证旧数据、备份、未知字段和前向迁移。
- Doctor 默认只修复可再生状态，不碰会话、配置、令牌、技能和插件。

**为什么值得学**

小蛇的“做完再验证”需要明确知道验证了哪一层。这个机制能避免把一次单元测试说成 Windows 验收，更符合用户要求的已验证、部分验证、阻塞和待发布状态。

**不照搬**

不迁移 cc-haha 的 IM、远程入口或现成工作站结构。它的验证路由和数据升级纪律应成为小蛇运行时服务，而不是换皮 UI。

### 4.5 CodeWhale：子任务必须是耐久执行，不是聊天里的临时幻觉

**源码证据**

- docs\SUBAGENTS.md
- docs\WORKROOM_SECURITY.md
- docs\rfcs\2574-provider-fallback-chain.md
- docs\rfcs\2189-persistence-sqlite.md
- crates\tui\src\compaction.rs
- crates\tui\src\plugins\manifest.rs

**吸收的机制**

- 根任务和子任务使用同一个执行底座；子任务不是第二套临时运行时。
- 任务账本记录 run_id、目标、工作区、分支、生命周期事件、产物、用量与验证来源。
- 进程丢失后标记中断，保留检查点和继续句柄。
- 子任务支持 fresh 与 fork 两种上下文来源，并明确记录来源。
- 并发、预算和工作区隔离由运行时控制，不由提示词约定。
- Provider 回退前检查工具、推理、上下文和视觉能力是否兼容。

**为什么值得学**

小蛇以后可以内部拆任务，但用户仍只面对一个小蛇。这里吸收的是统一来源与耐久语义，不是再建一张平行会话表：会话内任务事实进入 DSH Session Log，跨会话后台运行由有明确所有者的 Host Service 持有，产品投影把两者合并呈现。这样主任务才能准确回答“哪个子任务在跑、失败后能否继续、结果来自哪里”。

**不照搬**

不迁移 Rust/TUI/Fleet 外壳、庞大角色菜单或企业队列产品。小蛇只需要轻量任务协议和可观测性。

### 4.6 Kimi Code：Shell 与运行时之间必须有稳定协议

**源码证据**

- packages\server\README.md
- packages\server\src\services\gateway\sessionEventJournal.ts
- packages\server-e2e\test\session-resume.test.ts
- packages\server-e2e\test\refresh-replay.test.ts
- packages\node-sdk\test\session-plan-compact-usage-resume.test.ts
- packages\agent-core\src\plugin\manifest.ts
- packages\agent-core\src\agent\compaction

**吸收的机制**

- agent-core、协议、服务和客户端解耦。
- 每个会话事件有序号，客户端断线后可按游标回放。
- 缺失事件超出保留窗口时明确返回 resync_required，而不是悄悄丢状态。
- 工具注册与依赖使用显式容器，避免界面直接拼接实现。
- 子任务隔离上下文，但与主任务共享同一协议和生命周期。
- ACP 可作为可选适配层，不成为小蛇唯一运行方式。

**为什么值得学**

这直接解决“小蛇界面显示的状态是不是事实”。Kimi 的游标与 `resync_required` 是参考机制，不是要求小蛇再定义同名协议；实际落地直接复用 DSH `SessionEvent.seq`、历史尾页、gap repair、reconnect resync 和公开产品投影。这样刷新、重连后仍能恢复真实状态，界面也不必耦合 DSH 内部细节。

**不照搬**

不迁移 Kimi 身份、云端 OAuth、TUI 和视频输入优先级。

### 4.7 OpenClaw：把心跳、安全和扩展做成控制面

**源码证据**

- docs\tools\exec-approvals.md
- docs\tools\exec-approvals-advanced.md
- docs\reference\session-management-compaction.md
- security\README.md
- qa\scenarios\scheduling\heartbeat-active-hours.yaml
- qa\scenarios\plugins\plugin-manifest-contract-health.yaml
- qa\scenarios\runtime\compaction-retry-mutating-tool.yaml
- ui\src\app\exec-approval.ts
- extensions\copilot\src\compaction-bridge.ts

**吸收的机制**

- 控制平面统一暴露会话、工具、事件、审批和健康状态。
- 心跳负责“仍然活着和最近做了什么”，定时任务负责“何时触发”，两者不混用。
- 压缩检查点原子替换旧上下文，防止已压缩内容重新混回会话。
- 会话、工作区和秘密默认隔离；分享必须显式。
- 插件以清单、权限、健康和版本契约接入。

**为什么值得学**

小蛇需要的工作台、记忆和系统页，本质都是控制面的不同投影。统一控制面后，右侧状态不再是假仪表盘，设置也能控制真实能力。

**不照搬**

不建设多渠道 Gateway OS，不复制完整个人助理生态和市场。

### 4.8 Multica 概念：只学协作协议

本地目录没有 Multica 源码，因此本节不是源码审计结论，只保留用户提供的产品概念作为参照。

**可学**

- 任务有明确负责人、状态、阻塞原因和交付物。
- 人与多个 Agent 共享同一任务事实。
- 子任务进度可以汇总，但不强迫用户进入项目管理工具。

**不值得现在建设**

- 独立的 Issue 系统、组织图、成员管理和完整团队协作 UI。
- 为个人用户制造额外分配和维护成本。

小蛇应把它压缩成右侧工作台中的任务树、负责人、阻塞和证据，不做另一个 Linear。

## 5. 小蛇当前真实状态

以下判断基于 XS 当前 src、tests、package.json、DSH 当前源码和既有方案，而不是外部项目具备什么。DSH 的底层能力只有在小蛇产品组合实际挂载、测试和验收后，才能升级为“小蛇已实现”。

| 能力 | 当前状态 | 证据与判断 |
|---|---|---|
| Windows 观察、动作与桥接 | 已实现 | src/action-controller.ts、src/bridge-client.ts、src/tools.ts 及 Windows bridge/doctor/smoke 测试 |
| 动作前后证据投影 | 已实现 | src/tools.ts 与相关测试能够保存可回放的 before/after 证据 |
| 长期/项目记忆生命周期 | 已实现 | src/memory-service.ts 已含版本、修订冲突、编辑、遗忘、恢复与审计 |
| Windows Doctor | 已实现 | 诊断路由和测试已存在 |
| 统一完成凭证 | 部分实现 | 有动作证据，但没有跨工具、测试、浏览器与发布层级的统一 Completion Receipt |
| DSH/Cordis 插件组合 | 底层已有 | DSH 的 Host、Client、Agent loop、会话、工具、设置和 UI 都按 Profile/Bundle 与 Cordis 插件组合；XS 当前 Bundle 也通过 `cordis.patch.yml` 接入 |
| XS Windows Bundle 的双面边界 | 部分实现/待拆分 | `@xiaoshe/dsh-desktop-control` 当前同时声明 `dsh.bundle` 与 `dsh.client`；Host 能力是正式插件，但 `client.js` 仍含 `querySelector`/`MutationObserver` 产品注入。最终原生 Profile 不能原样挂载该 Client face |
| XS 根包内部能力所有权 | 部分实现/待拆分 | 当前单个 `apply()` 同时注册桌面桥接/工具/动作策略、记忆工具、产品身份、响应风格和运行路由。包可继续是一个 Bundle，但这些独立能力需要各自的 Cordis 插件入口/row 与 effect 生命周期 |
| AgentRuntimeSession | 部分实现 | DSH Client Runtime 已提供 `ctx.sessions`、`ctx.workspaces`、prompt/cancel/fork/search、连接恢复和状态投影；XS 只缺会话生命周期与产品运行状态的薄门面，搜索、Workspace、压缩等不能被重新收编进一个总服务 |
| 有序事件、回放、重同步 | 底层已有 | DSH `SessionEvent` 自带单调 seq；Client Runtime 已有历史分页、断帧检测、尾页补拉和重连 resync。小蛇不得另建第二本 Event Journal |
| 会话恢复、分支与来源追踪 | 底层已有/部分实现 | DSH 已有持久化、resume、fork、父子来源与客户端重连；跨设备接续和小蛇产品级来源呈现仍未闭环 |
| 中文跨会话搜索 | 底层已有/待验证 | DSH 已有 `ctx.sessionQuery`、SQLite FTS5 Provider 和客户端 `session.search`；中文召回、文件路径、工具轨迹与记忆联合搜索尚需针对性验证 |
| 上下文压缩与路由预算 | 底层已有/部分实现 | DSH 已有 `ctx.compaction` Definition/Provider/Consumer 和可追溯替换事件；小蛇仍缺产品级预算解释、路由约束和记忆联动 |
| 真实后台心跳 | 缺失 | 状态页尚无由运行账本驱动的存活协议 |
| 自动编排与风险门禁 | 方案已有/底层局部 | 尚未通过独立策略插件、正式事件和审批能力缝强制执行 |
| 插件发现、安装和回滚基础 | 底层已有/部分实现 | DSH 已有 Loader 清单、`dsh plugin --profile ... add/remove` 和会话级 Cordis run/update/rollback/undefine；小蛇仍缺来源审计、权限差异、健康检查和用户确认闭环 |
| 项目外临时会话及迁移 | 工作树实现中 | DSH 当前未提交工作树已有 loose Session、移入 Workspace 和对应测试；在提交与聚焦验证前仍不能写成已交付 |
| 小蛇独立原生 Shell | 方案已有 | 现有品牌化主要仍依赖 DSH 客户端注入，不能算独立产品壳 |

## 6. 已经学了什么、还没迁移什么

### 6.1 已经进入小蛇实现

- Windows 桌面桥接、动作控制和可回放动作证据。
- 记忆的版本化、编辑、遗忘、恢复和审计。
- Windows Doctor 与诊断入口。
- 对权限、会话/项目关系和品牌壳的若干局部改造。

### 6.2 已写进方案但尚未完整落地

- 项目外会话、后续迁入项目目前在 DSH 工作树实现中，尚未形成可依赖基线。
- 自动能力方案与小蛇设置中心。
- 独立的左侧巢册、中间任务画布、右侧工作台。
- 基于 DSH 现有加载/安装能力的插件安全治理和真实心跳。

### 6.3 DSH 已有、必须复用而不能重造

- DSH Session Log 是唯一权威交互日志；小蛇只建立可重建的产品投影。
- DSH Client Runtime 已处理会话列表、prompt、cancel、fork、search、历史分页、断帧补拉和重连 resync。
- `ctx.sessionQuery`、`ctx.compaction`、`ctx.settings`、Host Plugin Inventory 和向 Profile 安装 Bundle 的流程已经是插件能力缝。
- DSH 浏览器端本身是 Client Cordis 插件树；原生壳应替换产品展示插件，保留连接、Remote、Runtime、Renderer 等非产品视觉底座。
- 安装进 Profile 的 Bundle 会执行受信任主机代码；动态 Host Package 虽使用 `node:vm` 和 Service façade，但 DSH 明确不把它当安全边界。小蛇必须把“已披露/已同意的权限”与底层 Service、sandbox、approval 真正执行的限制分开呈现。
- 当前 XS 双面包还要先把 Windows Host 能力与旧 DSH 皮肤 Client 拆成两个可独立组合的生命周期；优先保留根包的 Host/Bundle 身份，把旧 `client.js` 迁入只供兼容 Profile 使用的 Client 插件。
- 根包无需为了字面插件化拆成很多 npm 包，但桌面能力、记忆、产品身份/表达与兼容皮肤不能继续共用一个不可分卸载的 `apply()`；Bundle 应组合多个窄 Cordis rows。

### 6.4 这次审计后必须补入方案

- AgentRuntimeSession 作为窄小蛇会话生命周期 Service Definition；默认 Provider 只委托 DSH 的公开 Client/Host 服务，不能拥有第二套 Agent loop、Session Log、持久化或把搜索/压缩/审批等插件吸成总服务。
- Xiaoshe Product Bundle、承载它的 Profile 与 Client 插件组合；原生壳是现有运行事实的 Consumer，不读取 DSH DOM。
- DSH Session Log 为唯一会话交互事实源；小蛇状态和完成凭证通过 SessionEventMap/Projection 扩展，跨会话心跳由有明确所有者的 Host Service/Remote 提供。
- 由 DSH Session events 与正式 Host Service 共同支撑的耐久任务来源/验证投影，不新增平行会话账本。
- 对现有搜索与压缩能力做中文和产品适配验证，只补真实缺口。
- 分级验证门禁与 Completion Receipt。
- 心跳和定时任务分离。
- 在 DSH 现有清单、安装和动态生命周期之上增加只读审计、确认、健康和失败回滚，不再实现新的插件加载器。

## 7. 吸收优先级

### P0：先证明组合边界，再打通可信任务

1. 冻结三个工作树，完成 ADR、数据所有权表和 DSH 公开扩展点清单。
2. 用真实 Profile/Bundle 证明小蛇 Client 插件能复用 DSH Connection/Remote/Runtime 并替换产品 UI；证明失败就停止，不自动退回第二套独立运行时。
3. 建立不持有第二份事实、也不充当 Service Locator 的薄 AgentRuntimeSession 会话门面。
4. 用 DSH 既有重连、历史和投影打通第一条任务链，并补 Completion Receipt。
5. 验证并接入项目外会话、中文搜索和压缩；只实现证据证明存在的缺口。

没有 P0，任何新工作台和设置页都只是换皮。

### P1：让小蛇自动做对的事

1. 隐形多视角编排。
2. 风险门禁与真实审批。
3. 影响面验证、浏览器证据和完成凭证。
4. 真实心跳、阻塞原因和后台任务观测。
5. 插件来源审计、权限差异、健康检查与确认流程。

### P2：扩展生态

1. 用户确认后把 Bundle 安装到 Profile 的流程与升级体验。
2. DSH 会话级动态插件的安全产品化。
3. 卸载、回滚、版本兼容和来源审计的端到端验收。
4. 可选 ACP/MCP/第三方 Agent 适配。

## 8. 明确不做

- 不把小蛇变成角色选择器。
- 不要求用户理解 gstack、Fleet、ACP 或 Gateway。
- 不建立完整人机混合组织系统。
- 不复制任何参考项目的导航、术语、品牌和视觉壳。
- 不以插件数量代替核心能力质量。
- 不允许界面状态脱离运行账本自行推测。
- 不允许智能体静默安装扩展或绕过确认。
- 不把“跑过一个测试”写成“全部验证完成”。

## 9. 对原生 Shell 方案的影响

原方案只描述左、中、右三栏和设置中心还不够。经过现实复核，原生 Shell 必须从“重做界面”升级为：

> **以 DSH/Cordis 插件树和唯一 Session Log 为运行事实，以小蛇的窄能力门面和 Client 插件组合组织体验，再由巢册、任务画布、动作片和工作台呈现。**

因此实施顺序必须从横向造完所有 UI，改为先证明可安装、可卸载、可替换的产品 Bundle，随后复用现有运行契约打通一条端到端纵向切片，再扩展其余页面。对应设计与计划见同日的原生产品壳设计和实施计划。
