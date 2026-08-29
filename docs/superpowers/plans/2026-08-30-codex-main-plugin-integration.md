# codex-main 参考能力插件集成实施计划

> 用户已预先授权自主实施；执行仍遵守测试先行、现有未提交内容保护和真实证据门槛。

**目标：** 不复制 codex-main 实现、不建立第二套历史，通过 Product Bundle 交付工作区授权的会话连续性工具，并完成 Windows、离线工件与交接验证。

**架构：** DSH Session Log 保持唯一事实源；`dsh-session-query-sqlite` 是可重建 Provider；`dsh-tool-session-query` 是独立授权 Consumer 插件；`@xiaoshe/product-bundle` 只组合二者。

## Task 1：冻结与三轮审计

- [x] 冻结 XS、DSH、legacy 三棵工作树；
- [x] 冻结 codex-main 入口哈希、规模和许可证；
- [x] 第一轮扫描架构与能力；
- [x] 第二轮跟踪调用链、持久化、权限与测试；
- [x] 第三轮按产品能力矩阵反向查漏、排重并复核哈希；
- [x] 写出审计与设计。

## Task 2：先写失败测试

**状态：已完成。** Product Bundle 和插件清单呈现均先观察到预期红灯，再转绿。

修改或新增：

- `packages/product-bundle/tests/manifest.test.ts`
- `packages/product-bundle/tests/session-continuity.test.ts`
- 可重定位工件测试。

红灯断言：

1. manifest 以可选 peer 声明 `@deepseek-ai/dsh-tool-session-query`；
2. patch 含 `xiaoshe-session-continuity` row；
3. Provider 使用 `dshHomePath('session-query.sqlite')` + `first-search`；
4. 结果上限为 20，超时 30,000 ms；
5. 离线清单包含插件，未知 workspace 依赖仍报错。

运行 `pnpm.cmd --filter @xiaoshe/product-bundle test`，预期先因缺少新能力失败。

## Task 3：实现 Product Bundle 组合

**状态：已完成。**

修改：

- `packages/product-bundle/package.json`
- `packages/product-bundle/cordis.patch.yml`

步骤：

1. 添加工具插件可选 peer 契约，由 Profile/离线安装器显式安装独立工件；
2. 覆盖 query Provider 为专用持久派生库与惰性打开；
3. 插入 `xiaoshe-session-continuity` row；
4. 不修改 Session、persistence、Client Runtime 或 Shell；
5. Product Bundle 测试转绿。

同时在 Native Shell 的插件清单中把两个内部标识折叠为“会话连续性”，避免技术包名进入用户界面。

## Task 4：补齐可重定位工件

**状态：已完成。**

修改：

- `scripts/lib/relocatable-product-artifacts.mjs`
- `scripts/build-relocatable-product-artifacts.mjs`
- 相关测试/验证脚本。

步骤：

1. 将 DSH 工具插件加入独立 artifact row；
2. 锁定并重写其 workspace 依赖版本；
3. staging 补入 DSH MIT LICENSE；
4. 保留逐 tarball SHA-256 和路径逃逸检查；
5. 证明重定位后可离线安装。

## Task 5：真实 Profile 工具目录探针

**状态：已完成。**

新增/修改：

- `scripts/inspect-session-continuity-plugin.mjs`
- `scripts/verify-native-shell-profile.mjs`

步骤：

1. Inspector 注入 `tools`，只读取 schema 名称；
2. 安装态等待五个 session 工具全部出现；
3. dump 检查 row、专用路径、惰性模式和边界配置；
4. 移除 Product Bundle 后确认 row 消失，Provider 恢复 `:memory:` + `never`；
5. 继续证明现有 Product HTTP、Heartbeat、Memory、sentinel 和卸载重启不回归。

## Task 6：分层验证

**状态：已完成。**

```powershell
pnpm.cmd --filter @xiaoshe/product-bundle test
pnpm.cmd --dir runtime/DSH --filter @deepseek-ai/dsh-tool-session-query test
pnpm.cmd --dir runtime/DSH --filter @deepseek-ai/dsh-session-query-sqlite test
node scripts/verify-native-shell-profile.mjs --dsh-home <临时绝对路径>
node scripts/verify-relocatable-product-artifacts.mjs --output <证据 JSON>
pnpm.cmd test
```

任何失败都先定位根因，不跳过。若全仓存在无关基线失败，记录命令、错误和影响范围，不能把局部通过写成全仓通过。

## Task 7：证据与交接

**状态：已完成。** 代码与迁移证据已写入，最终外部交接包由 Windows 打包器执行“生成清单 → 打包 → 解包 → Git/哈希复验”。

- 写入命令、退出码、工件哈希、安装/移除状态与未验证项；
- 更新 `交接工具/当前状态.md` 与 `从这里开始.md`；
- 重新生成完整交接包与 SHA-256 sidecar；
- 外部 `C:\Users\example\Desktop\XS交接` 只保留最新一对文件；
- 工作目录不保留交接压缩包；旧外部包移入回收站。

## 完成标准

- 三轮审计有源码与测试证据；
- 新能力以独立插件 row 交付，卸载后完全撤下；
- 无参考代码复制，无第二套 Session Log/索引权威；
- 单测、DSH 工具/Provider、真实 Profile、重定位与全仓验证均有结果；
- Windows 如实标记；macOS 实机明确为 `PENDING`；
- 交接包可恢复，但不被误写成发布批准或 macOS 验收。
