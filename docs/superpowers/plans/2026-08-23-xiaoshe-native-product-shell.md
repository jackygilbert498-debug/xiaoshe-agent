# 小蛇原生产品壳实施总计划（Revision 4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` only after the current phase has its own task-level plan and the user authorizes implementation.

**Goal:** 在不复制 DSH 运行时的前提下，以可安装、可卸载的 Xiaoshe Product Bundle 和 Client 插件组合交付小蛇原生产品壳。

**Architecture:** Cordis/DSH 是唯一运行宿主，DSH Session Log 是唯一权威交互日志，现有 Client Runtime 负责历史、断帧修复和重连。`AgentRuntimeSession` 是实现无关、可注册的小蛇产品 Service Definition；默认 Provider 委托 DSH 公开服务，Native Shell 作为 Consumer 呈现自己的信息架构。

**Tech Stack:** TypeScript、Cordis、DSH Profile/Bundle、DSH Client Runtime/Slots、React、Vitest、Windows PowerShell/Python Bridge。

**Spec:** `docs/superpowers/specs/2026-08-23-xiaoshe-native-product-shell-design.md`

## Global Constraints

- 不建立第二套 Agent loop、Session Log、Client Runtime、插件 Loader 或 Profile 包管理。
- 不从 XS 深导入 `runtime/DSH` 源文件、私有 store、私有事件对象或数据库结构。
- 当前顶层 `@xiaoshe/dsh-desktop-control` 保持独立 Windows Host 能力 Bundle，首阶段不迁 Host 实现目录；其现有 DOM 注入 Client face 必须拆到兼容插件，不能进入最终 Product Shell Profile。
- 所有产品能力通过 Cordis 插件、Service Definition/Provider/Consumer、Session Projection 或 Profile/Bundle 接入，并分别证明 effect 释放与 Bundle 移除后重启的静止状态。
- 安装进 Profile 的 Bundle 和动态 Host Package 都属于受信任代码面；权限披露/确认不等于沙箱，只有底层 Service、sandbox、approval 或独立进程真正执行的限制才能写成已强制。
- 三个工作树的用户修改必须原样保留；禁止 `reset --hard`、`clean`、批量覆盖和未经审查的 Windows 文件模式规范化。
- 每个阶段先产生独立的任务级计划，再按测试先行执行；本文件是阶段总计划，不替代任务级 TDD 步骤。
- 2026-08-25 起固定实施顺序为 Phase 4 → Phase 5 → Phase 6；三阶段完成并重新验收前，不继续把当前工程验收壳当作正式视觉产品壳打磨。
- 后续界面方案必须位于独立包、独立 Profile row 或独立原型目录；不得覆盖 `packages/native-shell/`，不得改写 `runtime/xiaoshe-legacy` 的旧版界面。可以读取并复用合法资产和设计 token，但候选方案必须能单独安装、移除和比较。

> 状态（2026-08-25，Revision 4 实施中）：Phase 2、3、8 的本机纵向能力已实现；Phase 7 只有工程验收壳，正式视觉产品壳未获用户验收。Phase 4 的独立记忆 Provider/Consumer、Product Bundle 组合、上下文治理、真实 Profile 与浏览器验收已在本机完成；真实模型 compaction 因无凭据继续为 `release-held`。Phase 5 的独立验证策略、Heartbeat v2 持久检查、真实 DSH Jobs 执行、崩溃恢复、受保护 API、策略化完成凭证、真实 Profile 与浏览器验收也已在本机完成；真实模型成功回合仍因无凭据保持 `release-held`。Phase 6 的 Host 候选审计、一次性确认、非活跃受管 Profile、官方 DSH CLI 变更、dump/boot/功能探针、卸载、显式恢复、partial-health 和失败回滚已用本地受控 Bundle 在三个独立临时 `DSH_HOME` 中通过；浏览器也证明 prepared 状态可见且确认前无 Profile 变更。真实第三方插件未安装，OS 沙箱未强制，跨设备离线工件重定位仍为 Phase 7/迁移工作。后述未闭环项统一为 `release-held`，不得写成已完成。macOS、DPI/多显示器硬件矩阵和发布/合并同样为 `release-held`。
> 工作分支：`codex/xiaoshe-native-shell`
> 合并策略：完成阶段性实现并由用户确认后再合并
> 本次范围：在未提交工作树中继续实现并验证本机可完成项；不合并、不发布。

关联文档：

- `docs/superpowers/specs/2026-08-23-xiaoshe-reference-capability-audit.md`
- `docs/superpowers/specs/2026-08-23-xiaoshe-native-product-shell-design.md`
- `docs/plans/2026-08-23-xiaoshe-projectless-sessions-settings.md`

本计划取代此前“先建立 `src/shell`、再逐页改造 DSH 界面”的 UI 优先路线，也取代 Revision 2 中另建 Event Journal、Snapshot Store 和独立 Session Runtime 的路线。新的实施顺序是：**先证明小蛇 Bundle 能复用 DSH 公开 Host/Client 插件并替换产品 UI，再建立薄产品门面和一条真实任务链，最后只补证据确认的能力缺口。**

---

## 1. 最终目标

交付一个属于小蛇自己的桌面 Agent 产品，而不是换皮后的 DSH：

