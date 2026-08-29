# 小蛇原生产品壳设计

**日期：** 2026-08-23
**版本：** Revision 3
**状态：** 已按 DSH 当前实现完成现实复核，尚未实施
**实施分支：** `codex/xiaoshe-native-shell`
**合并约束：** 必须先形成可运行预览、完成证据验收并取得用户明确确认；本文不授权合并

## 1. 结论

小蛇需要的不是继续美化 DSH，也不是先画一套新界面再补能力，而是在 DSH 已有 Cordis 插件树、Session Log 和 Client Runtime 上建立小蛇自己的产品组合与窄能力门面。独立产品壳只依赖公开服务和这些产品能力门面，不读取 DSH DOM，也不再实现一套运行时。

重写后的顺序是：

1. Cordis/DSH 保持唯一运行宿主，当前组合只挂载一个 Agent-loop Provider；Agent loop 仍是可由配置替换的插件，不被重新定义成不可替换内核；
2. DSH Session Log 保持唯一权威交互日志，现有 Client Runtime 继续负责会话、历史、断帧补拉和重连；
3. `AgentRuntimeSession` 是小蛇的薄会话生命周期 Service Definition，默认 Provider 委托 DSH 公开服务，Shell 是 Consumer；它不拥有第二套 Agent loop、Event Journal、Session Store，也不吸收其他能力 Service；
4. 小蛇原生壳以可安装 Product Shell Bundle 和 Client 插件交付，并与拆分后的 Host-only Windows Capability Bundle 分别装入隔离的 Xiaoshe Profile；它复用 DSH Connection、Remote、Runtime、Renderer 等非产品视觉底座，不复用 DSH 产品布局、文案和组件；
5. 会话连续性、搜索、压缩、设置和插件清单优先复用 DSH 已有能力缝，只有真实缺口才新增插件；
6. 首次交付用一个完整纵向任务闭环和一次安装/卸载闭环证明架构，而不是同时铺开所有页面。

原方案中“独立产品壳”的方向保留，但“先在当前包内建立 `src/shell` UI 骨架”和“另建 Event Journal/Snapshot Store”的顺序取消。当前根包 `@xiaoshe/dsh-desktop-control` 的 Host half 是可卸载的 Windows 能力插件，但包本身还同时声明 `dsh.client`，其 `client.js` 含 DSH DOM 注入；它不能原样进入最终原生 Profile，也不应继续同时承担旧皮肤和 Host 能力职责。

## 2. 产品命题

小蛇是一个可信、连续、安静而能真正接手电脑任务的个人智能体。

它的核心体验不是“和模型聊天”，而是：

> 用户交代目标 → 小蛇理解与编排 → 调用真实能力执行 → 风险处请求决定 → 中断后可恢复 → 最后交付结果、来源与验证证据。

小蛇应给人“一个完整智能体”的感觉。内部可以使用多个检查视角、子代理或工具，但产品不要求用户扮演团队管理者，也不把 CEO、QA、发布经理等角色包装暴露成主要交互。

## 3. 不再接受的旧框架

以下做法不属于原生产品壳：

- 在 DSH 三栏结构上换颜色、字体、Logo 和文案；
- 继续依赖 DSH 的 DOM、CSS 类名、工具栏和设置弹窗；
- 用永久右栏承载所有状态、记忆、系统和证据；
- 把“能力模式”与“权限模式”混在一个下拉框里；
- 用模拟进度、装饰数字或静态文案冒充真实运行状态；
- 在没有恢复、事件重放和完成凭证前先做大量视觉页面；
- 为了显得强大而暴露内部角色、斜杠命令或插件安装细节；
- 在当前 Windows 适配器包中直接塞入完整前端应用。

## 4. 设计原则

### 4.1 事实优先

界面只显示运行时能够证明的状态。任务阶段、工具行动、审批、失败、重试、心跳、验证与完成都来自 DSH 权威 Session events、正式 Host Service 或可重建产品投影。

### 4.2 连续性优先

刷新、断线、进程重启或设备切换后，用户应能知道：

- 上一次做到哪里；
- 哪些行动已经发生；
- 哪些审批仍有效；
- 为什么中断；
- 是否可以继续；
- 继续后是否重复执行了副作用。

