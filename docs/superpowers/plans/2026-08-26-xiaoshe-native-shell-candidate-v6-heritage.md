# 小蛇原生产品壳候选 V6 实施计划

> **执行约束：** 使用 `superpowers:executing-plans` 按任务执行；每个行为先写失败测试再实现。当前分支含用户未提交成果，禁止 reset/clean/stash/覆盖，禁止未经授权 commit/merge/release。

**目标：** 新增一个视觉忠于旧版、功能连接 Phase 4–8 公开服务、覆盖宽屏到手机的独立 V6 候选，并形成可跨设备复验的完整交接包。

**架构：** V6 复制 V5 已验证的公共 Client 服务消费逻辑，但拥有独立包、模块 id、品牌端点、CSS、Profile 覆盖 Bundle 和 verifier。DOM 使用旧版 class/尺寸语言，DSH Session Log 与各 Provider 继续是事实真源；V6 只是 Consumer。

**技术栈：** TypeScript、React Client plugin、Cordis/DSH Profile、Vitest、Node 构建脚本、真实 Chromium 浏览器验收、PowerShell 交接工具。

---

## Task 1：建立独立 V6 包边界

**新增：**
- `packages/native-shell-candidate-v6/package.json`
- `packages/native-shell-candidate-v6/tsconfig.json`
- `packages/native-shell-candidate-v6/tsconfig.build.json`
- `packages/native-shell-candidate-v6/vitest.config.ts`
- `packages/native-shell-candidate-v6/scripts/build-client.mjs`
- `packages/native-shell-candidate-v6/src/index.ts`
- `packages/native-shell-candidate-v6/assets/snake.svg`
- `packages/native-shell-candidate-v6-bundle/package.json`
- `packages/native-shell-candidate-v6-bundle/tsconfig.json`
- `packages/native-shell-candidate-v6-bundle/vitest.config.ts`
- `packages/native-shell-candidate-v6-bundle/src/index.ts`
- `packages/native-shell-candidate-v6-bundle/cordis.patch.yml`

**测试：**
- `packages/native-shell-candidate-v6/tests/host-brand.test.ts`
- `packages/native-shell-candidate-v6-bundle/tests/manifest.test.ts`

1. 写失败测试：V6 使用独立模块 id/brand 端点，Bundle 只停用正式 seat、只依赖 V6，不提及 V5 或私有 DSH 路径。
2. 运行两个测试并确认因文件/实现缺失而 RED。
3. 新增最小包骨架与独立品牌路由，复制正式 snake.svg 字节。
4. 更新 workspace lockfile，不改正式 Product Bundle。
5. 重跑测试、typecheck、build 至 GREEN。

## Task 2：冻结旧版视觉合同并构建 Heritage Shell

**新增：**
- `packages/native-shell-candidate-v6/src/client/index.ts`
- `packages/native-shell-candidate-v6/src/client/heritage.css`
- `packages/native-shell-candidate-v6/tests/client-artifact.test.ts`
- `packages/native-shell-candidate-v6/tests/heritage-contract.test.ts`
- `packages/native-shell-candidate-v6/tests/fixture.ts`

1. 写失败测试，验证构建后的真实 Client 产物具有：亮色默认、`ink-jade`、旧字体栈、232/292/48、26px 状态栏、720px/20px 输入器、36px 圆形发送、1080/760/520 断点以及 reduced-motion。
2. 写失败的 React 树测试，验证旧版结构：`.app > .main + .statusbar`、`.side/.chat/.insp`、旧式品牌、新会话/项目/搜索、三页签、composer 和 modal root。
3. 确认测试因 V6 Client 缺失/合同不满足而 RED。
4. 复制 V5 的公开服务接口与安全逻辑到 V6，但重建为旧版 DOM；把旧版 token/布局规则冻结进 `heritage.css`。
5. 构建脚本把 CSS 安全嵌入 Client artifact，不能依赖旧版服务器或 V5 包。
6. 重跑测试与 typecheck/build 至 GREEN。

## Task 3：接回会话、时间线、输入、审批与完成凭证

**修改：**
- `packages/native-shell-candidate-v6/src/client/index.ts`
- `packages/native-shell-candidate-v6/tests/client-lifecycle.test.ts`
- `packages/native-shell-candidate-v6/tests/runtime-consumer.test.ts`

1. 先写失败测试，覆盖创建松散会话、打开会话、搜索取消、运行时 queue/steer、审批回答、完成凭证和卸载释放 root seat。
2. 确认 RED 的原因是 V6 尚未连接或行为不完整。
3. 实现最小公开服务接线；所有错误进入旧式可恢复错误态，不吞掉错误、不读取私有服务。
4. 状态栏和 header 从同一快照投影状态，不建立第二日志。
5. 重跑 V6 测试至 GREEN。

## Task 4：接回记忆、心跳、能力中心与插件治理

**修改：**
- `packages/native-shell-candidate-v6/src/client/index.ts`
- `packages/native-shell-candidate-v6/src/client/heritage.css`
- `packages/native-shell-candidate-v6/tests/runtime-consumer.test.ts`