1. Cordis/DSH 是唯一运行宿主，当前只挂载一个可配置替换的 Agent-loop Provider；小蛇不创建并行运行时。
2. 小蛇用稳定、可版本化的 `AgentRuntimeSession` Service Definition 收敛最小会话生命周期；搜索、Workspace、审批、压缩、完成凭证和心跳继续由各自的窄插件能力缝提供。
3. 会话可以恢复、分支、搜索、追踪来源，并在上下文过长时安全压缩。
4. 前台任务、后台心跳、审批、工具调用和完成状态都来自真实运行事件。
5. 完成结果带有验证凭证，不用模拟进度或一句“已经完成”代替证据。
6. 插件先发现和审计，只有用户确认后才安装，并支持健康检查、卸载和回滚。
7. 产品壳采用小蛇自己的信息架构、设置体系和交互语言。

### 完成定义

只有同时满足以下条件，才能称为“原生壳第一版完成”：

- 一条真实任务可以从新建会话运行到完成；
- 页面刷新、进程重启或连接中断后可以恢复；
- 事件顺序、审批、工具调用和验证结果可追踪；
- UI 不直接依赖 DSH 私有状态或私有组件；
- 最终 Profile 不加载当前 DOM 注入版 `client.js`，Windows Host Bundle 与 Product Shell Bundle 可独立组合；
- Windows 桥接、记忆、插件和设置通过各自的明确 Service/Provider/Consumer 或 Projection 接入；
- Product Bundle 可以安装、启动和移除；Profile 重启后小蛇注册与资源完全消失而 DSH 会话保持；
- 自动化测试、Windows 验收和证据清单通过；
- 用户确认后才进入合并流程。

---

## 2. 当前基线与约束

### 2.1 已存在，必须复用

当前顶层包 `@xiaoshe/dsh-desktop-control` 已经具备一部分 Windows 能力：

- 桌面桥接和运行控制；
- 动作审批及动作证据；
- Windows Doctor/诊断；
- 基础记忆服务；
- 对应的 TypeScript、Python 和桥接测试。

同一根包当前还声明 `dsh.client`，且 `client.js` 混有正规 Slot 注册与 DOM/MutationObserver 注入；这是待拆分的兼容债务，不是可直接复用的原生 Shell 底座。

当前顶层 `apply()` 还同时注册桌面 Bridge/Tools/动作策略、记忆、产品身份/响应风格和运行路由。现有实现可复用，但最终必须成为同一 Bundle 内可独立组合的窄 Cordis 插件 rows；不要求每项能力新建 npm 包。

这些内容不重新发明。后续将其作为 Windows/桌面能力适配器接入运行契约。

DSH 当前还已经具备以下正式底座：

- Cordis Profile/Bundle 与 Host/Client 插件树；
- 唯一的 `SessionEvent` 权威日志、持久化、resume 和 fork；
- Client Runtime 的 `ctx.sessions`、`ctx.workspaces`、prompt/cancel/search、历史分页、seq gap repair 与 reconnect resync；
- `ctx.sessionQuery` 与 SQLite Provider；
- `ctx.compaction` Definition/Provider/Consumer；
- Settings、Credentials、Session Projection、Host Plugin Inventory；
- `dsh plugin --profile ... add/remove` 和会话级 Cordis run/update/rollback/undefine。

这些是底层可复用能力，不等于小蛇产品已经交付。尤其 DSH 当前工作树里的 loose Session 与移入 Workspace 仍未提交、未由本计划验证，只能记为“工作树实现中”。

### 2.2 真正尚未落地，不能假装已有

- Xiaoshe Product Bundle、Native Shell Client 插件和真实 Profile 组合；
- Windows Host Bundle 与旧 DSH 皮肤 Client 的独立打包/生命周期，以及旧 Profile 的兼容迁移；
- 根包桌面能力、记忆、产品身份/表达与运行控制的插件 row 拆分；
- `AgentRuntimeSession` Service Definition、DSH Provider 和测试 Provider；
- DSH 现有恢复、分支、搜索、压缩和项目外会话在小蛇产品中的接入与针对性验收；
- 真实后台心跳；
- 完成凭证的统一格式；
- 在 DSH 现有清单和生命周期之上的来源审计、权限差异、健康检查和用户确认闭环；
- 独立的小蛇原生 Shell。

### 2.3 工作区保护

实施前和每个阶段结束时都要冻结以下三个工作树：

- `C:\Users\example\Desktop\XS`
- `C:\Users\example\Desktop\XS\runtime\DSH`
- `C:\Users\example\Desktop\XS\runtime\xiaoshe-legacy`

必须保留现有未提交和未跟踪内容；不得执行 `reset --hard`、`clean` 或批量覆盖；不得顺手规范化 Windows 下的可执行位和符号链接差异。

---

## 3. 实施原则

1. **组合先于新建**：先复用 DSH 公开插件和 Service；只有证据证明缺口存在时才新增能力插件。
2. **一切皆插件**：可替换能力必须有 Definition/Provider/Consumer 或明确的 Profile/Bundle/Projection 角色，并证明 effect 生命周期。
3. **唯一事实源**：DSH Session Log 是唯一权威交互历史；小蛇缓存和产品投影必须可重建。
4. **契约先于界面**：Shell 只依赖小蛇契约和通用 Client 底座，不读取 DSH 私有 store。
5. **纵向切片优先**：先打通一条完整任务链，再横向铺满所有页面。
6. **测试先行**：每个行为先写失败测试，再实现最小代码。
7. **真实状态**：不使用假进度、假心跳或前端推测的“运行中”。
8. **证据优先**：完成状态必须关联测试、构建、截图、日志或人工确认。
9. **安全默认**：插件不静默安装；项目外动作和高风险动作按策略确认。
10. **能力与包装分离**：学习外部项目的机制，不照搬角色、斜杠菜单和团队戏剧化包装。
11. **品牌资产锁定**：唯一合法 Logo 继续使用 `runtime/xiaoshe-legacy/ui/assets/snake.svg`，不得改画。
12. **性能优先**：已封存的动态蛇纹背景默认不加载，不阻塞原生壳落地。

