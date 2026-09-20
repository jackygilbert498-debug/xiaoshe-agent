# 第二阶段：真实启动与重启恢复

本入口验证源码开发模式的真实 macOS 产品链：`启动小蛇.command` → Electron `main.mjs` → 正式 shell → 自有 launchd 服务 → 实际产品 UI。它不是已安装发行包、签名公证或模型任务成功率证明。

执行 `npm run test:product:lifecycle`。前提是兼容 Node、Python、Electron、pnpm 缓存和产品构建已齐全；缺失时停止，不自动运行安装器。每次生成独立的 `output/stabilization/product-lifecycle-<UUID>/`，不覆盖旧报告。Windows 不模拟通过。

隔离边界：

- 新建私有临时根，服务名、端口、DSH_HOME、Profile、原生 userData、工作目录、日志和生命周期锁均独立。
- Profile 仅由公开 Bundle 配置和当前代码包组成，不读取或复制日常设置、凭据、会话。后台 cwd 也是新建空目录，防止 CLI 读取开发项目 `.env`。
- 禁用外部模型适配器、凭据服务、标题生成和遥测；零请求守卫在每次真正启动时留下 PID/时间绑定的挂载记录。任何模型尝试都使验收失败。
- 真桌面自动动作关闭；仅操作自有 Electron 页面和本机合成网页。所有合成会话、记忆、浏览器状态最后随自有 Profile 删除。

完整验收包括两次启动。seed 阶段实际点击设置和关于，捕获加载中界面请求的完整指纹，与后台身份和当前磁盘构建核对；通过真实 API 保存测试会话和记忆，在专用浏览器保存持久 cookie/localStorage。restore 阶段不重新写入这些状态，只读回并逐项核对。

父进程独立验证阶段报告的源码/身份/进程/时间绑定、实际 launchd PID 和 token、正常退出日志、端口及服务释放、两次守卫挂载、零模型请求，以及最终源码未变化。超时只清理自有进程组及匹配 token 的服务；无法证明所有权则保留现场并报失败，不按端口或名称强杀。

只有上述闭环全部成功才输出 `task-run.json`，仅覆盖固定目录中的 `version-start-current` 和 `version-session-restart` 两项。其他 28 项不能借此计算为通过。原始证据、失败报告和清理结果一并保存；不能把中途就绪或测试数量当成最终交付。

后续真实模型验收另用 `scripts/acceptance/live-request-budget.mjs`：支持 0 请求或固定 8 请求，每次输出上限 2048、真实 provider 重试 0 次，失败和重启不退还已占用请求。它不是货币硬费用上限，也不防恶意插件直接发网络请求；付费前仍需明确预算和允许的路由、工具范围，未知 usage 保留未知。
