# 小蛇会话连续性插件集成设计

**日期：** 2026-08-30
**依据：** `2026-08-30-codex-main-reference-capability-audit.md`
**范围：** 只实现“工作区授权历史检索”，不改变产品壳视觉。

## 1. 目标与约束

让模型按需检索同一工作区的既往会话、定位事件并读取授权关系，同时保持：

- DSH Session Log 是唯一权威历史；
- SQLite 是可删除、可重建的派生索引；
- 工具插件负责模型边界授权，Query Provider 不承担调用者权限；
- Product Bundle 只组合插件，不建立新运行时或 Service Locator；
- 安装、移除与跨设备工件可验证、可重跑。

## 2. 架构与数据流

```text
模型请求
  -> @deepseek-ai/dsh-tool-session-query       Consumer / 授权边界
      -> ctx.sessionQuery                      公共 Service Definition
          -> dsh-session-query-sqlite          Provider / 可重建 FTS
              -> DSH sessions + persistence    唯一权威 Session Log
          -> spill-policy                      既有输出治理
```

`@xiaoshe/product-bundle` 只声明 Cordis row 和 Provider 配置。它不读取 SQLite、不保存游标、不解释 SessionEvent，也不向 Native Shell 增加私有 API。

## 3. Bundle 配置

```yaml
- id: session-query-sqlite
  config:
    path: !!js dshHomePath('session-query.sqlite')
    openAt: first-search

- insert:
    - id: xiaoshe-session-continuity
      name: '@deepseek-ai/dsh-tool-session-query'
      config:
        maxSearchResults: 20
        searchTimeoutMs: 30000
```

配置理由：

- `first-search` 让启动阶段不导入 `node:sqlite`，第一次真实搜索才承担索引成本；
- 专用 `DSH_HOME/session-query.sqlite` 避免误指向 canonical session persistence 数据库；
- 20 条与 Provider 默认页大小一致，限制模型一次收到的历史范围；
- 30 秒沿用工具包默认协作式超时，不引入无边界等待；
- 不覆写 journal、snippet、读取窗口等成熟默认值，减少产品层漂移。

## 4. 包与离线工件边界

`@xiaoshe/product-bundle` 对 `@deepseek-ai/dsh-tool-session-query` 声明可选 peer 依赖；这样 Bundle 的组合契约可检查，同时不会把 DSH 包偷偷嵌入 XS。真实 Profile 和离线安装器都必须显式安装该独立工件。为保证无网络交接：

- 可重定位 Product 工件把该 DSH 插件作为独立 tarball 收入 manifest；
- 工件只把 `workspace:` 重写为锁定版本，不复制实现进 XS 包；
- 插件 tarball 带 DSH 根 MIT `LICENSE`；
- 安装器继续逐个校验 SHA-256，再按接收设备路径生成 Profile override；
- DSH 本体、Provider 和公共 Service 仍由接收设备的锁定 DSH runtime 提供。

这是让现有 Cordis 插件成为可安装、可替换、可卸载的明确组合依赖，不是把 DSH 打包进 Product Bundle。

插件管理界面将技术 row/package 折叠为稳定的产品能力名“会话连续性”，说明为“按工作区查找并回溯既往会话”；不会向用户暴露难以理解的内部包名。

## 5. 权限与隐私

产品不新增权限算法，沿用工具包已测试的边界：

- 当前 agent 是唯一调用者身份来源；
- 仅允许 `cwd` 完全相同的会话；
- 搜索排除调用会话，事件搜索截断到调用前；
- 未授权父子关系用无 id 边界标记；
- 模型不能控制 Provider cursor、offset 或任意结果上限；
- 精确 trace/read 在访问前授权；
- 取消信号不被替换，底层清理完成后才返回取消。

SQLite Provider 是可信内部 Service，没有调用者授权。任何未来 UI Consumer 都必须单独鉴权，禁止把 `ctx.sessionQuery` 直接暴露成无鉴权 HTTP。

## 6. 生命周期与失败语义

| 场景 | 预期行为 |
|---|---|
| Product Bundle 未安装 | 五工具不存在；FTS 为 `openAt: never` |
| 已安装但未搜索 | row ACTIVE；SQLite 模块与文件不打开/创建 |
| 首次搜索 | 并发调用共享 readiness promise，创建派生库并索引 |
| 索引无效 | 首次搜索返回受控错误；Session Log 不受影响 |
| 检查或事务失败 | 不提交部分索引；下一次搜索重试 |
| 取消 | 已开始的持久层工作收敛后返回原取消原因 |
| 结果过大 | 现有 spill-policy 输出预览和 locator |
| Product Bundle 移除 | 工具 effect 释放；配置恢复 `:memory:` + `never`；不删除权威历史 |

## 7. 验证设计

### 7.1 单元与契约

- manifest 以可选 peer 明确声明工具插件组合契约；
- patch 固定专用路径、惰性模式、20 条上限和 30 秒超时；
- 不嵌套 Web Bundle 或 DSH 源码路径；
- 可重定位 manifest 包含工具插件，未知 workspace 依赖继续 fail loud；
- DSH 工具包权限、取消、游标和 SQLite 测试通过。

### 7.2 真实 Profile

隔离 Profile 安装 Web Bundle、Product 子包和 Product Bundle。测试专用 Cordis inspector 只读取 `ctx.tools.schemas()`，确认五个工具全部出现。移除 Product Bundle 后 dump 必须不再包含该 row，并恢复 Web 默认的 FTS 关闭配置。

Inspector 不进入生产 Bundle、不执行模型请求、不读取会话内容。

### 7.3 跨设备

生成可重定位目录，复制到另一绝对路径，从该路径离线安装到新的 `DSH_HOME`，校验全部 tarball SHA-256、Profile rows 和原有 sentinel。Windows 本机通过后，macOS 实机仍由用户在另一台设备验收，状态为 `PENDING`。

## 8. 非目标

- 不新增历史搜索 UI；
- 不启用 hooks、遥测、连接器、自动 worktree 或第三方插件；
- 不改变 Native Shell 字体、布局、颜色或交互；
- 不自动删除派生索引；
- 不声称 macOS 已验证。