### 4.3 安静默认、逐层展开

常态只显示用户当前需要理解和决定的内容；任务树、工具细节、来源、日志、上下文预算与插件健康按需展开。

### 4.4 能力与权限分离

“小蛇如何组织能力”由自动编排决定；“小蛇可以做多大范围的事情”由用户权限策略决定。两者不能再共用“模式”概念。

### 4.5 安全不是弹窗数量

安全来自明确的作用域、风险分类、可撤销性、真实证据与一致策略。低风险操作可以自动完成，高风险和跨边界操作必须说明影响并请求决定。

### 4.6 本地优先、可迁移

会话、项目、记忆、证据与扩展状态应有清晰来源、版本和可导出结构，不把用户锁在一次浏览器会话里。

### 4.7 Windows 是一等平台

Windows bridge、PowerShell 执行策略、桌面视觉与动作、凭证存储、进程恢复和本机验收都属于产品架构，不是最后补的兼容层。

### 4.8 一切皆插件，但不把每个文件都拆成插件

“一切皆插件”约束的是可独立替换的产品能力和运行生命周期：Agent loop、会话持久化、搜索、压缩、Windows Bridge、完成凭证、心跳和产品 Shell 组合都必须由 Cordis 插件、Service Definition/Provider/Consumer 或 Profile/Bundle 承载。纯类型协议、无状态工具库和插件内部的 React 组件可以保持普通模块；不能为了字面插件化制造无消费者的服务或过细包。

术语不可混用：Profile 是用户启动的具名组合，Bundle 是声明 `dsh.bundle`、向该组合贡献 `cordis.patch.yml` 的可安装包；一个包不能同时把自己当 Profile 和 Bundle。小蛇交付 Product Bundle，验收时把它安装进隔离的 Xiaoshe Profile。

Bundle 之间也不互相“包含”：目标 Xiaoshe Profile 按顺序叠放 DSH Base/Web Bundle、Host-only 的 `@xiaoshe/dsh-desktop-control` Windows Capability Bundle 和新的 Product Shell Bundle。当前包在达到 Host-only 目标前，须把旧 `client.js` 迁到仅供兼容 Profile 使用的独立 Client 插件；Product Shell Bundle 不接管 Windows Bundle 的包身份或生命周期。

`AgentRuntimeSession` 也不能成为新的 Service Locator 或“所有能力必经”的特权核心。它只收敛小蛇必需的会话运行生命周期与产品状态；搜索、Workspace 操作、审批、压缩、完成凭证和心跳继续由各自的公开 Service/Projection/Remote 提供，Shell 作为多个窄能力的 Consumer 组合体验。

## 5. 总体架构

### 5.1 运行宿主：Cordis/DSH

DSH 继续是唯一运行宿主，但不是不可替换的单体内核。当前 Profile 组合一个默认 Agent-loop Provider，并由其他插件分别提供：

- 模型调用与 Agent loop；
- 工具执行、审批、沙箱和插件运行；
- DSH 已有会话、日志、持久化、重试与运行能力；
- 已存在的 RPC/HTTP/事件通道。

小蛇不复制第二套 Agent loop，也不修改 `agent-loop` 私有实现。新行为优先挂到公开 Service、SessionEventMap、Projection、Remote 或 Client Slot；如果公开扩展点无法表达，先停止并记录缺口，而不是直接建立旁路运行时。

### 5.2 唯一会话事实源：DSH Session Log

DSH `SessionEvent` 日志是模型历史、恢复、分支、持久化和会话内完成事实的唯一权威来源。DSH Client Runtime 已根据事件 seq、历史尾页、断帧检测和重连 resync 建立连续客户端状态。小蛇不得再写第二本追加式事件日志，也不得把可重建快照升级为独立事实源。

新增的完成凭证、心跳、验证或小蛇领域事实必须满足其一：

- 需要持久化和回放的事实声明合适的 `SessionEventMap` 事件，并由投影插件读取；
- 跨会话但不属于单次交互历史的事实由已有或新增 Host Service 持有，并通过公开 Remote 暴露；
- 纯 UI 状态留在 Client 插件，不写入 Session Log。

