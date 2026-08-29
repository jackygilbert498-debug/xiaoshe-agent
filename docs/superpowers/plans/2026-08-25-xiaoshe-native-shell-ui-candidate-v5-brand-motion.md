# 小蛇原生壳界面候选 V5 品牌与动效实施记录

**状态：** 本机工程、隔离 Profile 与实时 HTTP 验证通过；目标显示器视觉复核待确认；未推广、未替换原壳

**日期：** 2026-08-25

**范围：** 只在 `@xiaoshe/native-shell-candidate` 中补回浏览器品牌、正式标识轮廓和原版小蛇的克制动效；保留 V4 的三栏、自适应、真实服务接线和隔离候选边界

## 问题判断

V4 已解决 `2269 × 1214` 视口的比例问题，但仍有两类可见缺口：浏览器标签继续显示宿主的 `DSH Local Build` 与旧 favicon；候选把原版小蛇的品牌细节压得过平，缺少流光、呼吸状态、内容进入和正式轮廓水印。问题不是再做一套新视觉，而是候选没有完整继承正式品牌和原版的动效语法。

## V5 设计决策

- 浏览器标签由候选 Client 在挂载后接管：空会话或 DSH 占位标题显示 `小蛇`，有会话标题时保留任务名并追加 `— 小蛇`。
- favicon 只使用 `runtime/xiaoshe-legacy/ui/assets/snake.svg` 对外提供的正式品牌端点；查询键绑定该文件 SHA-256 前缀，避免旧图标缓存。
- 对宿主后续重写 title/favicon 使用只观察 `head` 的 `MutationObserver`；不观察或接管 `body`，卸载时恢复原 title 与 icon。
- 顶部品牌标和空态“小蛇”共用原版四段配色与 9 秒低频流光；亮色主题使用原版对应的深色梯度。
- 空态右侧水印不绘制新的 `S`：用正式 `snake.svg` 作为输入，通过 SVG `feMorphology` 与 `feComposite` 提取轮廓。
- 恢复连接点、待命点和运行状态的低频呼吸，以及消息进入的 180ms 上浮；按钮只保留 1px 位移和轻微焦点光圈。
- 保留每个 reduced-motion 降级：系统要求减少动态时，动画与过渡全部关闭。
- 保持视觉克制：不恢复笨重胶囊、重阴影、遍地霓虹，也不增加第二套品牌图形。

## 实施与验证

- [x] 先增加浏览器 title/favicon 生命周期、正式资源哈希、动效和轮廓的失败测试。
- [x] 实现有会话标题保留、favicon 全量纠正、宿主回写监听和卸载恢复。
- [x] 用正式品牌端点完成左栏标识 mask 与空态轮廓派生，没有手写替代 `S`。
- [x] 恢复 9 秒四段流光、呼吸状态、180ms 消息进入、交互反馈和 reduced-motion。
- [x] 保留 V4 的 `1600 / 2200 / 1180 / 860 / 620` 五档自适应合同与左右栏收放。
- [x] 候选包 4 个文件 14 项测试、typecheck 与 build 通过。
- [x] 候选覆盖 Bundle 1 项测试、typecheck 与 build 通过。
- [x] Node 24 完整 `pnpm run check` 通过：根 Vitest 31 个文件通过、1 个条件跳过，102 项通过、5 项跳过；Python 15 项、根 typecheck 和 production build 通过。两个慢 Profile 在首次冷缓存整门运行中曾触发固定超时，随后底层真实 verifier、原 Vitest 包装器和完整整门复跑均 PASS。
- [x] 新鲜 V5 隔离 Profile 完成离线打包、安装、启动与 HTTP 探针；原壳保持停用，Product 服务组合与 baseline sentinel 保持。
- [x] `launchd` 候选任务已切换到 V5 Profile；60448 返回与最终构建哈希一致的 Client、正式 Brand 与 healthy Heartbeat，stderr 为 0。
- [ ] 用户在目标显示器强制刷新后确认浏览器标签、favicon、流光密度、轮廓透明度与整体质感。

## 推广门

V5 仍是隔离候选。目标显示器视觉确认、对应设备的 Windows/Linux、DPI 和其他显示器拓扑复验，以及另行授权之前，不替换原壳、不合并、不提交、不发布。

结构化证据见 `docs/evidence/native-shell-ui-candidate-v5/`。
