# Xiaoshe Native Product Shell Phase 7 Relocatable Artifact Plan

**目标：** 交付一套不绑定生成机绝对路径的完整小蛇 Product 工件，并在不同目录、原生成目录不可用时完成离线安装和真实启动。

**边界：** 本阶段打包 XS Product 闭包；DSH 本体仍由锁定源码与依赖安装器提供。凭据、会话、设置、日志和系统权限不进入工件。

## Task 1：固定工件图与安全边界

- 工件包含 `@xiaoshe/dsh-desktop-control`、八个 Product 子包和 `@xiaoshe/product-bundle`。
- 所有 `workspace:*` 运行依赖在临时 pack 副本中改写为锁定版本，不修改源码 manifest。
- 每个 tarball 记录名称、版本、文件名、SHA-256、大小和安装顺序。
- 生成目录必须有专用 marker；重跑只能替换带合法 marker 的既有生成目录。
- 工件、manifest、tar 内 manifest 均不得出现生成机根路径。

## Task 2：目标机定位安装器

- 安装器只根据自身目录解析 tarball，不使用生成机路径。
- 在目标 Profile 初始化后，安装器按目标目录生成受管 `overrides` 区块；绝对 `file:` 路径只允许出现在目标机 Profile 中。
- 全部变更经官方 DSH CLI argv 完成，启用 `--offline`，随后执行 dump config。
- 安装器校验全部 SHA-256 后才修改 Profile；manifest 缺项、哈希漂移或路径越界立即失败。

## Task 3：跨目录真实验收

- 在临时目录 A 生成工件，复制到包含空格的目录 B，然后使 A 不可用。
- 仅使用 B、锁定 DSH 和新的 `DSH_HOME` 安装 Product Profile。
- 确认 B 的工件和新 Profile 均不包含 A。
- 启动真实 DSH Profile，验证根页面、Native Client、Memory、Heartbeat、插件治理、品牌和桌面状态端点。
- 停止后确认进程退出、临时会话 sentinel 未改变。

## Task 4：交接集成

- 正式 macOS/Windows 接收脚本可选择已有离线工件，或从源码锁定重建。
- 更新当前状态、证据、完整性清单和下一接力边界。
- 完整门禁包含单元测试、跨目录 Profile 验证、根门禁和 Python Bridge。

## 完成门

- 工件在 A 消失后仍可从 B 离线安装并启动；
- 生成机路径在 B、目标 Profile manifest、workspace overrides 和 lockfile 中出现次数为 0；
- 工件哈希、安装顺序、实际 Profile roster 和 HTTP 探针全部通过；
- 不携带任何凭据或个人运行状态。

## 实施结果（2026-08-25）

- 10 个 Product 包已生成到 `交接工具/离线工件/xiaoshe-product/`，manifest 含锁定版本、安装顺序、大小与 SHA-256。
- 工件从目录 A 复制到包含空格的目录 B 后，A 被置为不可用；仅依靠 B 完成新 Profile 离线安装与真实启动。
- 生成源路径在搬移工件和目标 Profile 中均为 0；10 个依赖均解析为目标机本地 override。
- 根页面、Native Client、Heartbeat、Memory、插件事务、品牌与桌面状态 7 个端点均返回 HTTP 200，sentinel 未变化。
- 可重复验证入口为 `pnpm run accept:phase7`；结构化证据见 `docs/evidence/native-shell-phase-7/relocation-report.json`。