### 5.3 小蛇产品运行门面

在 DSH 公开 Host/Client 服务与产品壳之间建立版本化的 `AgentRuntimeSession` Service Definition。它负责：

- 创建、发送、停止和分支这组最小会话生命周期命令；
- 产品状态投影；
- DSH 同步状态；
- 兼容版本；
- 错误和降级语义。

默认 DSH Provider 消费 `ctx.sessions`、必要的 `ctx.workspaces` 创建入口和 DSH Session 投影；原生 Shell 消费该服务；测试可以挂载内存 Provider。门面不持有权威历史，不复制 DSH Client Runtime 的连接循环，也不把私有 DSH 类型泄漏给 Shell。其他能力不因产品壳需要统一视觉就被塞进这个 Provider。

### 5.4 连续性与上下文层

该产品层优先组合 DSH 已有 Provider 和 XS 既有记忆 Service，负责呈现与补足：

- 会话持久化、恢复、分支和来源追踪；
- 中文标题、内容、来源和项目搜索；
- 上下文预算、压缩、摘要来源与恢复点；
- 长期记忆、项目记忆、版本、遗忘和恢复；
- 不同设备之间的可迁移记录。

### 5.5 可靠性与编排层

该层由完成凭证、心跳、验证路由等独立插件组合，负责：

- 隐式自动编排与风险门禁；
- 真心跳、后台租约和失联判断；
- 验证路由与完成凭证；
- 任务树、子任务预算、阻塞和接续；
- 运行中断后的幂等保护。

### 5.6 能力与扩展治理层

该层复用 DSH Loader、Profile 中的 Bundle 管理与会话级动态 Cordis 生命周期，只由独立治理插件补充：

- 能力目录与只读发现；
- 来源、版本、哈希、兼容性和权限审计；
- 用户确认后的安装、升级和扩大权限；
- 健康检查、禁用、卸载与回滚；
- Cordis effect 清理、最后已验证 Profile 保留和失败诊断；只有存在真实进程/OS 沙箱时才声明故障或权限隔离。

智能体可以建议或准备安装方案，但不得静默安装第三方扩展。

### 5.7 小蛇原生产品壳

产品壳负责：

- 独立产品根视图、路由、组件树和 design tokens；
- 小蛇自己的信息架构与交互语言；
- 将运行契约映射为任务体验；
- 项目、临时会话、记忆、证据和设置的产品组织；
- 性能、可访问性和 Windows 桌面体验。

产品壳不得查询 DSH 页面类名、替换 DSH 文案或依赖其 DOM 骨架。

## 6. 建议代码边界

阶段 0 完成仓库 ADR、外部 Client 插件构建和真实 Profile 安装验证后，优先采用以下边界：

```text
packages/
  runtime-contract/       # Definition：抽象 Cordis Service、产品命令、投影、错误与版本
  runtime-dsh-provider/   # Cordis Provider：委托 DSH 公开 Host/Client 服务
  native-shell/           # Client 插件：小蛇根布局、组件和 design tokens
  product-bundle/         # dsh.bundle patch：组合运行插件并替换产品 UI roster
```

当前根包继续作为 Windows/DSH 桥接能力包，不在首阶段迁移 Host 实现目录。阶段 0 优先选择“根包保留 Host/Bundle 身份、旧 `client.js` 迁入兼容 Client 包”的拆分；只有打包或兼容证据否定该路径时，才评估不复制 Host 实现的 Host-only wrapper。最终目录名可以在 ADR 中微调，但必须满足：

- 契约不依赖 UI；
- UI 不依赖 DSH DOM；
- 最终 Xiaoshe Profile 不加载当前 DOM 注入版 `client.js`，旧皮肤兼容包不进入 Product Shell Profile；
- Product Bundle 通过 `dsh plugin --profile <name> add/remove` 安装和卸载；
- Bundle 成员变化在 Profile 下次启动时生效，不能把用户 patch 热重载写成 Bundle 热切换；
- Provider 和 Client 插件通过 Cordis effect 生命周期注册并完全释放；
- DSH Session Log 是唯一权威历史，产品投影可从公开历史和投影重建；
- 不从 XS 代码深导入 `runtime/DSH` 源文件或私有模块；
- runtime Provider 可以独立测试并由内存 Provider 替换；
- Windows 能力通过适配器接入；
- DSH/Cordis 仍是唯一运行宿主。

