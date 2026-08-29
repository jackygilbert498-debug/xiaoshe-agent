# 小蛇原生产品壳能力与数据所有权

| 能力 | Provider / 所有者 | 小蛇角色 | 权威数据 | Phase 0 义务 |
|---|---|---|---|---|
| Agent loop | DSH Agent 插件 | 选择并组合 Provider，不复制循环 | DSH Agent/Session facts | Product Bundle 不声明第二循环 |
| 会话交互历史 | DSH Session Log | 只消费、投影 | `SessionEvent.seq` 日志 | 删除任何第二日志设计 |
| 浏览器连接与恢复 | DSH Connection + Client Runtime | 消费公开 `ctx.sessions` | DSH Client Runtime 内存状态，可由日志恢复 | 不实现 gap/reconnect 状态机 |
| Workspace | DSH Workspace Host/Client Service | 原生壳 Consumer | DSH Workspace 数据 | 不深导入 store |
| 搜索 | DSH `ctx.sessionQuery` / `ctx.sessions.search` | 中文体验 Consumer；必要时替换 Provider | DSH 搜索 Provider 索引 | Shell 不建第二索引 |
| 设置与凭证 | DSH Settings/Credentials | 注册小蛇 namespace 和 UI Consumer | DSH 设置文档/凭证 Provider | 秘密不进入日志或证据 |
| 审批与动作策略 | DSH Approval + 小蛇 Windows action policy | Windows Host Provider | DSH 审批事实、动作证据 | 独立 row 生命周期 |
| Windows Bridge | `@xiaoshe/dsh-desktop-control` Host Bundle | Provider | Python bridge 进程与动作结果 | Product Profile 可独立组合 |
| 长期记忆 | XS `memory-service` | 独立 Provider/Consumer | XS memory settings/audit | 不吸入 RuntimeSession |
| 产品身份与表达 | Xiaoshe product identity plugin | SystemPrompt Provider | Xiaoshe settings | 移除不停止 Bridge |
| 本地运行路由 | Xiaoshe runtime routes plugin | Host HTTP Provider | 对其他所有者的只读/命令门面 | route disposer 独立 |
| Completion Receipt | Xiaoshe projection plugin（Phase 2） | Projection/Consumer | DSH 会话事实或独立 Host 领域事实 | 不建 journal/snapshot |
| Heartbeat | Xiaoshe Heartbeat Host Service（Phase 5） | 独立 Provider/Consumer | 独立跨会话租约账本 | 只把会话语义事实写入 Session Log |
| 原生 Product UI | `@xiaoshe/native-shell` Client plugin | Slots Consumer/registrant | DSH Client services + 小蛇 Services | 禁止 DOM 查询注入 |
| 旧 DSH 皮肤 | `@xiaoshe/legacy-dsh-skin` | 兼容 Client plugin | 无独立业务数据 | Product Profile 不加载 |
| 产品组合 | `@xiaoshe/product-bundle` | Profile patch 层 | Profile manifest + dump config | 不包含其他 Bundle |

## 根包能力 row 迁移表

| 目标 row | 当前来源 | 配置 | 依赖 | 拥有的 disposer |
|---|---|---|---|---|
| `xiaoshe-desktop-capability` | `src/index.ts` Bridge、工具、动作 gate/pre-execute | `PluginConfig`、`xiaoshe-desktop` | tools、settings | ActionToolController、BridgeClient、watcher |
| `xiaoshe-memory` | `src/memory-service.ts` 与注册逻辑 | `xiaoshe-memory` | tools、settings | 记忆工具注册和 watch |
| `xiaoshe-product-identity` | `src/index.ts` prompt/response style | `xiaoshe-desktop.responseStyle` | settings、systemPrompt | prompt section |
| `xiaoshe-runtime-routes` | `src/runtime-control.ts` | route limits、brand asset | webServer + 明确注入的窄能力 | 全部 HTTP route disposer |
| 兼容聚合 `apply()` | 当前根入口 | 保持旧 Profile 行为 | 上述四 row | 只编排，不新增所有权 |

## 依赖方向

```text
DSH public Host/Client services
  ├── Xiaoshe Windows capability rows
  ├── Xiaoshe product service providers
  └── Xiaoshe native-shell Client consumer

Xiaoshe Profile
  ├── dsh-base (implicit)
  ├── dsh-web-app Bundle
  ├── dsh-desktop-control Bundle (optional, independent)
  └── xiaoshe-product-bundle
```

禁止反向依赖：DSH 不依赖 XS；Product Bundle 不拥有 DSH 或 Windows Bundle；Shell 不读取 DSH 私有实现。
