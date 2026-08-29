# 小蛇原生产品壳统一修正实施计划

> **执行约束：** 用户已于 2026-08-27 统一授权直接实施，不再逐项等待确认。每个行为先写失败测试再改生产代码；保留当前三个工作树的未提交与未跟踪成果，禁止 reset、clean、stash、覆盖、擅自提交或发布。

**目标：** 在不改变旧版视觉身份和主体尺度的前提下，恢复可编辑记忆，重做权限/思考强度交互，细化蛇形水印，并以插件贡献边界实现真实可用的设置入口。

**架构：** `@xiaoshe/native-shell-legacy-adapted` 仍是唯一根视图 Consumer；Memory、Model、Permission、Plugin Governance 等 Provider 保持事实真源。设置壳只聚合公开贡献，不复制 Provider 配置。运行事实保持 Provider 权威；仅主题、布局和输入方式等真正属于本机界面的偏好允许由其所有者本地持久化。

**技术栈：** TypeScript、React Client plugin、Cordis/DSH 公共 Client 服务、Vitest、CSS、真实 Chromium 浏览器验收、PowerShell 交接工具。

---

## Task 1：冻结设计和当前基线

**新增：**
- `docs/superpowers/specs/2026-08-27-xiaoshe-native-shell-refinement-settings-memory-design.md`
- `docs/superpowers/plans/2026-08-27-xiaoshe-native-shell-refinement-settings-memory.md`

1. 记录用户已批准的视觉不变量、上弹菜单、设置边界和可编辑记忆合同。
2. 记录 V6 只读记忆是 UI 迁移回归，而不是底层能力缺失。
3. 保存适配壳、Memory 包、顶层及两个 runtime 工作树的 HEAD/dirty 基线。
4. 运行适配壳测试、类型检查和 Memory 测试，记录 Windows 链接警告但不得把它误报为失败。

## Task 2：先写失败的交互与服务测试

**修改：**
- `packages/native-shell-legacy-adapted/tests/fixture.ts`
- `packages/native-shell-legacy-adapted/tests/interaction-contract.test.ts`
- `packages/native-shell-legacy-adapted/tests/heritage-contract.test.ts`
- 必要时新增 `packages/native-shell-legacy-adapted/tests/memory-editor.test.ts`

1. 扩展 fixture，使 Memory 快照包含 id、text、scope、state、version/revision、project 和更新时间，并提供 `remember`/`setState` spy。
2. 写测试验证记忆页可新建、编辑、遗忘、恢复，写操作携带 revision；冲突后刷新且保留草稿。
3. 写测试验证权限和思考强度不再存在原生 `select`，点击触发向上菜单、选择后调用现有服务，Escape/外部点击关闭，完全访问仍需确认。
4. 写测试验证左下角只有齿轮设置入口，Ctrl K 仍能打开命令面板。
5. 写测试验证设置窗口只呈现已注册/可用贡献，不渲染尚未支持的空开关。
6. 写测试验证蛇形水印 morphology 半径为 `0.4`，其余几何属性不变。
7. 运行聚焦测试并确认因功能尚未实现而 RED。

## Task 3：恢复 Memory 公共写能力和编辑界面

**修改：**
- `packages/native-shell-legacy-adapted/src/client/index.ts`
- `packages/native-shell-legacy-adapted/src/client/adapted.css`

1. 把适配壳的 `memoryLifecycle` 类型恢复到公开服务真实合同：`refresh`、`remember`、`setState` 和完整条目字段。
2. 增加范围、状态、草稿、编辑项、忙碌和错误等瞬时 UI 状态。
3. 实现紧凑的新建/编辑表单、活动/已遗忘列表和修订信息。
4. 新建、修订、遗忘、恢复全部调用 Provider；revision 冲突时刷新并保留草稿。
5. 项目上下文缺失时禁用项目写入并显示真实原因。
6. 运行聚焦测试、适配壳全部测试和 Memory 测试至 GREEN。

## Task 4：重做权限与思考强度上弹控件

**修改：**
- `packages/native-shell-legacy-adapted/src/client/index.ts`
- `packages/native-shell-legacy-adapted/src/client/adapted.css`

1. 增加通用的轻量上弹选择菜单结构，仅共享视觉/关闭规则，不混淆业务语义。
2. 权限触发器使用盾牌图标；菜单展示说明、当前态和危险态，完全访问继续进入二次确认。
3. 思考强度触发器使用细线脑回路图标；展示关闭/低/高/最大及说明，写入现有模型服务。
4. 增加外部点击、Escape、选择后关闭、ARIA 和焦点样式。
5. 删除两个透明原生 `select` 的 DOM 与 CSS。
6. 运行交互测试和全量适配壳测试至 GREEN。

## Task 5：细化水印并实现插件贡献式设置入口

**修改：**
- `packages/native-shell-legacy-adapted/src/client/index.ts`
- `packages/native-shell-legacy-adapted/src/client/adapted.css`
- 如公共合同确有必要，新增最小 settings contribution service/package 及其测试

