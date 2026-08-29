# 小蛇原生产品壳 Phase 0 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 证明小蛇能够以树外 Product Bundle 和 Client 插件安装到独立 DSH Profile，同时把 Windows Host 能力、旧兼容皮肤和产品壳拆成可独立组合、可卸载的插件边界。

**Architecture:** DSH Profile 是唯一宿主，`@deepseek-ai/dsh-web-app` 提供通用 Web Host、Connection、Remote、Client Runtime、Renderer 与 Slots。XS 新增的 Product Bundle 只追加小蛇 Product Client row；现有根包保留 Windows Host/Bundle 身份，旧 `client.js` 移到兼容 Client 包，Product Profile 不加载它。

**Tech Stack:** TypeScript、Cordis、DSH Profile/Bundle、DSH dynamic client module contract、Vitest、pnpm、PowerShell。

**Spec:** `docs/superpowers/specs/2026-08-23-xiaoshe-native-product-shell-design.md`

**Status:** `PASS`（2026-08-23）。Tasks 1–6 已实现并通过 Task 7 门禁；可进入 Phase 1。

## Global Constraints

- 不修改 `runtime/DSH` 和 `runtime/xiaoshe-legacy` 的现有工作树内容。
- 不深导入 DSH 源码、私有 store、私有事件对象、数据库结构或未发布构建 preset。
- 不建立第二套 Agent loop、Session Log、Client Runtime、插件 Loader 或 Profile 包管理。
- Bundle add/remove/update 之后必须重启 Profile 才能验收。
- 所有生产行为先写失败测试，并确认失败原因正确。
- 只提交本阶段创建或明确修改的文件，不吸收基线中的其他未提交内容。

---

### Task 1: 固定事实、所有权和停止条件

**Files:**
- Create: `docs/evidence/native-shell-phase-0/baseline.md`
- Create: `docs/architecture/native-shell-capability-ownership.md`
- Create: `docs/decisions/0002-native-product-shell-plugin-boundaries.md`

**Interfaces:**
- Consumes: Revision 3 总计划、DSH 当前公开文档与三个工作树的只读状态。
- Produces: 后续任务必须遵守的数据所有者、包边界、验证命令和停止条件。

- [ ] **Step 1: 冻结三个工作树**

  对每个仓库记录 `git branch --show-current`、`git rev-parse HEAD`、`git status --short` 数量和 `git status --porcelain=v1 -z | git hash-object --stdin`。不得清理状态。

- [ ] **Step 2: 记录根基线测试**

  运行 `pnpm.cmd check`。如果失败，记录首个失败、通过/失败/跳过数量，以及哪些后续命令因短路未运行。

- [ ] **Step 3: 固定能力和数据所有权**

  表格至少覆盖：Agent loop、Session Log、Client Runtime、会话搜索、Workspace、设置、审批、Windows Bridge、记忆、产品身份、Completion Receipt、Heartbeat、Product UI、旧 DSH 皮肤。

- [ ] **Step 4: 固定 ADR**

  ADR 必须明确：Profile 不是 Bundle；Bundle 不包含 Bundle；Product Bundle 和 Windows Bundle 是并列层；Session Log 是唯一交互日志；旧 Client 仅兼容 Profile 显式安装。

- [ ] **Step 5: 文档自检**

  运行：

  ```powershell
  git diff --check -- docs/evidence/native-shell-phase-0/baseline.md docs/architecture/native-shell-capability-ownership.md docs/decisions/0002-native-product-shell-plugin-boundaries.md
  rg -n "TB[D]|TO[D]O|implement[ ]later|以后[ ]补" docs/superpowers/plans/2026-08-23-xiaoshe-native-product-shell-phase-0.md
  ```

  预期：`git diff --check` 退出码 0；占位符扫描无结果。

### Task 2: 建立外部 Client 构建契约测试

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Create: `packages/native-shell/package.json`
- Create: `packages/native-shell/tsconfig.json`
- Create: `packages/native-shell/scripts/build-client.mjs`
- Create: `packages/native-shell/src/index.ts`
- Create: `packages/native-shell/src/client/index.ts`
- Create: `packages/native-shell/tests/client-artifact.test.ts`
- Create: `packages/native-shell/tests/client-lifecycle.test.ts`