根包内部也要按能力拆 row，而不是按文件拆 npm 包：桌面 Bridge/Tools/动作策略、记忆、产品身份/表达和兼容 UI 分别拥有 Cordis 插件入口与 effect。Product Shell Bundle 组合新的产品身份插件；旧身份/皮肤只留在兼容 Profile；记忆在阶段 4 通过自己的 Provider/Consumer 接入。当前顶层聚合 `apply()` 可在迁移期作为兼容入口，但不得进入最终 Product Shell Profile。

当前 DSH 的共享 Client 构建 preset 尚未作为公共包发布；树外插件必须依据公开 `dsh.client` 产物契约建立自己的最小构建，不得从 `runtime/DSH` 导入未发布 preset 或把 DSH 私有源码复制进 XS。这是阶段 0 必须实测的风险，不是已解决事实。

如果阶段 0 无法用已打包依赖和公开 Client 插件契约完成真实安装、启动和卸载，必须停止并重新做架构决策；不得在同一计划中静默退回独立协议栈或复制 DSH Client Runtime。

## 7. `AgentRuntimeSession` 产品契约

### 7.1 插件角色

- **Service Definition：** `runtime-contract` 提供可注册的抽象 Cordis Service、Context augmentation，以及小蛇产品命令、只读投影、同步状态、错误和版本；它只把 `@deepseek-ai/cordis` 作为运行时 peer，不导入 DSH 实现或 React。
- **Service Provider：** 默认 DSH Provider 通过公开 `ctx.sessions`、必要的 `ctx.workspaces` 创建入口和 Session Projection 完成最小会话生命周期委托；不得自行保存 Session 历史或聚合 Windows/审批/搜索等其他能力。
- **Consumer：** 小蛇 Native Shell 只消费该服务和自己的 UI slots，不读取 DSH DOM、私有 store 或数据库。
- **测试 Provider：** 内存 Provider 复现相同产品状态，供组件测试使用；它不是生产回退运行时。

### 7.2 第一版命令

第一版产品命令及其现实来源为：

| 产品命令 | 默认 DSH Provider 的来源 |
|---|---|
| `createSession` | 经 `ctx.workspaces`/`ctx.sessions` 使用已验证的项目或 loose Session 创建入口 |
| `sendTurn` | 当前 Session 的公开 `prompt()` |
| `stopRun` | 当前 Session 的公开 `cancel()` |
| `forkSession` | `ctx.sessions.fork()` |

以下能力明确不进入 `AgentRuntimeSession`：

- 搜索直接消费 `ctx.sessions.search()`/Host `ctx.sessionQuery`；
- 移入 Workspace、归档和 Workspace 管理直接消费公开 `ctx.workspaces`，且 loose Session 工作必须先形成已验证提交；
- 审批消费 DSH 公开 Interaction/Remote；公开面不足时补 DSH 能力缝，不扩张会话门面；
- 压缩消费 `ctx.compaction` 的公开 Consumer/Remote，不重写压缩引擎；
- 完成凭证和心跳分别拥有窄 Service/Projection 与 Provider/Consumer。

生产门面不得把底层不支持的幂等性包装成“已保证”。新的有副作用命令必须使用底层已验证的幂等键或先补正式扩展点；传输结果不确定时返回“需要核验”，不能自动重试。

### 7.3 事实与产品投影

产品契约不再定义第二套事件信封。它消费 DSH `SessionEvent.seq`、Client Runtime 的连续窗口和 Host Projection，并输出带 `schemaVersion` 与来源 seq 的只读产品投影：

- 会话身份、项目归属和来源；
- 当前运行阶段与 DSH 同步状态；
- 用户目标、计划、任务树和子任务状态；
- 待审批项目；
- 已执行行动与证据索引；
- 上下文预算与压缩记录；
- 心跳与最后活动时间；
- 完成凭证或失败/中断原因。

投影必须可由 DSH 权威日志、Host Service 和配置重新建立；本地缓存可删除后重建，不参与冲突裁决。

### 7.4 状态机