---

## 4. 目标依赖方向

```text
Xiaoshe Profile / Cordis Host
  ├── @deepseek-ai/dsh-base
  │     └── Agent loop / Session Log / Persistence / Approval
  ├── @deepseek-ai/dsh-web-app
  │     └── API / Connection / Client Runtime / Renderer
  ├── @xiaoshe/dsh-desktop-control          # 拆分后的 Host-only Windows Bundle
  └── @xiaoshe/product-bundle               # 独立 Product Shell Bundle
        ├── AgentRuntimeSession Definition + DSH Provider
        ├── Xiaoshe Product Identity plugin
        ├── Completion Receipt / Heartbeat plugins
        └── Xiaoshe Native Shell Client plugin
```

约束：Shell 只消费产品 Service 和通用 Client services。Product Bundle 通过配置组合 DSH 插件，不复制其实现；任何需要深导入 DSH 源码或读取 DSH DOM 的方案都在阶段 0 失败。

---

## 5. 阶段 0：基线、ADR 与真实组合证明

### 目标

在写完整产品代码前，证明 XS 能以树外 Product Bundle 和 Client 插件复用 DSH 公开底座，并把数据所有权和插件生命周期固定下来。

### 任务

- [ ] 记录三个工作树的分支、HEAD、dirty/untracked 数量、状态哈希和关键基线命令。
- [ ] 建立 DSH 能力复用表，逐项记录公开 Service/Remote/Client face、数据所有者、当前测试和小蛇缺口。
- [ ] 记录根包双面事实：Host row 与 package-level `dsh.client` 会一起进入 Client module 扫描，当前 `client.js` 存在 DOM 注入，不能靠 Product Bundle 配置假装关闭。
- [ ] 为根包现有 `apply()` 建立能力所有权表，标出桌面、动作策略、记忆、产品身份/表达、运行路由的配置、数据、依赖和 disposer；后继 ADR 规定目标插件 rows 与兼容聚合入口的退场条件。
- [ ] 新增后继 ADR，不改写历史 `docs/decisions/0001-dsh-core-xiaoshe-capabilities.md`：保留其中 DSH Profile 唯一运行面与 Windows Bundle 边界，并补充 Session Log 唯一会话日志、原生壳 Client 插件组合和 Product Bundle 生命周期决策。
- [ ] 建立最小树外双面 Client 插件和 Product Bundle 探针，只注册一个可识别的根级测试视图，不实现正式视觉。DSH 的共享 Client 构建 preset 当前未发布，探针只能依据公开 `dsh.client` 产物契约建立自己的最小构建，不得从 `runtime/DSH` 导入该 preset 或复制私有源码。
- [ ] 在隔离的 `DSH_HOME` 中初始化 `xiaoshe-shell-probe` Profile。非内置 Profile 默认只有 `dsh-base`，因此通过 `dsh plugin --profile xiaoshe-shell-probe add @deepseek-ai/dsh-web-app <product-bundle.tgz>` 显式加入 Web Bundle 和 Product Shell Bundle；运行 `dsh --profile xiaoshe-shell-probe --dump-config`，确认层顺序正确、Product Shell Bundle 覆盖目标产品 UI rows 且保留 Connection/Remote/Client Runtime/Renderer。本探针只证明 Shell 组合，不把独立 Windows Bundle 偷塞进 Product Bundle。
- [ ] 启动真实浏览器组合，证明插件通过 Cordis/Slots 获取状态，不查询 DSH DOM，不从 XS 深导入 `runtime/DSH` 源文件。
- [ ] 按 DSH 的启动边界重启测试 Profile 后验证新增 Bundle；移除探针 Bundle 后再次重启，确认 UI 注册、订阅和资源消失，原 DSH 会话数据不变。
- [ ] 建立 Windows 双面包拆分探针：优先保留根包 Host/Bundle 身份，将旧 `client.js` 迁到仅供兼容 Profile 使用的独立 Client 包；验证旧 Profile 加兼容包后行为保持、Product Shell Profile 只加载 Host face。若该路径无法 pack/install，再评估只复用根包公开 Host export 的 Host-only wrapper，禁止复制 Host 实现。
- [ ] 在阶段 0 的任务级 TDD 计划中拆分根包插件入口：先用 Loader composition/lifecycle 测试固定现有行为，再把桌面能力、记忆、产品身份/表达和运行控制变成窄 rows；顶层 `apply()` 只作迁移期兼容聚合器。Product Shell Profile 直接组合窄 rows，不挂载聚合器。
- [ ] 只有上述证明通过后，固定候选边界：`packages/runtime-contract/`、`packages/runtime-dsh-provider/`、`packages/native-shell/`、`packages/product-bundle/`；若采用首选拆分，再增加 `packages/legacy-dsh-skin/`。随后才扩展根 workspace。

### 阶段产物

- ADR；
- DSH 能力复用与缺口表；
- Windows Host/旧皮肤 Client 拆分 ADR 与兼容探针；
- 根包能力 row/数据所有权迁移表；
- 工作区边界说明；
- 数据所有权表；
- 基线证据清单；
- 可安装、可启动、可卸载的 Product Bundle 探针及真实组合测试。

### 验收门槛

- 三个工作树的原有改动没有丢失；
- 新包可以独立 typecheck/test/build/pack；
- 探针不导入 DSH 产品 UI 组件或私有源码；
- Product Shell 探针不加载根包当前 DOM 注入版 `client.js`；兼容 Profile 仍能显式安装旧皮肤 Client；
- 每个从根包拆出的能力 row 能独立挂载/卸载，移除产品身份或记忆不停止桌面 Bridge；
- 真实 Profile 组合可以安装、dump、启动、移除和重启；
- 插件 effect 测试证明卸载释放，Bundle 移除后的新进程证明 Cordis 注册和本插件资源达到静止；
- 用户确认目录边界后再进入阶段 1。