**Interfaces:**
- Consumes: DSH 公布的 `dsh.client` manifest、`./client` export、`window.__ModuleLoader__.load({ id, factory })` 产物协议，以及平台预置的 `react` 和 Cordis `slots` Service。
- Produces: `@xiaoshe/native-shell`，Node face 为无状态 Cordis 插件，browser face 导出 `apply(ctx)` 并可独立释放注册。

- [ ] **Step 1: 写产物契约失败测试**

  测试以临时目录运行构建命令，并断言生成的 `lib/client.js`：

  - 只注册 `@xiaoshe/native-shell` 这一 ModuleLoader row；
  - manifest 声明 `dsh.client.platform = "web"` 和 `./client` export；
  - 产物不包含 `runtime/DSH` 路径；
  - package tarball 包含 `lib/client.js`、Node face 和 manifest。

  运行：`pnpm.cmd vitest run packages/native-shell/tests/client-artifact.test.ts`

  预期：因包和构建脚本尚不存在而 FAIL。

- [ ] **Step 2: 写生命周期失败测试**

  用最小真实 Cordis Context 和可观察的 Slots fake 加载 browser face，断言挂载产生一个 `shell.overlay` seat，dispose 后 seat 和订阅为零。

  运行：`pnpm.cmd vitest run packages/native-shell/tests/client-lifecycle.test.ts`

  预期：因 `apply` 尚不存在而 FAIL。

- [ ] **Step 3: 实现最小 Node/browser face**

  `src/index.ts` 只导出空 `apply()`；`src/client/index.ts` 只通过 `ctx.inject(['slots'], ...)` 注册一个带 `data-xiaoshe-shell-probe` 的 React 组件。不得访问 `document.querySelector`、`MutationObserver` 或 DSH 私有模块。

- [ ] **Step 4: 实现独立构建器**

  `build-client.mjs` 使用本包明确声明的构建依赖，将 browser entry 打成 CommonJS factory body，再包进 ModuleLoader row；`react` 保持外部依赖。不得读取 `runtime/DSH` 构建配置。

- [ ] **Step 5: 验证 RED → GREEN**

  依次重跑两个聚焦测试，随后运行：

  ```powershell
  pnpm.cmd --filter @xiaoshe/native-shell typecheck
  pnpm.cmd --filter @xiaoshe/native-shell test
  pnpm.cmd --filter @xiaoshe/native-shell build
  pnpm.cmd --filter @xiaoshe/native-shell pack --pack-destination artifacts
  ```

  预期：全部退出码 0，tarball 可列出且不包含源码树或 DSH 私有文件。

### Task 3: 建立 Product Bundle 与补丁边界测试

**Files:**
- Create: `packages/product-bundle/package.json`
- Create: `packages/product-bundle/cordis.patch.yml`
- Create: `packages/product-bundle/src/index.ts`
- Create: `packages/product-bundle/tsconfig.json`
- Create: `packages/product-bundle/tests/manifest.test.ts`
- Create: `packages/product-bundle/tests/patch-boundary.test.ts`

**Interfaces:**
- Consumes: `@xiaoshe/native-shell` 的 Node/browser 双面包。
- Produces: `@xiaoshe/product-bundle`，其 patch 只插入 `xiaoshe-native-shell` row，不声明或嵌套 Web/Windows Bundle。

- [ ] **Step 1: 写 manifest 与 patch 失败测试**

  断言 tarball 声明 `dsh.bundle.patch`；patch 只插入包自己的 client row；dependencies 只包含 `@xiaoshe/native-shell`；不出现 `@deepseek-ai/dsh-web-app`、`@xiaoshe/dsh-desktop-control` 或 DSH 源码路径。

  运行：`pnpm.cmd vitest run packages/product-bundle/tests`

  预期：包不存在而 FAIL。

- [ ] **Step 2: 实现最小 Bundle**

  Node `apply()` 无副作用；`cordis.patch.yml` 插入：

  ```yaml
  - insert:
      - id: xiaoshe-native-shell
        name: '@xiaoshe/native-shell'
  ```