1. 写失败测试，覆盖 Memory 全局/项目刷新、Heartbeat schema v2、Host 插件清单、插件事务摘要、输入校验、审计→准备→一次性确认→结果。
2. 写失败树测试：插件治理必须使用旧式 modal/confirm box，确认 token 不出现在渲染树。
3. 确认 RED 后实现三个右栏页签；系统页只放轻量能力摘要和入口，详细插件流程进入 modal。
4. 明示 Host 插件无 OS 沙箱、目标仅允许 `xiaoshe-managed-*` 非活动 Profile。
5. 重跑 V6 测试至 GREEN。

## Task 5：实现折叠、overlay 与多尺寸自适应

**修改：**
- `packages/native-shell-candidate-v6/src/client/index.ts`
- `packages/native-shell-candidate-v6/src/client/heritage.css`
- `packages/native-shell-candidate-v6/tests/heritage-contract.test.ts`

1. 写失败测试验证左右折叠状态、移动端 overlay 状态、`aria-expanded`、遮罩关闭和 Escape 关闭。
2. 确认 RED 后实现旧式折叠；`matchMedia` 只决定呈现，不复制业务状态。
3. 保证关闭的 overlay 不截获指针，窄屏没有横向滚动，输入器与主要操作始终可达。
4. 重跑 V6 测试、typecheck、build 至 GREEN。

## Task 6：新增 V6 隔离 Profile 验证器

**新增：**
- `scripts/verify-native-shell-candidate-v6-profile.mjs`
- `tests/native-shell-candidate-v6-profile.test.ts`

**修改：**
- `tests/pnpm-entry-resolution.test.ts`

1. 写失败测试要求 V6 verifier 可通过 Node 入口解析并返回结构化 PASS。
2. 从现有 verifier 提取/复制最小 V6 版本，所有包名、路径、Profile、临时目录和探针均独立。
3. 离线打包并安装 Product + V6 overlay；验证原壳停用、服务组合保持、baseline sentinel 不变、V6 Client/brand/heartbeat HTTP 200。
4. 停服并校验进程正常退出；重跑测试至 GREEN。

## Task 7：真实浏览器视觉与交互验收

**新增：**
- `docs/evidence/native-shell-ui-candidate-v6/acceptance.md`
- `docs/evidence/native-shell-ui-candidate-v6/browser-acceptance.json`
- `docs/evidence/native-shell-ui-candidate-v6/*.png`

1. 用新的绝对临时 DSH_HOME 启动 V6 `--serve`，不复用 V5 或旧版 token/Profile。
2. 在真实浏览器挂载后检查唯一 V6 root、三栏 DOM、标题/favicon、无 console error。
3. 在 2269×1214、1920×1080、1440×900、1024×768、760×900、390×844 依次截图并记录 computed style：栏宽、状态栏、字体、输入器、overflow。
4. 实际点击主题、三页签、折叠/overlay、插件管理打开/取消；不得执行真实插件变更。
5. 保存结构化证据和截图；发现视觉/交互缺陷时回到对应 Task 用 TDD 修复后全量复验。

## Task 8：全量门禁与跨设备交接

**修改：**
- `交接工具/当前状态.md`
- `交接工具/从这里开始.md`
- 交接清单相关生成物

1. 运行 V6/V6 Bundle test、typecheck、build。
2. 运行根 `pnpm run check`、所有 workspace 包递归 test/typecheck/build、Python 门禁。
3. 对顶层、`runtime/DSH`、`runtime/xiaoshe-legacy` 运行 `git diff --check`，复核无旧版/V5/DSH 意外改动。
4. 记录 HEAD、三个 dirty 状态、精确命令、测试计数、浏览器证据、未完成平台门和关键 SHA-256。
5. 更新 handoff manifest 并先 verify。
6. 生成新的 Windows 完整交接包、SHA-256 和大小；解包到新的临时目录并运行交接验证。
7. 交接包生成后不再修改工作区；最终报告只声明已验证事实，macOS/Linux/DPI/多显示器保持 `release-held`。

---

## 2026-08-26 执行结果

Task 1–8 在当前 Windows 设备可完成的部分均已执行。V6/V6 Bundle、公开服务消费、旧版 Heritage 视觉、自适应、真实 Profile、真实浏览器和交接证据已经形成；验收中发现的 Heartbeat 启动竞态、Profile 基线错位和移动空白遮罩均以先失败后通过的回归测试修复。

- 根质量门：109/109 已执行测试、Python 15/15、typecheck/build 通过。
- 16 个 `packages/` 工作区包：163/163 测试及全部已声明 typecheck/build 通过。
- 浏览器：2269、1920、1440、1024、760、390、320 七档，无横向溢出，最终导航 0 error / 0 warning。
- 三工作树 `git diff --check`：通过；未 reset/clean/stash，未改写旧 UI、V5 或 DSH 既有现场。
- 证据：`docs/evidence/native-shell-ui-candidate-v6/acceptance.md` 与 `browser-acceptance.json`。

macOS/Linux V6 浏览器、125%/150% DPI、其他多显示器拓扑、用户视觉批准及 commit/merge/release 仍为 `release-held`，不属于本机完成声明。
