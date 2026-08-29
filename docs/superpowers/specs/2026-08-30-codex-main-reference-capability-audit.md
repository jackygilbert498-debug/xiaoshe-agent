# codex-main 外部能力参考审计（三轮）

**日期：** 2026-08-30
**参考源：** `C:\Users\example\Desktop\壳对比\codex-main`（只读）
**实施目标：** `C:\Users\example\Desktop\XS`

## 1. 审计边界与快照

参考目录不是 Git checkout，因此不能用提交号定位。本次冻结了入口文件、许可证和规模：

- 有意义文件 6,599 个，总计 67,616,856 字节；
- `codex-rs` 含 107 个一级目录、144 个 Rust package；
- 许可证为 Apache-2.0，`NOTICE` 还声明 Ratatui 衍生部分；
- 只学习机制，不复制参考实现、图标、文案或源文件，因此 XS 不产生新的 Apache/NOTICE 衍生内容。

| 文件 | SHA-256 |
|---|---|
| `README.md` | `ba4e1f69ff48386e72a9c5e1edaf76aad64a475c2d51af79ccba6d1128261ba7` |
| `LICENSE` | `d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc` |
| `NOTICE` | `9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915` |
| `package.json` | `0d0a78ff2f703abad442de6e99e127076ad40f85912692a82ec21d968944b368` |
| `pnpm-workspace.yaml` | `adbc41c7c9a71b7bdf4b370bbd75c573e0da2d632ab98bf7d9020cd2df852069` |
| `codex-rs/Cargo.toml` | `2363b6e0943fb99d7f48823cc5e9b49ed7c7cb88e80d73825f0adc922a6afec3` |

XS、DSH、legacy 三棵工作树在审计前分别冻结；未 reset、clean、stash 或覆盖既有未提交内容。参考目录全程未写入。

## 2. 第一轮：架构与能力面

第一轮从 `codex-rs` 一级包、workspace manifest、协议入口与扩展目录出发，确认了这些值得学习的机制：

1. **插件先解析、后激活。** `plugin/src/{manifest,provider,load_outcome}.rs` 将人类信息、包内资源路径与激活结果分开，资源必须留在包的授权根内。
2. **Hook 是有生命周期的拦截插件。** `hooks/src` 定义稳定事件键、继续/中止、超时、关闭与在途任务收敛，不把任意脚本伪装成普通 UI 设置。
3. **Agent 关系是可持久查询的图。** `agent-graph-store` 保存父子边与开放/关闭状态；`agent-roles` 分离角色说明、配置层和昵称候选。
4. **上下文带来源。** `context-fragments` 将内容、角色、种类和标记一起传递，避免插件注入被误认成用户输入。
5. **历史检索建立在权威日志上。** `thread-store` 与 `rollout` 提供搜索、片段、分页、分支、归档、压缩 JSONL 与修复，而不是让 UI 保存第二本历史。
6. **工作树所有权显式。** `worktree` 只接受受管布局和真实 linked worktree，绑定前验证根、git-dir 与 common-dir。
7. **诊断不携带内容。** `diagnostics` 暴露 PID、内存和计数器，不把会话文本或密钥混入运行诊断。

## 3. 第二轮：调用链、权限、持久化与测试

第二轮沿源码与测试核对机制是否真的进入运行链：

- Hook 从插件加载进入会话配置，再经过预览、注册、审批、压缩和会话事件；测试覆盖环境、占位符、权限、超时、继续/中止和关闭。
- Agent role 从发现/解析进入 spawn schema、子 Agent 配置覆盖、持久化角色和子 Agent 生命周期 Hook。
- Thread search 从 app-server 请求进入 `ThreadStore`，再落到本地索引、rollout 搜索与片段提取；归档和压缩记录也留在同一读取边界。
- 工作树绑定在写 metadata 前验证受管目录、linked worktree 和仓库根，避免普通目录被误标。

### 3.1 对照后确认的真实缺口

DSH 已提供 `ctx.sessionQuery`、SQLite FTS5 Provider 和模型工具插件 `@deepseek-ai/dsh-tool-session-query`。插件注册五个只读工具：`session_search`、`session_event_search`、`session_trace`、`session_event_trace`、`session_event_read`。

源码与测试已证明：

