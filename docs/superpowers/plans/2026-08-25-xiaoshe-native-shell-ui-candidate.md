# 小蛇原生壳独立界面候选版实施计划

> **历史状态（V1）：** 本文件记录的首版视觉已被用户否决，不再是当前候选。当前实现与验收边界见 `2026-08-25-xiaoshe-native-shell-ui-candidate-v2.md` 和 `docs/evidence/native-shell-ui-candidate-v2/`。本文件仅保留架构隔离与历史证据，不得据此恢复“巢册 / 证据脊线 / 脉册”术语或旧版浅色布局。

**状态：** Windows 本机完成；候选未推广，跨平台验收保持 `release-held`
**日期：** 2026-08-25
**前置：** Phase 4、5、6 本机交付与证据已完成
**原则：** 候选版只新增包和 Profile 覆盖层，不修改或替换 `@xiaoshe/native-shell`。

## 目标

在保持 DSH 单一执行内核和既有 Product 服务边界的前提下，制作一个可真实挂载、可交互、可撤回的“小蛇界面候选版”。视觉以旧版小蛇的云白薄荷流光、蛇形空间签名和舞台式会话为主；仅借用“总台优化版”的层级线与状态点、任务看板的紧凑标签和响应式纪律。

候选版必须消费现有 `agentRuntimeSession`、`sessionCatalog`、`taskTimeline`、`contextGovernance`、`memoryLifecycle`、`completionReceipt` 投影、`heartbeat` 和 `pluginGovernance`，不得复制执行内核、绕过公开 Client 服务或伪造未交付能力。

## 设计约束

- 色板：云纸 `#F7FAF8`、巢白 `#EEF4F1`、松墨 `#18312A`、活玉 `#2F8A70`、暖金 `#C3A55B`、警示赭 `#B95C52`。
- 字体：标题/品牌为系统宋体或楷体，正文为系统中文无衬线，事实编号为系统等宽字体；不引入网络字体。
- 桌面骨架：`264px 巢册 | minmax(0, 1fr) 主舞台 | 304px 脉册`。
- 中窄屏：脉册收成 `52px`；小屏巢册收成 `76px`，脉册成为覆盖抽屉。
- 左右折叠控制统一使用 `.xsc-icon-button`，固定 `36px × 36px`、相同图标视盒和边框。
- 标志性元素为“证据脊线”：用户、助手、行动、审批、验证沿同一条轨迹展示；无事实时只显示安静空态，不展示虚假指标。
- 控制中心不做九宫格后台；记忆、凭证、心跳、插件事务归入右侧册页并显示真实状态与诚实限制。
- 支持键盘焦点、语义区域、`prefers-reduced-motion`、深浅主题和至少 760px–2048px 宽度。

## 布局草图

```text
┌────────────巢册────────────┬────────────────主舞台────────────────┬──────────脉册──────────┐
│ 小蛇 / 新会话 / 搜索       │ 项目 · 会话标题             当前状态 │ 记忆 · 完成凭证         │
│ 项目与会话                 │                              ┌─验证结│ 心跳 · 插件事务         │
│                            │  证据脊线  ○ 用户            │       │ 审批（有事才出现）      │
│                            │            ● 小蛇            │       │ 现实边界                │
│ 设置与连接状态             │  任务输入器                  │        │                        │
└────────────────────────────┴──────────────────────────────────────┴────────────────────────┘
```

## 架构边界

1. 新增 `packages/native-shell-candidate/`，模块名、root seat id、品牌路由和构建产物均与原壳不同。
2. 新增 `packages/native-shell-candidate-bundle/`，patch 只禁用 `xiaoshe-native-shell` 并插入 `xiaoshe-native-shell-candidate`。
3. 候选 Bundle 只用于专用候选 Profile；不加入 `packages/product-bundle`，不修改原 Profile。
4. 候选包依赖注入与原壳一致，所有状态来自现有服务；Host 端只提供静态品牌 SVG。
5. 候选认可后再另立推广任务；本计划不授权覆盖、合并或发布。