如果树外 Client 插件无法在只依赖公开契约和已打包依赖的前提下交付，本阶段状态为“受阻”。后续阶段全部停止，另写架构方案并重新取得用户确认；不得自动改成第二套独立 Shell 协议栈。

---

## 6. 阶段 1：产品 Service Definition 与 DSH Provider

### 目标

建立小蛇自己的薄会话生命周期门面，同时保留 DSH Client Runtime 对连接、历史、重连和会话状态的唯一所有权；其他能力保持独立 Service。

### 候选文件

```text
packages/runtime-contract/src/
  service.ts
  commands.ts
  projection.ts
  state.ts
  errors.ts
  version.ts
  index.ts

packages/runtime-contract/tests/
  service.test.ts
  state-machine.test.ts
  compatibility.test.ts

packages/runtime-dsh-provider/src/client/
  index.ts
  provider.ts
  mapping.ts

packages/runtime-dsh-provider/tests/
  provider.client.test.ts
  loader-composition.client.test.ts
  lifecycle.client.test.ts
```

### Service 角色

- `runtime-contract` 提供抽象 Cordis Service、Context augmentation 和产品类型，只把 `@deepseek-ai/cordis` 作为运行时 peer，不导入 DSH 实现或 React。
- `runtime-dsh-provider` 是 Cordis Client Provider，只消费最小生命周期所需的公开 `ctx.sessions`、`ctx.workspaces` 创建入口和 Session Projection。
- `native-shell` 是 Consumer。
- 测试运行时提供同一 Service 的内存 Provider；生产组合不得自动回退到它。
- `AgentRuntimeSession` 不是 Service Locator：搜索、Workspace 操作、审批、压缩、完成凭证和心跳由 Shell 分别消费它们自己的公开或小蛇窄 Service。

### 第一版命令

- `createSession({ workspaceId? })`
- `sendTurn({ sessionId, content, mode })`
- `stopRun({ sessionId })`
- `forkSession({ sessionId, atSourceSeq? })`

底层尚不支持的核心操作必须显式返回 `unsupported`，不能用前端模拟成功。`ctx.sessions.search`、`ctx.workspaces`、DSH Interaction/Remote、`ctx.compaction`、Completion Receipt 和 Heartbeat 不包装进本 Service；缺失公开面时在对应能力缝补足。

### 关键规则

- 不定义第二套事件日志、cursor 或 `resync_required` 协议；权威顺序来自 DSH `SessionEvent.seq`，断帧与重连由 DSH Client Runtime 处理。
- 产品投影带 `schemaVersion`、`sessionId` 和可用的 `sourceSeq`，但它不是权威日志。
- 状态转换必须由 DSH facts、新增 Session events 或 Host Service 状态投影；UI 不可自行猜测。
- 新的有副作用命令只有在底层提供可验证幂等语义时才接受重试；未知结果返回 `needs_verification`。
- 不认识的新字段要保留，旧客户端不能因为扩展字段崩溃。
- 协议错误与模型错误、工具错误、连接错误分开表示。

### 验收门槛

- 状态机和兼容性测试通过；
- DSH Provider 与内存 Provider 通过同一 Service 合约测试；
- 真实 Client Cordis composition 能挂载 Consumer 和 Provider；
- Provider 卸载后 Service、订阅和监听器消失；
- Service 合约只含最小会话生命周期；搜索、Workspace、审批、压缩、完成凭证和心跳没有被吸入；
- DSH gap repair/reconnect 测试仍由原 Client Runtime 负责，小蛇不复制其状态机；
- 契约不包含 DSH 私有类型。

---

## 7. 阶段 2：完成凭证插件与首条纵向切片

### 目标

用最小 UI 打通第一条真实链路：

```text
新建真实会话
→ 发送请求
→ 通过 DSH Client Runtime 接收连续事实
→ 处理一次工具调用或审批
→ 中止/断线
→ 由 DSH 历史补拉与 resync 恢复
→ 形成完成凭证
```

若项目外会话尚未形成已验证提交，本阶段使用普通项目会话证明架构，并把“项目外首用体验”保持为未完成；不得复制一套 loose Session 实现抢跑。

### 候选文件

```text
packages/completion-receipt/src/
  index.ts
  types.ts
  projection.ts
  invariant.ts

packages/completion-receipt/tests/
  receipt.test.ts
  projection.test.ts
  loader-composition.test.ts

packages/native-shell/src/client/
  apply.ts
  VerticalSlice.tsx

packages/native-shell/tests/
  vertical-slice.client.test.tsx
  lifecycle.client.test.ts

packages/runtime-dsh-provider/src/client/
  completion-receipt.ts
```

### 任务

1. 先确认 Completion Receipt 属于持久会话事实，并声明最小 `SessionEventMap` 事件；若它只是跨会话报告，则改由独立 Host Service 持有，ADR 必须记录选择。
2. 用插件折叠 DSH 工具、审批、Windows 动作证据和验证事件，生成结果、执行步骤、验证项、失败项、证据位置与未验证声明。
3. 通过 Session Projection 或公开 Remote 把完成凭证交给 DSH Provider，不创建新日志或快照库。
4. 建立仅用于纵向验收的最小 Shell 根视图，不展开完整视觉系统。
5. 使用 DSH 现有丢帧、重连和历史补拉机制验证投影恢复。
6. 在 Loader 测试中卸载 Product Shell 插件 rows，确认完成凭证、Provider 和 Shell effects 全部释放；完整纵向 Profile 再把已通过阶段 0 拆分验证的 Host-only Windows Capability Bundle 作为独立层装入。移除 Product Shell Bundle 并重启后，确认新进程没有产品 UI 注册、Windows Bundle 仍可独立存在且权威 Session 数据保持。

