# Xiaoshe Native Shell Adaptive Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** 在正式旧版适配壳中完成全页比例、重复呈现、设置层级与多屏自适应收口，同时保持小蛇既有视觉和插件边界。

**Architecture:** 继续由适配壳拥有布局与视觉孔位，由 DSH Client 插件拥有能力、实时状态和设置页。响应式变化只改变信息密度和呈现方式，不复制服务、不新增假功能。

**Tech Stack:** TypeScript、React Client Plugin、CSS、Vitest、Playwright、DSH public Client Runtime APIs。

**Spec:** `docs/superpowers/specs/2026-08-27-xiaoshe-native-shell-adaptive-balance-design.md`

**Global Constraints:** 不改两个 runtime 工作树；不提交、不合并、不发布；保留所有用户未提交内容；只做必要修改。

## Task 1: 固化可观察的自适应合同

**Files:**
- Modify: `scripts/verify-native-shell-legacy-adapted-visual.mjs`
- Modify: `packages/native-shell-legacy-adapted/tests/responsive-state.test.ts`

1. 增加 1180×720 紧凑桌面、2560×1080 超宽屏、390×844 与 375×667 手机合同。
2. 增加设置层级、跨断点可见性、手机主题排版和触控尺寸合同。
3. 先运行新增合同并记录当前失败，确保测试能观察到真实缺陷。

## Task 2: 收敛三栏比例与纵向密度

**Files:**
- Modify: `packages/native-shell-legacy-adapted/src/client/index.ts`
- Modify: `packages/native-shell-legacy-adapted/src/client/adapted.css`

1. 将右栏常驻断点提升至紧凑桌面之上，保持中间工作面最小可用宽度。
2. 放宽超宽屏输入器但保持阅读列上限。
3. 为矮屏收紧标题、舞台、输入器和检查栏垂直间距。
4. 保留桌面手动拖拽栏宽与安全边界。

## Task 3: 清理重复呈现并提升窄屏操作

**Files:**
- Modify: `packages/native-shell-legacy-adapted/src/client/index.ts`
- Modify: `packages/native-shell-legacy-adapted/src/client/adapted.css`

1. 为顶部摘要和状态栏字段增加语义类名。
2. 窄屏隐藏顶部低优先级详情与底部长会话 ID，保留状态和轮次。
3. 增大手机端任务、状态、主题、权限、思考强度与发送按钮的触控面积。

## Task 4: 修复设置窗口层级与移动排版

**Files:**
- Modify: `packages/native-shell-legacy-adapted/src/client/adapted.css`

1. 设置打开时提升其所属左栏堆叠上下文，确保遮罩覆盖右栏。
2. 设置窗口最高约 720px，减少空白且保留复杂页滚动空间。
3. 确保设置打开后跨 760px 断点仍可见。
4. 手机导航使用横向可滚动标签，主题选项保持三列，关闭与导航按钮达到可触控尺寸。

## Task 5: 完整验证与交接

**Files:**
- Modify: `docs/evidence/native-shell-legacy-adapted/2026-08-27-refinement-acceptance.md`
- Modify: `docs/evidence/native-shell-legacy-adapted/acceptance.md`
- Modify: `交接工具/当前状态.md`
- Regenerate: handoff manifest artifacts

1. 运行包测试、类型检查与构建。
2. 运行亮/暗主题和九种屏幕尺寸的真实浏览器验收，检查 DOM、交互与控制台。
3. 复核差异只触及正式适配包、合同、证据与交接文件。
4. 更新截图、验收记录、文件数/字节数/哈希并验证交接清单。