- [ ] **Step 3: 验证构建与打包**

  运行：

  ```powershell
  pnpm.cmd --filter @xiaoshe/product-bundle test
  pnpm.cmd --filter @xiaoshe/product-bundle build
  pnpm.cmd --filter @xiaoshe/product-bundle pack --pack-destination artifacts
  ```

  预期：退出码 0，tarball 包含 patch、Node face 和 manifest。

### Task 4: 真实 Profile 安装、启动、移除、重启证明

**Files:**
- Create: `scripts/verify-native-shell-profile.mjs`
- Create: `tests/native-shell-profile.test.ts`
- Create: `docs/evidence/native-shell-phase-0/profile-probe.md`

**Interfaces:**
- Consumes: DSH CLI、已打包的 native-shell/product-bundle tarball、隔离的 `DSH_HOME`。
- Produces: 可重跑的 Profile 验证器和不含凭证的运行证据。

- [ ] **Step 1: 写 Profile 验证失败测试**

  测试必须在临时 `DSH_HOME` 中调用验证器，检查 add 后 dump 包含 Web 基础 rows 和 `xiaoshe-native-shell`，remove 后的新 dump 不含小蛇 row，且预先写入的 session sentinel 未变化。

  运行：`pnpm.cmd vitest run tests/native-shell-profile.test.ts`

  预期：验证器不存在而 FAIL。

- [ ] **Step 2: 实现无 shell 拼接的验证器**

  使用 `spawn()` 参数数组调用 `pnpm.cmd --dir runtime/DSH dsh -- ...`；所有路径通过绝对路径参数传递。日志必须脱敏环境变量，不写 API key。

- [ ] **Step 3: 执行真实 add/dump/start/remove/restart**

  启动使用 `--no-open` 和动态空闲端口；通过 `dsh web:` URL 与 `/plugins/@xiaoshe%2Fnative-shell/client.js`（以实际路由为准）验证产物可服务，然后发送 SIGINT 并等待干净退出。remove 后重新启动，插件资源应为 404 或不在 boot roster 中。

- [ ] **Step 4: 保存证据**

  `profile-probe.md` 记录命令、退出码、Profile dump 摘要、HTTP 探针、进程退出、session sentinel hash 和未执行项。

### Task 5: 拆出旧兼容 Client 包

**Files:**
- Modify: `package.json`
- Create: `packages/legacy-dsh-skin/package.json`
- Create: `packages/legacy-dsh-skin/client.js`
- Create: `packages/legacy-dsh-skin/src/index.ts`
- Create: `packages/legacy-dsh-skin/tsconfig.json`
- Create: `packages/legacy-dsh-skin/tests/compatibility.test.ts`
- Create: `tests/host-only-package.test.ts`

**Interfaces:**
- Consumes: 当前根 `client.js` 的完整字节内容和根 Host package。
- Produces: Host-only `@xiaoshe/dsh-desktop-control` 与仅兼容 Profile 安装的 `@xiaoshe/legacy-dsh-skin`。

- [ ] **Step 1: 写失败测试**

  根包测试断言没有 `dsh.client` 和 `./client` export；兼容包测试断言其 `client.js` 与迁移前冻结 hash 一致、manifest 只声明 client face 且不包含 Host Bundle。

- [ ] **Step 2: 运行并确认正确失败**

  运行：`pnpm.cmd vitest run tests/host-only-package.test.ts packages/legacy-dsh-skin/tests/compatibility.test.ts`

  预期：根包仍为双面且兼容包不存在而 FAIL。

- [ ] **Step 3: 做字节保持迁移**

  将当前 `client.js` 的内容移动到兼容包，更新其中 ModuleLoader id 为 `@xiaoshe/legacy-dsh-skin` 所必需的唯一字面量；除此以外不得重写旧 UI。根包移除 client export、files entry 和 `dsh.client`。

- [ ] **Step 4: 验证两个 Profile**

  兼容 Profile 显式安装 Host Bundle + legacy skin 后仍能服务旧 Client；Product Profile 只安装 Host Bundle + Product Bundle，其 roster 不包含 legacy skin。