### 测试场景

- 正常单轮任务；
- 工具调用成功和失败；
- 审批允许、拒绝和超时；
- 中途停止后恢复；
- 连接断开和丢失一帧后由 DSH Client Runtime 补拉历史；
- 插件 rows 的 effect 卸载/重挂载，以及 Product Bundle 移除/重启/重装；
- 底层不保证幂等时，未知命令结果进入 `needs_verification`；
- 完成凭证明确标注未执行的验证。

### 验收门槛

- 刷新页面不丢当前状态；
- 重启运行服务后可以恢复同一会话；
- UI 展示的“运行中/等待审批/完成/失败”全部来自 DSH facts 与正式小蛇领域事件；
- 第一条任务链具备可阅读的完成凭证；
- 仓库中不存在小蛇自建 Event Journal、Session Store、Replay Controller 或权威 Snapshot Store。

---

## 8. 阶段 3：会话连续性、来源与中文搜索

### 目标

把 DSH 已有的持久化、fork、Client resync、Session Query 和当前 loose Session 工作接入小蛇产品；只补来源与中文体验的真实缺口。

### 候选文件

- `packages/runtime-dsh-provider/src/client/session-lifecycle.ts`
- `packages/runtime-dsh-provider/tests/session-continuity.client.test.ts`
- `packages/native-shell/src/client/nest/session-search.ts`
- `packages/native-shell/tests/chinese-search.client.test.tsx`
- `packages/native-shell/src/client/nest/`

### 任务

1. 先核对 DSH loose Session/移入 Workspace 工作的提交、聚焦测试和公开 Client face；未满足时本阶段保持受阻，不复制实现到 XS。
2. 通过 DSH 公开 Session header、fork lineage、Workspace 和 Projection 映射来源、父分支、工作目录和关键运行配置。
3. 复用 `ctx.sessions.search()`/Host `ctx.sessionQuery`，建立包含常用中文、无空格中文句子、文件路径和工具轨迹的固定评测语料。
4. 如果 SQLite `unicode61` 对目标中文召回不足，在 `ctx.sessionQuery` Provider 能力缝内增加或替换索引 Provider；不得在 Shell 建第二份搜索索引。
5. 搜索结果返回命中片段、来源、时间和所属项目；记忆联合搜索只有在明确的数据权限与排序契约后再加入。
6. Shell 展示 DSH 已有恢复和分支事实，不自行推测来源。

### 验收门槛

- 不选项目也能开始会话；
- 会话可安全移入项目且历史保持不变；
- 分支来源可追踪；
- 固定中文评测语料给出可复验的召回结果，未覆盖字段明确标注；
- 会话恢复后工作目录和权限边界不漂移。

---

## 9. 阶段 4：上下文治理与记忆生命周期

### 目标

复用 DSH `ctx.compaction` 和 XS 现有 `memory-service`，把上下文与记忆的产品投影做成可观察、可编辑、可恢复的系统。

### 任务

1. 核对 DSH compaction Definition/Provider/Consumer 与现有 Session events，记录可直接复用项和真实缺口。
2. 为模型、会话和任务类型定义产品可解释的上下文预算；实际压缩仍由 `ctx.compaction` Provider 决定。
3. 通过现有 `compaction/*` 与 Session replacement 事实展示摘要、保留锚点和审计记录，不在 XS 再写压缩引擎。
4. 压缩期间如果发生写操作，沿用 DSH Provider 的并发与失败语义；缺口必须在对应能力插件修复。
5. 将记忆分为：
   - 当前会话；
   - 当前项目；
   - 长期记忆；
   - 已遗忘/可恢复记录。
6. 支持记忆创建、编辑、遗忘、恢复、来源查看和版本审计。
7. 现有 `memory-service` 保持唯一 XS 记忆所有者；通过独立 Provider/Consumer 接入 Product Bundle 与 Shell，不进入 `AgentRuntimeSession`，也不复制存储。
8. Shell 展示“本轮注入了什么”和“为什么注入”，但默认保持安静。

### Revision 4 实施收口

- 新建独立 `@xiaoshe/memory` Product 插件包，承接现有 `memory-service` 的唯一实现、Profile settings、工具、同源回环 API 和模型上下文注入；顶层 Windows 包改为兼容转发，不保留第二份实现或第二个存储。
- 记忆注入使用 DSH `systemPrompt.context` 的正式动态上下文机制，并以当前 Agent 的 `session.header.cwd` 选择项目记忆；禁止把记忆拼进 `AgentRuntimeSession` 或另写 Session 事件日志。
- 内容修订号与注入使用统计分离，后台记录使用次数不能让正在编辑的页面持续发生虚假 revision conflict。
- `ContextGovernance` 把 DSH `contextPressure`、`contextBreakdown`、`tokenUsage` 和 `taskTimeline` 中的 compaction 事实投影成可解释预算；未知字段保持未知，不依据模型名硬编码容量。
- 任务级计划：`docs/superpowers/plans/2026-08-25-xiaoshe-native-product-shell-phase-4.md`。

### 验收门槛

- 长会话压缩后可继续任务；
- 压缩前后的关键约束和文件来源不丢失；
- 用户能编辑和撤销记忆；
- UI 不出现无法追溯来源的神秘记忆；
- 预算与实际使用可查看。

