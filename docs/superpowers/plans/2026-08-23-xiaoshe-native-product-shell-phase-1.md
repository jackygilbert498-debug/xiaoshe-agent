# 小蛇原生产品壳 Phase 1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` and `superpowers:test-driven-development` task-by-task.

**Goal:** 建立最小、实现无关的 `AgentRuntimeSession` 产品契约，并用 DSH 已公开的 Client Runtime `sessions` Service 提供真实实现；不复制 DSH 的 Session Log、重连、断帧修复、Workspace、搜索或审批能力。

**Architecture:** `runtime-contract` 只定义产品值、命令结果、投影和兼容解析，不依赖 DSH。`runtime-dsh-provider` 是 browser Client 插件，通过结构化最小 Port 消费 `ctx.sessions`：创建调用 `sessions.create`，发送/停止通过 `sessions.binding(id).session.prompt/cancel`，分叉调用 `sessions.fork`，状态订阅只投影 `sessions.list`。`native-shell` 只消费 `agentRuntimeSession` Service。

**Reality correction:** DSH 具体 `SessionRuntime` 虽有 `create()`，但公开给功能插件的 `ISessions` 刻意不包含它，不能依赖具体类。公开创建路径是 `ctx.workspaces.connectWorkspace(workspaceId)`；因此第一版只在提供 `workspaceId` 时创建，无 Workspace 的 loose create 明确返回 `unsupported`。Session 命令位于 `sessions.binding(id).session`。Provider 只声明结构化最小 Port，不深导入 DSH `src/*` 类型。第一版文本发送映射为 DSH `PromptContentPart[]`；未知扩展字段由产品解析器保留。

**Spec:** `docs/superpowers/plans/2026-08-23-xiaoshe-native-product-shell.md` §6

**Status:** `PASS`（2026-08-24）。契约、测试 Provider、DSH Provider、Product 组合、真实 Profile 和浏览器生命周期门禁均通过。

## Task 1: 固定契约边界和兼容解析

**Files:**
- Create: `packages/runtime-contract/package.json`
- Create: `packages/runtime-contract/tsconfig.json`
- Create: `packages/runtime-contract/src/version.ts`
- Create: `packages/runtime-contract/src/state.ts`
- Create: `packages/runtime-contract/src/commands.ts`
- Create: `packages/runtime-contract/src/service.ts`
- Create: `packages/runtime-contract/src/index.ts`
- Create: `packages/runtime-contract/tests/contract.test.ts`
- Create: `packages/runtime-contract/tests/compatibility.test.ts`

- [ ] 先写失败测试，断言四个且仅四个命令、状态枚举、错误域、`schemaVersion`、`sessionId`、可选 `sourceSeq`。
- [ ] 写向前兼容测试：未知字段必须保留；未知状态映射为 `unknown` 并保留原值；非法版本/缺少身份字段明确失败。
- [ ] 实现纯 TypeScript 契约；不得出现 DSH import、React、搜索、Workspace 操作、审批、压缩、凭证或心跳。
- [ ] `pnpm.cmd --filter @xiaoshe/runtime-contract typecheck/test/build` 全绿。

## Task 2: 用同一合约测试内存 Provider

**Files:**
- Create: `packages/runtime-contract/src/testing.ts`
- Create: `packages/runtime-contract/tests/provider-contract.ts`
- Create: `packages/runtime-contract/tests/memory-provider.test.ts`

- [ ] 合约套件覆盖 create/send/stop/fork、订阅释放、unsupported 和 needs_verification。
- [ ] 内存 Provider 只供测试 export；生产主入口不得自动创建或回退到它。
- [ ] 对每个命令先观察 RED，再实现到 GREEN。

## Task 3: 建立 DSH Provider browser artifact

**Files:**
- Create: `packages/runtime-dsh-provider/package.json`
- Create: `packages/runtime-dsh-provider/tsconfig.json`
- Create: `packages/runtime-dsh-provider/scripts/build-client.mjs`
- Create: `packages/runtime-dsh-provider/src/index.ts`
- Create: `packages/runtime-dsh-provider/src/client/ports.ts`
- Create: `packages/runtime-dsh-provider/src/client/mapping.ts`
- Create: `packages/runtime-dsh-provider/src/client/provider.ts`
- Create: `packages/runtime-dsh-provider/src/client/index.ts`
- Create: `packages/runtime-dsh-provider/tests/provider.client.test.ts`
- Create: `packages/runtime-dsh-provider/tests/artifact.test.ts`

- [ ] 用最小 sessions fake 写失败测试：命令映射、RpcResult 错误分类、列表投影、binding 缺失、unsubscribe。
- [ ] Provider 注入公开 `sessions` 与 `workspaces`，通过 `ctx.provide('agentRuntimeSession', service)` 发布；不依赖 DSH 私有源码类型或具体类附加方法。
- [ ] 构建单一 ModuleLoader row；不得包含 `runtime/DSH` 路径、DOM 查询、React 或第二套 transport/log/cursor。
- [ ] 独立 typecheck/test/build/pack 全绿。

## Task 4: Product Bundle 与 Consumer 纵向组合

**Files:**
- Modify: `packages/product-bundle/package.json`
- Modify: `packages/product-bundle/cordis.patch.yml`
- Modify: `packages/native-shell/src/client/index.ts`
- Modify: `packages/native-shell/tests/client-lifecycle.test.ts`
- Create: `packages/native-shell/tests/runtime-consumer.test.ts`

- [ ] Product patch 先插入 DSH Provider，再插入 native shell；两者仍是并列 Client rows，不嵌套 Bundle。
- [ ] Shell 通过 `ctx.inject(['slots', 'agentRuntimeSession'])` 展示真实当前状态；没有 Provider 时不伪造会话状态。
- [ ] Consumer 卸载只撤销 UI seat；Provider 卸载撤销 Service 和 list subscription，DSH `sessions` 仍存在。

## Task 5: 真实 Client composition 与门禁

**Files:**
- Create: `tests/runtime-session-profile.test.ts`
- Create: `scripts/verify-runtime-session-profile.mjs`
- Create: `docs/evidence/native-shell-phase-1/runtime-session.md`

- [ ] 在隔离 Profile 安装三个树外包，dump 验证 Provider 在 Consumer 前。
- [ ] 真实启动验证 Provider/Consumer artifact 均为 200，boot roster 含两行，Shell 状态 seat 可见。
- [ ] 移除 Product Bundle 后重启，两行均消失，DSH generic Client Runtime 与 session sentinel 保留。
- [ ] 最终运行所有根/包测试、Python、build、`git diff --check`，并重新冻结三棵工作树。

## Stop Conditions

- 若 DSH 公共 `sessions` face 无法完成某个命令，返回 `unsupported`，不得调用私有 API 或直接发 wire RPC。
- 若浏览器包无法仅凭公开动态 Client 协议构建，Phase 1 标为 `BLOCKED`，不得建立第二套 Loader。
- 若状态需要读取 Session Log 才能判断，只增加/消费 DSH Projection；不得在 XS 保存平行日志。