产品运行状态统一为：

```text
idle
planning
awaiting_approval
running
blocked
stopping
completed
failed
interrupted
archived
```

另设独立同步状态 `connecting | ready | reconnecting | resyncing | error`。运行状态由 DSH 事实和新增领域事件投影，界面不依据“多久没收到文本”猜测；同步状态也不能被误写成任务失败。

### 7.5 恢复语义

- 页面刷新、连接中断和断帧修复复用 DSH Client Runtime 的历史尾页、seq gap repair 与 reconnect resync；小蛇不实现第二套 cursor 协议；
- 进程重启复用 DSH Session Persistence/Resume；
- 已成功的副作用不重复，不确定结果进入“需要核验”；
- 用户能看到恢复来源和中断原因；
- 分支会话记录父会话、分支点和继承上下文；
- 跨设备接续必须校验产品契约版本、DSH 会话格式和本机能力；
- Provider 卸载必须取消订阅、停止本插件拥有的后台任务并释放投影，不能停止或删除 DSH 权威会话。

## 8. 自动编排：学习团队纪律，不复制团队包装

小蛇默认使用“自动编排”：

- 根据任务自动选择计划、实现、审查、验证和发布检查；
- 复杂任务可拆分子任务并行处理；
- 高风险步骤自动增加审查与证据门槛；
- 浏览器、Windows 和发布类任务必须有对应验收证据；
- 最终完成状态由证据决定，不由模型自报决定。

用户只需要看到：

- 当前目标；
- 为什么这样安排；
- 正在做哪一步；
- 哪些检查已执行；
- 哪个决定需要用户；
- 最后有什么证据。

用户不需要选择 CEO、设计师、QA 等角色，也不依赖斜杠命令进入某种人格。

## 9. 小蛇原生信息架构

### 9.1 身份脊柱

左侧常驻区域应窄而稳定，只承载：

- 唯一合法 Logo：`runtime/xiaoshe-legacy/ui/assets/snake.svg`；
- 小蛇名称与必要的运行状态；
- 打开“巢册”；
- 新任务；
- 打开“小蛇中枢”。

它不是传统文件树，也不永久塞入搜索、筛选、项目和所有会话。

### 9.2 巢册

项目、临时会话、历史、搜索和来源进入按需展开的“巢册”：

- “新会话”是主动作；
- “新项目”是相邻次动作；
- 用户可以不建项目直接开始；
- 临时会话进入专用根目录，每个会话拥有独立子目录；
- 会话之后可迁移到项目，历史、来源和工作文件一起保留；
- 支持中文标题、正文、来源、项目和时间搜索；
- 分支关系和恢复来源可展开查看。

项目外会话的详细行为沿用并收敛现有《projectless sessions/settings》方案，不在本文重新发明第二套规则。

### 9.3 任务画布

中央区域是任务过程，不是消息气泡堆叠：

- 目标；
- 小蛇理解；
- 计划；
- 当前步骤；
- 工具行动；
- 风险与审批；
- 阻塞、中断和恢复；
- 结果；
- 验证与完成凭证。

空会话固定在当前可视高度内，不创建无意义滚动；正式任务才出现历史滚动。

### 9.4 行动侧页

永久右栏取消。与当前任务相关的细节通过按需侧页呈现：

- **现在：** 当前步骤、阻塞、重试、子任务和心跳；
- **证据：** 测试、截图、日志、哈希和验收结果；
- **记忆：** 当前任务使用了什么、来源与版本；
- **环境：** 模型、桥接、桌面能力、权限和健康状态。

侧页关闭后不影响任务运行，也不占用常态画布宽度。

### 9.5 小蛇中枢

设置不是换名字的 DSH 弹窗，而是按小蛇能力组织的全页控制中心：

1. **行为与表达**
   - 亲和 / 务实；
   - 自动编排；
   - 计划与解释的显示密度。
2. **记忆与上下文**
   - 长期记忆、项目记忆；
   - 记忆来源、版本、编辑、遗忘和恢复；
   - 上下文预算、自动压缩和压缩记录。
3. **后台与恢复**
   - 真心跳；
   - 活跃时段；
   - 后台任务、租约、失联和接续；
   - 恢复点与跨设备迁移。