### Task 6: 把根 `apply()` 拆成窄插件 rows

**Files:**
- Modify: `src/index.ts`
- Create: `src/plugins/desktop-capability.ts`
- Create: `src/plugins/memory.ts`
- Create: `src/plugins/product-identity.ts`
- Create: `src/plugins/runtime-routes.ts`
- Modify: `tests/plugin.test.ts`
- Create: `tests/plugin-rows.test.ts`

**Interfaces:**
- Consumes: 现有 Bridge、ActionToolController、memory-service、runtime routes 和 systemPrompt API。
- Produces: `desktopCapabilityPlugin`、`memoryPlugin`、`productIdentityPlugin`、`runtimeRoutesPlugin`，以及只用于旧 Profile 迁移的兼容聚合 `apply()`。

- [ ] **Step 1: 写 Loader 组合失败测试**

  测试分别挂载四个 row，断言：移除 identity 不停止 Bridge；移除 memory 只移除记忆工具/设置；移除 routes 只撤销 HTTP routes；移除 desktop 才终止 Bridge 和桌面工具。

- [ ] **Step 2: 逐个确认失败原因**

  运行：`pnpm.cmd vitest run tests/plugin-rows.test.ts`。每个测试必须因对应导出或独立生命周期不存在而 FAIL，不接受语法/fixture 错误。

- [x] **Step 3: 通过 Cordis Service 暴露窄运行对象**

  `desktop-capability` 和 `memory` 分别通过 `ctx.provide()` 暴露 `xiaosheDesktop`、`xiaosheMemory`；consumer 通过
  `ctx.get()` 消费。没有跨行共享所有权，因此不引入引用计数 manager；Bridge 的唯一 disposer 仍归 desktop row。
  这比单独的 `shared-runtime.ts` 更符合 Cordis 的现实生命周期，也避免制造第五个隐式总插件。

- [ ] **Step 4: 逐 row 实现 RED → GREEN**

  每完成一个 row 只运行其聚焦测试；全部绿色后让根 `apply()` 按固定顺序调用四个 row，保持旧 Host 行为。

- [ ] **Step 5: 回归验证**

  运行：`pnpm.cmd typecheck`、`pnpm.cmd test`、`pnpm.cmd test:python`、`pnpm.cmd build`。既有 Hero 文案断言若仍失败，作为迁入 legacy package 后的测试归属一起修正，不删除行为覆盖。

### Task 7: Phase 0 最终门禁

**Files:**
- Modify: `docs/evidence/native-shell-phase-0/baseline.md`
- Modify: `docs/evidence/native-shell-phase-0/profile-probe.md`
- Modify: `docs/superpowers/plans/2026-08-23-xiaoshe-native-product-shell.md`

**Interfaces:**
- Consumes: Tasks 1–6 的构建物、测试与真实 Profile 证据。
- Produces: `PASS`、`PARTIAL` 或 `BLOCKED` 的诚实结论，以及是否允许进入 Phase 1。

- [ ] **Step 1: 完整重跑 Phase 0 验证**

  ```powershell
  pnpm.cmd check
  pnpm.cmd --filter @xiaoshe/native-shell test
  pnpm.cmd --filter @xiaoshe/native-shell build
  pnpm.cmd --filter @xiaoshe/product-bundle test
  pnpm.cmd --filter @xiaoshe/product-bundle build
  pnpm.cmd vitest run tests/native-shell-profile.test.ts
  git diff --check
  ```

- [ ] **Step 2: 重新冻结三个工作树**

  与 Task 1 使用同一命令，确认 DSH 和 legacy 的状态 hash 未改变；XS 的新增差异必须能逐项归因。

- [ ] **Step 3: 对照总计划验收门槛**

  若任何树外 Client build/pack/install/start/remove/restart、Host/client 拆分或生命周期条件不成立，结论必须是 `BLOCKED`，停止 Phase 1；不得改用独立运行时。

- [ ] **Step 4: 更新总计划状态**

  仅在全部门槛有新鲜证据时把 Phase 0 标记完成并开始编写 Phase 1 任务级计划。
