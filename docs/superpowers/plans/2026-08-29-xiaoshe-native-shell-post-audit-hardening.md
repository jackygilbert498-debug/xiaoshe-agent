# 小蛇原生产品壳三轮复核后加固计划

> **Execution mode:** 在现有 `codex/xiaoshe-native-shell` 脏工作树中逐项执行；不创建、清理或重置工作树。每项先写失败测试，再做最小实现，最后重新生成产物并验收。

**目标：** 修复三轮全面复核后仍可复现的内容边界、草稿隔离、长历史、无障碍恢复、插件服务边界和细节一致性问题，并留下可由另一台 macOS 设备继续实机验收的真实交接状态。

**架构：** DSH Session Log 与各 Provider 继续持有事实；Native Shell 只消费公开 Client 服务并保存会话级瞬时界面状态。新增能力必须沿 Service Definition / Provider / Consumer 边界落地，禁止把健康、诊断、记忆或插件事实硬编码回壳。

**约束：** 保留顶层、`runtime/DSH`、`runtime/xiaoshe-legacy` 全部现存改动；只改本计划列出的文件；Windows 做完整验证，macOS 实机项明确保持 `PENDING`。

## Task 1 — 回复内容边界与安全 Markdown

**Files**
- Modify: `packages/runtime-dsh-provider/src/client/index.ts`
- Modify: `packages/runtime-dsh-provider/tests/provider.client.test.ts`
- Modify: `packages/native-shell-legacy-adapted/src/client/index.ts`
- Modify: `packages/native-shell-legacy-adapted/package.json`
- Modify: `packages/native-shell-legacy-adapted/tests/runtime-consumer.test.ts`

- [x] 先写旧版 `blocks` 同时包含 `reasoning` / `text` 时仅正文进入 `text`、推理进入 `reasoning` 的失败测试。
- [x] 修复 `projectTimeline()` 回退投影，不用关键词或正则猜测推理内容。
- [x] 通过 DSH 公共 Markdown primitive 呈现助手正文，保留纯文本用户输入和转义安全边界。
- [x] 运行两个包的聚焦测试、类型检查和 client build。

## Task 2 — 会话隔离且可恢复的文字/图片草稿

**Files**
- Modify: `packages/native-shell-legacy-adapted/src/client/index.ts`
- Modify: `packages/native-shell-legacy-adapted/tests/client-lifecycle.test.ts`
- Modify: `packages/native-shell-legacy-adapted/tests/interaction-contract.test.ts`

- [x] 写切换 A/B 会话、刷新恢复、发送后清空、存储异常降级、图片配额的失败测试。
- [x] 建立按 `sessionId` 分区的 `sessionStorage` 草稿仓库；未建立会话使用独立临时键。
- [x] 图片转为受限 Data URL 后持久化，切换会话时恢复；捕获配额/解析异常且不阻断发送。
- [x] 发送成功只清理当前会话草稿，其他会话不受影响。

## Task 3 — 长历史分页与大目录性能

**Files**
- Modify: `packages/task-timeline/src/index.ts`
- Modify: `packages/task-timeline/tests/timeline.test.ts`
- Modify: `packages/runtime-contract/src/timeline.ts`
- Modify: `packages/runtime-contract/tests/contract.test.ts`
- Modify: `packages/runtime-dsh-provider/src/client/index.ts`
- Modify: `packages/runtime-dsh-provider/tests/provider.client.test.ts`
- Modify: `packages/native-shell-legacy-adapted/src/client/index.ts`
- Modify: `packages/native-shell-legacy-adapted/src/client/adapted.css`
- Modify: `packages/native-shell-legacy-adapted/tests/interaction-contract.test.ts`

- [x] 写超过 500 条仍可追溯、默认窗口、加载更早、切换会话重置窗口和大目录分批显示测试。
- [x] 取消投影层永久丢弃；在 Client 服务增加 `total` / `hasEarlier` / `loadEarlier()` 分页合同。
- [x] 壳顶部提供“加载更早记录”，会话目录提供“显示更多”，离屏消息使用 `content-visibility` 降低布局/绘制成本。
- [x] 保证用户消息导航以当前已加载窗口重建，加载前后焦点和滚动锚点稳定。