4. **行动边界**
   - 只读；
   - 逐项确认；
   - 项目内自主；
   - 跨项目、系统级、网络发布和安装扩展的独立规则。
5. **模型与凭证**
   - 提供者、模型和路由；
   - 安全凭证状态；
   - 不回显完整密钥。
6. **扩展与能力**
   - 已发现、已审计、待确认、已安装、异常、可回滚；
   - 能力范围、来源、版本和权限差异。
7. **Windows 与桌面**
   - bridge 状态；
   - 屏幕理解和动作能力；
   - Doctor 与本机验收；
   - PowerShell、进程和安全策略。
8. **外观与性能**
   - 明暗主题；
   - 动效等级；
   - 性能与辅助功能；
   - 已封存高成本背景默认不加载。

金融等垂直能力只有在真实扩展安装并声明能力后才出现，不作为空壳开关。

## 10. 权限语义

权限只表达行动边界：

- **只读：** 可以理解、搜索、检查和给出方案，不改变外部状态；
- **逐项确认：** 每个有副作用的关键行动都请求决定；
- **项目内自主：** 在当前项目和已授权能力内自主执行，跨边界仍确认；
- **扩展授权：** 安装、升级、联网发布、系统级操作等单独授权。

“标准 / PTC / 极简 / 创造”等能力组合不再作为用户主要入口。内部工具组合由自动编排选择，固定组合只留给高级用户或可复现实验。

## 11. 上下文与记忆治理

### 11.1 上下文预算

每次运行显示可解释的预算状态，而不是只显示 token 数字：

- 当前上下文压力；
- 哪些内容将被压缩；
- 压缩后保留的来源；
- 是否存在不可恢复信息；
- 最近恢复点。

### 11.2 压缩

- 压缩必须生成可追溯摘要；
- 压缩记录与原始事件建立来源关系；
- 工具调用正在改变状态时，不直接丢弃其未完成信息；
- 压缩失败不破坏原会话；
- 允许用户查看压缩前后的关键差异。

### 11.3 记忆生命周期

每条记忆有：

- 来源；
- 作用域；
- 创建与更新时间；
- 当前版本；
- 使用记录；
- 编辑与遗忘；
- 可恢复的历史版本。

不使用一个虚假的“长期记忆总开关”代表所有行为。

## 12. 真心跳与真实状态

心跳只表示运行时真实租约或后台任务活性：

- 最后心跳时间；
- 当前任务或租约；
- 活跃时段；
- 正常、延迟、失联、已停止；
- 失联后的恢复策略。

普通对话没有后台任务时显示“空闲”，不持续制造心跳动画。

定时任务与心跳分开：

- 心跳用于活性和失联判断；
- 定时任务用于在某个时间触发工作。

Heartbeat Provider 复用 DSH Jobs/Schedule 的真实运行事实，但跨会话租约由自己的 Host Service 与持久化域负责；只有语义上属于某一会话的开始、结果或失败才声明 Session event。它不是第二本会话日志，也不能把周期性探测写满每个 Session Log。

## 13. 验证与完成凭证

任务只有在形成完成凭证后才能显示“已完成”。凭证至少包含：

- 用户目标摘要；
- 实际变更或输出；
- 执行过的验证；
- 通过、失败、跳过和未覆盖项；
- 关键证据路径或哈希；
- 风险与回滚方式；
- 完成时间与运行版本。

如果只完成部分工作，状态必须是“部分完成”；若缺少外部授权或环境，状态是“受阻”，不能包装成成功。

## 14. 扩展生命周期

本节治理的是“用户可安装扩展”，不是另造插件运行时。DSH 已有 Loader 清单、Profile 中 Bundle 的安装/移除和会话级 Cordis 动态插件生命周期；小蛇复用这些机制，只补来源审计、权限解释、确认、健康与失败处理。Bundle（Profile 作用域）和会话级动态插件是不同作用域，界面与审计记录必须明确区分。