1. 把蛇形水印 `feMorphology` 的 dilate/erode 半径从 `0.75` 改为 `0.4`，不改尺寸、位置、透明度、渐变和品牌 Logo。
2. 左下角替换为齿轮 `设置` 按钮，移除重复右栏页签文字和常驻 Ctrl K 文案。
3. 保留 Ctrl K 全局行为，并在快捷键设置中说明。
4. 建立设置窗口/导航和可用性过滤合同；设置壳只渲染插件实际贡献的分组与行。
5. 第一版接入真实贡献：主题、现有模型/服务状态与入口、权限边界、受控插件管理、有效快捷键、版本/诊断信息。
6. 不为通知、自动更新、记忆数据等尚无公开写能力的项目创建伪开关。
7. 设置窗口在窄屏降级为全屏工作页，验证遮罩、Escape、焦点和滚动。

## Task 6：构建与真实浏览器验收

1. 运行适配壳测试、Memory 测试、类型检查和生产构建。
2. 重启或刷新 `127.0.0.1:3080` 的正式适配壳，不打开平行旧版本冒充结果。
3. 在真实 Chromium 中验证 DOM 挂载、控制台错误、权限菜单、思考强度菜单、设置页和 Memory CRUD。
4. 覆盖 1920×1080、1440×900、1024×768、760×900、390×844；检查横向溢出、遮罩、输入器、弹层和右栏滚动。
5. 记录截图、命令、退出码和关键 DOM/服务往返证据；任何未完成项必须明确标为 `PARTIAL` 或 `BLOCKED`。

## Task 7：交接与完成审查

**修改：**
- `docs/evidence/native-shell-legacy-adapted/` 下新增本轮证据
- `交接工具/当前状态.md` 或当前实际使用的交接文件

1. 记录变更文件、测试结果、启动命令、端口、Profile、已知边界和下一台设备复验步骤。
2. 更新交接时只追加/手术式修改，不覆盖既有 Phase 4–8 记录。
3. 执行完成前验证清单；只有新鲜证据全部通过才标记本机完成。
4. 不擅自 commit、merge、release 或删除候选版本。

## Task 8：标题栏比例与左右视觉平衡增量

**修改：**
- `packages/native-shell-legacy-adapted/src/client/index.ts`
- `packages/native-shell-legacy-adapted/src/client/adapted.css`
- `packages/native-shell-legacy-adapted/tests/runtime-consumer.test.ts`
- `scripts/verify-native-shell-legacy-adapted-visual.mjs`

1. 先写失败测试，固定 Heartbeat 健康/异常状态的真实视觉 tone，并增加已授权页面上的标题栏、栏宽、卡面、状态线和溢出断言。
2. 桌面标题栏改为同轴紧凑布局，保留标题字体和既有横向网格；移动断点仍允许自然换行。
3. 不改变栏宽，通过实体浅卡面、文字粗细层级和细状态线平衡右栏；颜色只由真实状态驱动。
4. 在亮色/墨玉主题及 1920、1440、1024、760、390 五档视口复验，完成后更新证据与交接。

## Task 9：长会话用户轮次导航与回底捷径

**修改：**
- `packages/native-shell-legacy-adapted/src/client/index.ts`
- `packages/native-shell-legacy-adapted/src/client/adapted.css`
- `packages/native-shell-legacy-adapted/tests/interaction-contract.test.ts`

1. 先写失败测试，固定“只索引用户轮次”、预览归一化/限长、原事件序号定位和离底阈值四项行为。
2. 从既有 Product 时间线派生短线标记；悬停/聚焦时延长并显示该轮内容，点击滚动到对应事件。
3. 使用同一个 `.stream` 容器计算距底距离；仅超过阈值时渲染回底按钮，点击后平滑回到最新消息并退出 DOM。
4. 不增加持久化状态、不修改 DSH/旧版母版；补齐 reduced-motion、ARIA、窄屏边界和亮/暗主题样式。
5. 运行包内 RED/GREEN、类型检查、构建、根总门禁和正式 3080 长会话浏览器验收，再更新交接 manifest。

## 执行结果（2026-08-27）

- Task 1–7 已完成当前 Windows 设备可执行部分。
- 实施中由真实 Profile 门禁发现并修复 `ui-conversation` 越过单一 root 边界的问题；没有放宽门禁。
- 适配壳 41/41、Product Bundle 3/3、Memory 13/13；根总门禁 111 项通过、1 项平台跳过，Python 15/15。
- 正式 `3080` 页面完成真实浏览器、设置、记忆、弹层和 1440/1024/720/412/390 响应式复验；控制台 0 error / 0 warning。
- 后续标题栏/左右重量增量已按 Task 8 实施：标准桌面标题栏 `138px → 92px`，标题与运行事实同轴；栏宽仍为 `232 / 292`，右栏改为状态驱动的实体浅卡面与 `2px` 状态线。
- Task 9 已实施：用户消息短线索引来自真实时间线，悬停/聚焦显示预览、点击精确定位；回底按钮只在距底超过阈值时浮现，回到底部即消失。390–1440 五档、亮/暗主题和正式长会话均通过。
- 精确证据与跨设备边界见 `docs/evidence/native-shell-legacy-adapted/2026-08-27-refinement-acceptance.md`；未提交、未合并、未发布。