---

## 10. 阶段 5：真实心跳、自动编排与验证凭证

### 目标

吸收 gstack 的流程纪律、OpenClaw 的后台机制和 cc-haha 的质量门禁，但不暴露成一排角色和斜杠命令。

### 任务

1. 建立 Heartbeat Service Definition、Host Provider 和 Shell Consumer；跨会话租约与任务状态由独立 Host Service/持久化域持有，只有语义上属于某一会话的开始、结果或失败才进入 Session events，不能把周期探测写成第二本会话日志：
   - 活跃时段；
   - 检查项；
   - 最近成功和失败；
   - 下次运行；
   - 暂停原因；
   - 失败退避。
2. 复用 DSH Jobs/Schedule/Session 事实，区分心跳、定时任务和前台任务；不得把 Schedule 定时器改名为心跳。
3. 建立自动编排策略：根据任务风险和复杂度选择计划、实现、审查、QA 和发布检查。
4. 角色只作为内部检查视角，不在产品 UI 中伪装成虚拟团队。
5. 建立验证路由：
   - 代码变更 → typecheck/test/build；
   - UI 变更 → 浏览器截图和交互证据；
   - Windows 动作 → 动作证据和必要的人工确认；
   - 持久化变更 → 升级、回滚和未知字段测试。
6. 完成凭证必须区分：已验证、部分验证、阻塞、未执行、待发布。

### Revision 4 实施收口

- Heartbeat 仍是跨会话持久租约与检查状态的唯一所有者；实际检查必须通过公开 `ctx.jobs` 作为真实后台 Job 执行，不能由状态账本直接伪造成功。
- DSH Schedule 继续只表示会话级耐久提醒。Heartbeat 不注册第二套 Schedule，也不把自己的 `setTimeout` 描述成 DSH Schedule；界面和 API 必须分开呈现两者。
- 每个检查项有稳定 id、间隔、活跃时段、上次结果、下次运行、失败次数和暂停原因；重启时遗留租约转为可解释的 interrupted/backoff 事实，然后按策略恢复。
- 验证策略输出明确的必需门禁和实际结果；高风险变更缺少证据时，完成凭证只能是 `partial`、`blocked` 或 `release_held`。
- 任务级计划：`docs/superpowers/plans/2026-08-25-xiaoshe-native-product-shell-phase-5.md`。

### 验收门槛

- 前端状态和心跳数据来自真实服务；
- 高风险任务会自动提高验证要求；
- 浏览器验收留下可复查证据；
- 没跑的测试不会被写成“已通过”；
- 后台失败不影响前台会话恢复。

---

## 11. 阶段 6：用户扩展治理

### 目标

在 DSH 现有 Loader、Profile 中的 Bundle 管理和会话级动态 Cordis 生命周期之上，先建立只读审计，再开放用户确认后的受控变更。小蛇不实现新的 Loader、pnpm 前端或动态插件状态机。

### 11.1 只读发现与审计

1. 从 DSH Host Plugin Inventory 和 Profile manifest 读取当前已组合插件；不通过文件名猜测运行状态。
2. 对用户明确提供的候选包读取 manifest、锁定来源与版本，解析请求的 Service、命令、依赖、网络访问和安装脚本；同时注明 manifest 权限不是 OS 沙箱。
3. 分开呈现 Host 插件/Bundle（Profile 作用域）与 Session-scoped Dynamic Plugin 的作用域和风险。
4. 给出兼容性、安全风险和推荐级别；只读阶段不执行 pnpm、安装脚本或动态 Package。

### 11.2 用户确认后的安装闭环

1. 显示将要创建、修改和执行的内容，以及 Bundle/安装脚本作为受信任主机代码运行、动态 Host VM 也不是安全边界的事实。
2. 候选 Bundle 优先安装到不活跃的 Xiaoshe 管理 Profile；健康验证通过前不替换当前可启动 Profile。
3. 用户确认后调用 `dsh plugin --profile ... add/remove/update`，不直接改写 Profile manifest。
4. Bundle 成员变化后按 DSH 约束重启目标 Profile，再用 `--dump-config`、Loader activation、功能探针和卸载探针完成健康检查；不得把配置热重载误当成 Bundle 已切换。
5. 安装失败保留旧可启动 Profile；清理失败或 pnpm 部分状态必须如实报告，不能宣称原子回滚。
6. 会话级动态插件复用 DSH 既有审批、run/update/rollback/undefine；小蛇增加来源和权限解释，实际约束只由它被授予的 Service 及这些 Service 自己的策略执行。
7. 保留完整审计记录，支持禁用、卸载、升级和恢复。

### Revision 4 实施收口

- Client 只负责展示 Inventory、审计结果和确认挑战；命令执行、Profile 文件定位、进程启动与健康探针全部属于 Host Provider，浏览器不得直接拼接或执行命令。
- Host Provider 只允许变更命名受控的非活跃 staging Profile。确认挑战绑定 action、profile、包名、版本/来源、manifest 哈希和过期时间；任一字段变化都必须重新确认。
- 候选包先只读解析 manifest 与来源。安装阶段只通过 `dsh plugin --profile ... add/remove/update` 修改，禁止直接编辑 Profile manifest；子进程使用 argv 数组并记录裁剪后的 stdout/stderr、退出码与时限。
- 健康门依次验证 CLI 成功、dump config、Loader 启动和候选功能探针。缺少功能探针时只能标记为部分健康，不能替换最后一个已验证 Profile。
- 回滚按变更前锁定依赖恢复；若 pnpm 残留或恢复失败，审计记录必须列出残留，禁止宣称原子回滚。
- 自动化闭环使用仓库内无安装脚本、无网络副作用的测试 Bundle 和临时 `DSH_HOME`；任何真实第三方插件仍需针对该候选逐次确认。
- 任务级计划：`docs/superpowers/plans/2026-08-25-xiaoshe-native-product-shell-phase-6.md`。
- 实施状态（2026-08-25）：本机受控机制已完成并记录于 `docs/evidence/native-shell-phase-6/acceptance.md`；真实第三方候选、OS 进程隔离、跨设备工件重定位和正式视觉插件管理页仍未宣称完成。