安全语义必须如实标注：安装进 Profile 的 Bundle 是随 DSH 进程加载的受信任主机代码；动态 Host Package 的 `node:vm` 只隔离全局对象，不是安全边界，声明过的 Service 可以触达真实运行时。manifest 和确认记录表达“用户知情同意”，真正的限制只来自被调用 Service 自己的 sandbox、approval、文件系统或进程 Provider；没有独立进程/OS 隔离时，不得显示成“插件被权限沙箱完全限制”。

### 第一阶段：只读发现与安全审计

- 读取 DSH Host Plugin Inventory、Profile manifest 和候选包元数据；
- 解析 manifest；
- 检查来源、权限、入口、兼容性、网络和安装脚本；
- 生成审计结果，不安装。

### 第二阶段：用户确认后的安装

- 展示将新增的能力、请求的 Service、安装脚本和实际可执行权限；
- 用户确认后调用受控的 DSH Profile 安装流程，或批准会话级动态插件 Package；
- 记录版本、哈希、来源和作用域；
- Bundle 成员变化后重启隔离 Profile，再执行 dump、Loader activation 和功能健康检查。

### 第三阶段：维护与回滚

- 升级前比较权限变化；
- 异常时可禁用；
- 支持卸载；
- 保存锁定版本、Profile 备份和最后已验证启动证据；
- 在不活跃 Profile 验证变更，失败时保留最后已验证 Profile；没有进程隔离时不得承诺任意 Host 插件故障绝不影响当前进程。

小蛇不得复制 pnpm、Cordis Loader、Profile manifest 或动态插件状态机。安装脚本属于 Agent 沙箱之外的受信任主机代码；没有来源审计和用户确认时不得执行。

## 15. 视觉与性能

- 使用小蛇既有青绿、金色、雾面层次与克制金属渐变；
- 唯一合法 Logo 不得另画、变形或替换；
- 动效表达“感知、游动、接手、完成”，但不以持续高成本渲染换取氛围；
- 已开发的动态蛇形背景完整封存，默认不导入、不初始化、不创建 RAF；
- 空会话优先静态或事件触发的轻量背景；
- `prefers-reduced-motion`、低性能设备和后台标签页必须降级；
- 视觉状态不得成为运行事实源。

## 16. 当前实现分级

### 已落地

- Windows bridge 与动作能力；
- 动作前确认与部分验证证据；
- memory service 的基础实现；
- Doctor / 诊断脚本与 Windows 启停能力。

### 部分落地

- 任务完成证据已有基础，但尚未统一为完成凭证；
- DSH 已有插件化 Host/Client、权威 Session Log、Client Runtime、断帧补拉、重连、搜索、压缩、设置和插件清单；小蛇还没有产品 Bundle 与稳定门面；
- 根包已有合法 Bundle/Host 插件，但仍把多项能力放在一个 `apply()`，且 package-level Client face 含 DOM 注入；Host rows 与兼容 Client 尚未拆分；
- UI 已有小蛇品牌元素，但仍是 DSH 页面注入，不是独立产品壳。

### 工作树实现中，不能算已交付

- DSH 当前未提交工作树包含项目外 loose Session、移入 Workspace 和对应测试；只有形成独立提交并通过聚焦验证后，原生壳才能把它列为可依赖基线。

### 仅有方案

- 身份脊柱、巢册、任务画布、行动侧页和小蛇中枢；
- Xiaoshe Product Bundle、AgentRuntimeSession Provider 和原生 Shell Client 插件。

### 尚未落地

- 小蛇 `AgentRuntimeSession` Service Definition 与 DSH Provider；
- 对 DSH 现有恢复、分支、搜索和压缩能力的产品接入与中文验收；
- 真心跳与后台租约；
- 统一完成凭证；
- 基于 DSH 现有清单/安装/动态生命周期的扩展审计和健康闭环。

## 17. 首个纵向闭环

首批实现不从“画完整首页”开始，而是完成一个可验证任务闭环：

1. 创建项目外会话；
2. 发送一个真实任务；
3. DSH Provider 从现有 `ctx.sessions`、公开 Remote 和 Session Projection 形成小蛇产品投影；
4. 产品壳显示计划、当前步骤和工具行动；
5. 风险操作请求审批；
6. 中途停止并恢复；
7. 最终执行验证；
8. 生成完成凭证；
9. 刷新页面或丢失事件后由 DSH Client Runtime 补拉历史并 resync，小蛇投影恢复一致；
10. 中文搜索能找到该会话；
11. 会话可迁移到项目并保留来源；
12. Product Bundle 可从测试 Profile 移除；重启后所有小蛇 UI、订阅和后台任务消失，DSH 会话数据保持不变。