- 调用者只来自 `ToolExecution.exec.agent`；跨会话读取要求 `cwd` 完全相同，无 `cwd` 时只能读自己；
- 搜索排除调用会话，当前会话事件搜索在本次工具调用前截断；
- 父会话过滤和精确读取都先授权，未授权关系不泄漏隐藏 session id；
- Provider 游标不暴露给模型，重复游标被拒绝；
- 同一 `AbortSignal` 贯穿授权、搜索和读取，取消原因保持不变；
- SQLite 集成测试覆盖 live/persisted 同工作区历史；大结果由现有 `spill-policy` 接管。

但 `dsh-base` 与 `dsh-web-app` 都把 `session-query-sqlite` 配置为 `path: ':memory:'`、`openAt: never`，标准 Web/Product Profile 也没有挂载模型工具插件。因此底层存在不等于小蛇已交付。

## 4. 第三轮：反向能力矩阵与查漏

| 能力类别 | XS/DSH 现实 | 决策 |
|---|---|---|
| 插件解析/资源边界 | Cordis Loader + Bundle/Profile + 插件治理已存在 | 不复制 Loader |
| 插件人类信息 | Product 清单已有稳定中文分组与健康信息 | 避免第二套目录 |
| 生命周期 Hook | DSH 有 native interception 与 Codex bridge；bridge 仅覆盖 5 点且会执行用户命令 | 不默认启用；以后逐配置确认 |
| 会话日志/恢复 | DSH Session Log、JSONL persistence、projection 已是唯一权威 | 已覆盖 |
| 会话全文检索 | Provider 与工具包齐全，但 Product 未挂载、FTS 关闭 | **本次实施** |
| Context fragments | prompt section、source-attributed messages、agent instructions 已有 | 不再造上下文总线 |
| Agent roles | agent-presets + `ui-agent-preset` 已启用 | 不重复 |
| Agent graph | subagent、projection、lineage/query 已有 | 通过现有查询读取 |
| Worktree 管理 | DSH agent-team 明确共享 checkout，无自动 worktree/merge | 有价值但高风险，留待独立跨平台设计 |
| Exec policy | DSH 已有 sandbox-policy、permission presets、approval、Windows ACL | 不混用两套政策语言 |
| Connectors/MCP | DSH MCP/skills/web 已有；外部连接仍需逐项授权 | 不自动安装或授权 |
| 模型 Provider | DeepSeek、pi-ai、settings/credentials 已有 | 已覆盖 |
| 诊断/遥测 | DSH 遥测默认关闭；XS Heartbeat/诊断页已有事实 | 不默认开启遥测 |
| Client/协议/SDK | DSH Host/Client Runtime/API gateway 是公共面 | Shell 继续只消费公开接口 |
| 外部 Agent 迁移 | XS 已有迁移/离线交接，语义不同且需数据授权 | 不混入本次能力 |

第三轮再次计算六个参考锚点哈希，结果与第一轮相同，确认扫描期间参考源未被改写。

## 5. 选定实施

由 `@xiaoshe/product-bundle`：

1. 将现有 `session-query-sqlite` 覆盖为位于 `DSH_HOME` 的专用可重建索引，并以 `first-search` 惰性打开；
2. 以独立 Cordis row 挂载 `@deepseek-ai/dsh-tool-session-query`，将结果上限设为 20，搜索超时设为 30 秒。

这符合“一切皆插件”：Session Log 和 Query Provider 仍由 DSH 拥有，模型工具是独立 Consumer 插件，Product Bundle 只负责组合。移除 Product Bundle 后工具 row 消失，FTS 恢复 Web 默认关闭，权威会话和 JSONL 不删除。

明确不实施：复制 codex-main 代码或视觉；第二套 Session Store/Event Journal/索引权威/Loader；默认运行 hooks；自动 worktree/merge；自动遥测、连接器或第三方插件；把 macOS 写成已验证。

## 6. 验收口径

1. Product Bundle 测试先红后绿，固定 row、配置、依赖和卸载回退；
2. DSH 工具包的权限/取消/游标/SQLite 测试通过；
3. 隔离 `DSH_HOME` 完成 build、pack、install、dump、启动、工具目录探针、remove、restart；
4. 安装时五个工具真实出现在 `ctx.tools`，移除后不再出现；
5. Product Profile 启动不打开 SQLite，首次搜索才惰性打开；
6. 可重定位离线工件包含插件及许可证，换路径后仍能安装；
7. 全仓与交接包验证有证据；macOS 实机保持 `PENDING`。