### 验收门槛

- 智能体不能静默安装插件；
- 风险和依赖在确认前可见；
- 安装失败不会替换最后一个已验证可启动 Profile；任何清理残留均明确列出；
- 卸载和回滚经过测试；
- UI 能区分“用户已同意”“Service 层已强制”和“无进程隔离”；没有可执行约束时明确显示为受信任代码，而不声称最小权限已强制。

---

## 12. 阶段 7：小蛇原生 Shell 扩展

### 目标

在产品契约稳定后，完成脱离 DSH 产品布局和文案、但继续复用 DSH 通用 Client 插件底座的信息架构。原生不等于复制 Connection、Remote、Runtime、Renderer 或 Slots。

### 12.1 身份脊柱

- 使用唯一合法 Logo；
- 品牌、连接状态和全局入口集中呈现；
- 不再沿用 DSH 顶栏布局和按钮语言。

### 12.2 巢册（会话与项目）

- 主按钮：新会话；
- 次按钮：新项目；
- 未归属会话与项目会话并列可见；
- 会话可迁移、搜索、分支和查看来源；
- 状态、阻塞和最近活动来自运行契约。

### 12.3 任务画布

- 以任务流、对话和结果为主，而不是复制 DSH 的“对话/轨迹”双页签；
- 工具、审批、验证和上下文变化按事件折叠展示；
- 运行状态固定在任务语境中，不做装饰性状态条。

### 12.4 行动薄片

- 输入、附件、模型和权限保持轻量；
- 复杂能力按需展开；
- 能力自动编排为默认，手动固定只用于特殊任务；
- 权限档位与能力方案分开，避免概念混淆。

### 12.5 小蛇控制中心

设置不再是 DSH 选项改名，而按小蛇的真实能力组织：

- 行为与表达；
- 会话、项目与默认目录；
- 长期记忆和上下文治理；
- 心跳和后台任务；
- 行动边界和审批；
- 模型与凭证；
- 插件与扩展；
- Windows/桌面桥接；
- 外观与性能；
- 诊断、导出和恢复。

### 验收门槛

- Product Bundle 的最终 dump config 不挂载被替换的 DSH 产品布局、品牌、侧栏和会话展示插件；
- Client module graph 不包含根包当前 DOM 注入版 `client.js`，Windows Host 能力来自已验证的 Host-only 组合；
- Shell 不导入 DSH 产品 UI 组件，不查询 DSH DOM/CSS；
- Shell 可以消费 DSH 通用 Connection/Remote/Runtime/Renderer/Slots 的公开服务；
- 新用户无需先创建项目即可开始任务；
- 设置项全部对应真实能力或明确标注“尚未可用”；
- 浅色、深色和窄窗口可用；
- 空会话无多余滚动条；
- 动态背景默认不加载；
- Logo 资产未被替换或重绘。

---

## 13. 阶段 8：迁移、回归与交接

### 任务

1. 为旧会话、旧设置和现有记忆提供只读导入检查。
2. 迁移前备份；迁移失败可回到原状态。
3. 未知字段保留，不因新版本覆盖旧数据。
4. 逐项移除 Shell 对 DSH 产品层的依赖；底层运行依赖保留。
5. 完成 Windows 端验收、浏览器验收、性能检查和交接说明。

### 验证矩阵

| 类别 | 必须验证 |
|---|---|
| 组合 | 独立 Profile、Bundle 层顺序、目标 UI rows 替换、公开 Client 依赖、启动/卸载/重启边界 |
| Service | Definition/DSH Provider/Shell Consumer/测试 Provider、版本兼容、Provider 替换与 effect 释放 |
| 运行事实 | DSH Session Log 唯一性、产品投影重建、原生 gap repair/reconnect resync、不确定副作用核验 |
| 持久化 | DSH 会话新装/升级/备份/恢复；小蛇自有设置、记忆和后台账本的未知字段与异常中断 |
| 会话 | 新建、未归属、项目内、迁移、分支、搜索、恢复 |
| 上下文 | 预算、压缩、锚点保留、记忆编辑/遗忘/恢复 |
| 动作 | 审批允许/拒绝/超时、Windows 证据、项目外边界 |
| 后台 | 心跳、暂停、退避、恢复、与定时任务隔离 |
| 插件 | Host 插件/Bundle（Profile 作用域）与 Session 动态作用域、发现、审计、确认安装、健康检查、卸载、失败残留 |
| UI | 浅色、深色、缩放、侧栏、空态、真实会话、设置 |
| 性能 | 空态 CPU/GPU、内存、长会话滚动、事件积压 |
| 交接 | 构建、测试、启动、诊断、恢复说明和证据索引 |

### 发布门槛

- 自动测试通过不等于发布批准；
- 浏览器烟测不等于完整 Windows 验收；
- 任何未验证项必须写入完成凭证；
- 用户确认前不合并当前分支；
- 用户确认前不发布、不覆盖另一台设备的工作。

---

## 14. 计划中的命令约定

阶段 0 脚手架完成后，建议形成以下独立命令；包名须由 ADR 固定，Profile 操作必须在隔离 `DSH_HOME` 中执行：