这个闭环通过后，再扩展完整巢册、小蛇中枢、记忆管理和插件中心。

## 18. 验收标准

### 架构

- DSH/Cordis 仍是唯一运行宿主，当前只挂载一个 Agent-loop Provider；
- Product Bundle 能通过真实 Profile 安装、dump config、启动、移除和重启验收；
- Windows Capability Bundle 与 Product Shell Bundle 在 Profile 中是两个独立层，任一移除不改写另一包；
- `AgentRuntimeSession` 具备 Definition、DSH Provider、Shell Consumer 和测试 Provider；
- `AgentRuntimeSession` 只覆盖最小会话生命周期；移除 Completion Receipt、Heartbeat 或其他可选 Provider 时，只撤下对应能力，不破坏基本会话；
- 小蛇产品壳只依赖版本化产品契约与通用 Client 插件底座；
- 当前 Windows 适配器包不承担完整前端应用职责；
- UI 核心代码不查询 DSH DOM/CSS；
- 不从 XS 深导入 `runtime/DSH` 源文件或私有模块；
- 契约、Provider、Shell 和 Bundle 可以分别测试；
- Provider 卸载后注册、订阅、计时器和本插件拥有的进程全部释放。

### 运行事实

- DSH Session Log 是唯一权威历史，小蛇没有第二本 Event Journal；
- 状态来自 DSH 事件、Host Service 和可重建产品投影；
- 断线和 seq 缺口由 DSH Client Runtime 的历史补拉与 resync 修复；
- 中断可恢复且不重复已确认副作用；
- 完成必须有凭证；
- 心跳只在真实后台运行时出现。

### 产品体验

- 去掉颜色与品牌文字后，结构仍明显不是 DSH；
- 用户无需先建项目即可开始；
- 项目、历史、证据和设置按需出现；
- 常态界面不使用永久三栏；
- 能力编排与权限边界清晰分离；
- 中文搜索、记忆来源和上下文压缩可解释。

### 安全与扩展

- 第三方扩展不能静默安装；
- Bundle（Profile 作用域）与会话级动态插件的作用域清楚区分；
- 安装前能看到来源、兼容性、受信任主机代码边界和实际可执行权限；
- 安装后有健康检查；
- 能卸载，并能恢复最后已验证 Profile；非原子残留必须如实报告；
- Cordis effect 能释放；没有真实进程隔离时不虚构 Host 插件的故障隔离。

### Windows 与性能

- Windows bridge 与动作安全不倒退；
- 空会话不加载高成本动态背景；
- 页面在浅色、深色、缩放、折叠和低动效条件下可用；
- Windows 本机验收有截图、日志、测试输出和构建哈希。

## 19. 决策与非目标

### 已决定

- 原生壳采用“组合与复用优先”；
- DSH/Cordis 保持唯一运行宿主，默认 Agent loop 仍是可替换插件；
- DSH Session Log 与 Client Runtime 分别保持 Host 事实源和客户端连续性责任；
- AgentRuntimeSession 是产品 Service Definition，不是第二套运行时；
- 原生壳通过 Xiaoshe Product Bundle 与 Client 插件组合交付；
- 团队纪律隐式吸收，不做角色商店；
- 自动编排是默认能力策略；
- 权限是独立用户决策；
- 插件先发现与审计，再安装；
- 首批重点是连续性、中文搜索、上下文治理、真心跳、完成凭证和插件安全；
- 用户确认前不合并实施分支。

### 非目标

- 不复刻 gstack 的斜杠菜单和角色包装；
- 不复刻 Multica 式完整团队管理系统；
- 不把 DSH 重新写一遍；
- 不复制 DSH Session Log、Client Runtime、插件 Loader 或 Profile 包管理；
- 不一次性迁移所有第三方插件；
- 不在没有后端能力时制作设置开关；
- 不以视觉完成度代替运行闭环；
- 不在本设计阶段改动现有产品代码。