## 实施任务

### Task 1：先写隔离边界与 UI 契约测试

- [x] 新增候选包 manifest、Client 构建、Host 品牌、root seat 生命周期和可访问性结构测试。
- [x] 断言两个折叠按钮共用 `.xsc-icon-button` 且 CSS 中唯一尺寸为 `36px`。
- [x] 断言候选 Client 不引用 `runtime/DSH`、不使用 DOM 劫持或 `MutationObserver`。
- [x] 新增候选 Bundle 测试，断言只覆盖原 root seat，不改变 Product Bundle。

### Task 2：实现独立候选 Host 与 Client 包

- [x] 添加候选 `package.json`、TypeScript 配置和 Client 构建脚本。
- [x] 添加独立 SVG 品牌资源与精确 Host 路由。
- [x] 实现三册页布局、证据脊线、统一折叠按钮、响应式与主题。
- [x] 接通会话创建/打开/搜索、发送、审批、记忆、凭证、心跳和插件事务投影。
- [x] 确保异步请求有卸载保护、搜索请求可取消、错误可见且不泄露命令/凭证。

### Task 3：实现候选 Profile 覆盖层

- [x] 添加独立 Bundle manifest 和最小 patch。
- [x] 构建精确本地 tarball；在隔离 `DSH_HOME` 中先安装 Product Bundle，再安装候选 Bundle。
- [x] dump config 证明原壳禁用、候选壳启用、其余 Product 服务保持原组合。

### Task 4：真实浏览器验收

- [x] 在隔离候选 Profile 启动 Web Host 并真实挂载。
- [x] 实测 1280px 桌面 DOM、左右按钮尺寸和两册收起/展开；窄屏抽屉、紧凑屏及 reduced-motion 断点由候选契约测试固定。
- [x] 检查当前来源控制台 error/warning 日志为零，在验收会话渲染截图并保存结构化验收证据。
- [x] 停止 Host，并确认端口关闭；保留的证据/临时目录已明确登记。

### Task 5：总体验证与交接

- [x] 运行候选包/Bundle 单测、类型检查、构建。
- [x] 运行根工作区测试、Python 测试、类型检查和构建；区分新失败与既有环境限制。
- [x] 保存文件清单、命令、结果、哈希、未完成边界和回退方式。
- [x] 刷新 `交接工具/当前状态.md` 与交接 manifest，保持原三个工作树不被清理或重置。

## 完成定义

只有同时满足以下条件，才可称“候选版已完成”：

- 原 `packages/native-shell/` 和 `packages/product-bundle/` 的既有内容未被候选任务改写；
- 候选包通过测试、类型检查和构建；
- 候选 Bundle 在隔离 Profile 的 dump config 中真实生效；
- 浏览器真实挂载、控制台无错误，两个折叠按钮测得相同尺寸；
- Phase 4–6 服务状态在候选 UI 中来自真实投影；
- 交接材料可在另一台设备上区分“源码候选”“本机验收”“尚未做跨平台验收”。

## 最终本机证据

- 候选包：4 个测试文件 / 9 项测试通过；typecheck/build 通过。
- 候选覆盖 Bundle：1 个测试文件 / 1 项测试通过；typecheck/build 通过。
- 新鲜隔离 Profile：baseline、候选 Client、候选品牌、Heartbeat 探针均通过；原壳停用且 Product 服务组合未变。
- 浏览器：三册页真实挂载；展开列 `264px 712px 304px`，收起列 `76px 1152px 52px`；四次按钮测量均为 `36px × 36px`；亮/暗主题通过；当前来源日志为零。
- 插件管理：真实审计并准备一次性确认，确认按钮可见但未执行；原始 token 不进 DOM，目标 Profile 未创建。
- 结构化证据：`docs/evidence/native-shell-ui-candidate/`。