```powershell
pnpm.cmd --filter @xiaoshe/runtime-contract typecheck
pnpm.cmd --filter @xiaoshe/runtime-contract test
pnpm.cmd --filter @xiaoshe/runtime-dsh-provider test
pnpm.cmd --filter @xiaoshe/native-shell test
pnpm.cmd --filter @xiaoshe/native-shell build
pnpm.cmd --filter @xiaoshe/product-bundle test
pnpm.cmd --filter @xiaoshe/product-bundle pack
pnpm.cmd check

dsh plugin --profile xiaoshe-shell-probe add @deepseek-ai/dsh-web-app <product-bundle.tgz>
dsh --profile xiaoshe-shell-probe --dump-config
dsh --profile xiaoshe-shell-probe --no-open
dsh plugin --profile xiaoshe-shell-probe remove @xiaoshe/product-bundle
dsh --profile xiaoshe-shell-probe --dump-config

# 阶段 2：在新的隔离 Profile 中同时验证两个独立 Xiaoshe Bundle
dsh plugin --profile xiaoshe-shell-e2e add @deepseek-ai/dsh-web-app <host-only-windows-bundle.tgz> <product-bundle.tgz>
dsh --profile xiaoshe-shell-e2e --dump-config
```

这些包名和命令在阶段 0 ADR/脚手架落地后才成为正式约定。上面的启动与卸载验收是分开的进程：Bundle add/remove/update 后都要重启 Profile。当前代码库尚未具备这些新包，不能把上述命令写成“已通过”。

每个阶段还必须保存：

- 实际执行命令；
- 退出码；
- 测试数量；
- 浏览器截图或交互证据；
- 未执行项及原因；
- 对应提交或工作树状态。

---

## 15. 停止与回滚条件

出现下列任一情况时停止扩展功能，先解决底层问题：

- Product Bundle 无法在隔离 Profile 中完成 build/pack/install/dump/start/remove/restart；
- 树外 Client 插件需要深导入 DSH 源码、未发布构建 preset、私有 store/事件对象或读取 DSH DOM 才能工作；
- Windows Host 能力无法在保留旧 Profile 可恢复路径的同时脱离当前 DOM 注入 Client face；
- 方案开始创建第二套 Agent loop、Session Log、Client Runtime、搜索索引、插件 Loader 或 Profile 包管理；
- 产品投影无法从 DSH 权威事实和正式 Host Service 重建；
- 持久化升级不能回滚；
- Shell 被迫直接读取 DSH 私有状态；
- DSH loose Session 工作尚未形成已验证提交，却被当作已交付依赖；
- Windows 桥接回归或权限边界变模糊；
- 动态视觉效果造成明显卡顿；
- 插件安装失败残留无法隔离或无法恢复最后一个已验证可启动 Profile；
- 三个工作树的用户改动存在被覆盖风险。

回滚优先级：停止新测试 Profile → 移除 Product Bundle 并重启 → 恢复 Profile/数据备份 → 回到旧入口 → 保留失败证据，不通过删除工作树或清理未提交内容“解决”。

---

## 16. 实施优先级摘要

### P0：先做

1. 工作树冻结、能力复用表和事实所有权 ADR；
2. Windows Host Bundle 与旧 DSH 皮肤 Client 的可逆拆分探针；
3. 树外 Client 插件构建与 Product Bundle 的真实安装/启动/卸载证明；
4. `AgentRuntimeSession` Definition、DSH Provider、Shell Consumer 和测试 Provider；
5. 基于 DSH Session Log/Client Runtime 的第一条真实任务纵向切片；
6. Completion Receipt 插件和卸载生命周期；
7. 验证后接入未归属会话、来源、中文搜索与 `ctx.compaction`；
8. XS 记忆 Service 的 Provider/Consumer 接入；
9. Heartbeat Definition/Provider/Consumer 与真实后台账本。

### P1：随后做

1. 自动编排和风险门禁；
2. 浏览器验收证据；
3. 基于 DSH Inventory 的插件只读发现和安全审计；
4. 原生巢册、任务画布、行动薄片和控制中心；
5. 持久化升级与回滚矩阵。

### P2：稳定后再做

1. 用户确认后的插件安装完整闭环；
2. 更复杂的多 Agent 协作界面；
3. ACP 等兼容协议；
4. 动态背景的低功耗重做；
5. 跨设备任务接力的进一步自动化。

---

## 17. 本计划明确不做的事

- 不把 gstack 的二十多个角色和斜杠菜单搬进小蛇；
- 不把 Multica 的组织管理界面完整复制进个人桌面 Agent；
- 不把 Hermes、Kimi、OpenClaw 或 CodeWhale 整仓搬入；
- 不创建第二套 Agent loop 与 DSH 竞争；
- 不创建第二套 Session Log、Client Runtime、搜索索引、插件 Loader 或 Profile 包管理；
- 不从 XS 深导入 `runtime/DSH` 源文件、未发布构建 preset、私有 store 或数据库；
- 不把 DSH 当前 dirty 工作树里的能力写成已交付；
- 不在 Product Bundle 证明失败后静默改成独立协议栈；
- 不允许智能体静默安装插件；
- 不把动态背景作为原生壳前置条件；
- 不通过更名和换色把 DSH 设置页称为“小蛇专属化”；
- 不在没有证据时宣称迁移、验证或发布完成。

这份计划的核心不是增加更多页面，而是先建立一套小蛇真正拥有、可安装、可卸载、可审计、可验证的产品组合与门面；权威运行事实继续由 DSH 插件底座拥有。原生界面建立在这个组合之上，而不是继续围绕 DSH 页面做装饰性修改。