## Task 4 — 共享可访问弹层与根界面恢复

**Files**
- Modify: `runtime/DSH/packages/client/ui-primitives/src/Modal.tsx`
- Modify: `runtime/DSH/packages/client/ui-primitives/tests/Modal.test.tsx`
- Modify: `runtime/DSH/packages/client/ui-renderer/src/client/scoped-slots.tsx`
- Modify: `runtime/DSH/packages/client/ui-renderer/tests/scoped-slots.test.tsx`
- Modify: `packages/native-shell-legacy-adapted/src/client/index.ts`
- Modify: `packages/native-shell-legacy-adapted/tests/interaction-contract.test.ts`

- [x] 写首焦点、Tab 循环、Escape、背景 `inert`、关闭后焦点返回和根插槽崩溃可见恢复测试。
- [x] 加固公共 `Modal` primitive；设置与产品壳弹层复用同一行为合同。
- [x] 将死插槽/根插槽空白改为中文恢复面，提供“重试”和“重新加载”，并保留错误上报。
- [x] 为 DSH 变更补充最窄 Agent Note 与包级验证。

## Task 5 — 记忆项目键规范化

**Files**
- Modify: `packages/memory/src/service.ts`
- Modify: `packages/memory/tests/service.test.ts`

- [x] 写 Windows 大小写/斜杠/`.` 与 `..`、UNC、真实路径别名和旧记录兼容测试。
- [x] 保存和查询都通过同一平台感知规范化函数；可解析路径优先 `realpath`，不存在时用词法规范化。
- [x] 旧记录读取时动态归一，不要求破坏性迁移。

## Task 6 — 健康与诊断服务边界

**Files**
- Modify: `packages/heartbeat/src/client/index.ts`
- Modify: `packages/heartbeat/tests/client.test.ts`
- Modify: `packages/heartbeat/package.json`
- Create: `packages/heartbeat/scripts/build-client.mjs`
- Create: `packages/heartbeat/tsconfig.build.json`
- Create: `packages/runtime-contract/src/health.ts`
- Modify: `packages/runtime-contract/src/index.ts`
- Modify: `packages/native-shell-legacy-adapted/src/client/index.ts`
- Modify: `packages/native-shell-legacy-adapted/tests/runtime-consumer.test.ts`

- [x] 写壳不直接 `fetch` 健康/桌面诊断路由、服务订阅与失败归因测试。
- [x] 由能力所属插件提供只读健康/诊断 Client 服务；壳只消费快照和刷新命令。
- [x] “关于/诊断”只展示真实可用字段；不可用时解释提供方缺失，不伪造状态。

## Task 7 — 最后一轮视觉、触控、设置与术语收口

**Files**
- Modify: `packages/native-shell-legacy-adapted/src/client/index.ts`
- Modify: `packages/native-shell-legacy-adapted/src/client/adapted.css`
- Modify: `packages/native-shell-legacy-adapted/tests/responsive-state.test.ts`
- Modify: `packages/native-shell-legacy-adapted/tests/interaction-contract.test.ts`

- [x] 将浅/深主题次级文字提升到至少 WCAG AA；不改小蛇既定玉色、字形和布局母版。
- [x] 键盘/触控关键目标统一到 44px，保留清晰焦点样式与 reduced-motion。
- [x] 设置和插件长列表默认按语义分组折叠，移除 `phase`、内部 id、`Host` 等主路径术语。
- [x] 对 390、760、1024、1280、1440 宽度验证三栏折叠、标题、输入框、右栏和弹层。

## Task 8 — 全量验证与交接

**Files**
- Modify: `docs/evidence/native-shell-legacy-adapted/2026-08-29-ux-repair-acceptance.md`
- Modify: `交接工具/当前状态.md`
- Modify: `交接工具/从这里开始.md`

- [x] 运行所有受影响包的 test/typecheck/build，记录命令和新鲜结果。
- [x] 启动正式 3080 组合，在真实浏览器检查 DOM、键盘、滚动、草稿切换、控制台与 5 个断点。
- [x] 复核三棵工作树状态，确认无无关文件被清理或覆盖。
- [x] 更新交接文档：Windows 已验证项写证据，macOS bridge/多屏/安装迁移保持 `PENDING`。
