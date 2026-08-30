# 小蛇 Agent

小蛇是一套本地优先的桌面 Agent 产品源码。仓库内包含可直接构建的产品层、插件、DSH 运行时、旧版小蛇兼容层，以及 Windows/macOS 安装与启动入口。

本仓库面向希望自行安装、运行或继续开发小蛇的开发者。内部设计稿、修改过程、测试夹具、验收证据、个人会话、运行期 Profile 和密钥不属于发行内容。

## 包含的能力

- 会话与任务：DSH Agent 循环、会话日志、任务时间线、后台任务与中止/继续控制。
- 产品界面：小蛇原生产品壳、亮暗主题、响应式布局、状态/记忆/能力检查器。
- 桌面能力：屏幕观察、区域放大、点击、输入、按键、窗口列举与聚焦；危险动作接入审批策略。
- 记忆与上下文：长期/项目记忆入口、上下文预算与压缩状态。
- 插件治理：插件目录、能力说明、安装状态、受控启停与设置贡献。
- 完成验证：验证策略、完成凭证、心跳与运行状态。
- 多模型与工具：由 DSH 提供模型路由、工具、技能、子代理和会话连续性。

核心产品插件位于 `packages/`：

| 插件 | 作用 |
| --- | --- |
| `product-bundle` | 组合小蛇当前正式产品能力 |
| `native-shell-legacy-adapted` | 小蛇正式界面与交互层 |
| `runtime-dsh-provider` | 把 DSH 会话、模型和审批状态提供给产品壳 |
| `memory` | 记忆读写和界面贡献 |
| `plugin-governance` | 插件目录、状态与治理 |
| `task-timeline` | 任务时间线和运行轨迹 |
| `completion-receipt` | 完成凭证 |
| `verification-policy` | 完成前验证策略 |
| `heartbeat` | 运行心跳与健康状态 |
| `terminal-client` | 终端客户端入口 |

## 环境要求

- Node.js 24（兼容声明为 `^22.19.0 || >=24.0.0`，发行安装器按 Node 24 验证）
- Git
- Python 3
- Windows 10/11，或 macOS 13 及以上
- macOS 自动补装 Node 时需要 Homebrew

安装器会在用户目录中配置项目专用的 pnpm 11.7.0，不会把 API Key 写入仓库。

## Windows 安装与启动

```powershell
git clone https://github.com/jackygilbert498-debug/xiaoshe-agent.git
cd xiaoshe-agent
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup\install-windows.ps1
```

安装后双击 `启动小蛇-Windows.cmd`，或重开终端输入 `s`。只读诊断可运行 `xiaoshe-doctor`；停止可双击 `停止小蛇-Windows.cmd`。

## macOS 安装与启动

```bash
git clone https://github.com/jackygilbert498-debug/xiaoshe-agent.git
cd xiaoshe-agent
bash ./setup/install-macos.sh
```

安装后双击 `启动小蛇.command`，或重开终端输入 `ss`。终端版使用 `s`，停止可双击 `停止小蛇.command`。

首次使用时请在小蛇设置中配置模型服务商与 API Key。桌面观察和操作还需要在系统设置中向实际运行小蛇的宿主授予屏幕录制和辅助功能权限；安装器不会绕过系统授权。

## 手动构建

不使用安装器时，按以下顺序冷构建：

```bash
pnpm --dir runtime/DSH install --frozen-lockfile
pnpm --dir runtime/DSH run build
pnpm install --frozen-lockfile
pnpm -r --filter './packages/**' run build
pnpm -r --filter './packages/**' run typecheck
pnpm run typecheck
pnpm run build
```

随后可将产品插件写入 DSH Profile：

```bash
pnpm --dir runtime/DSH dsh plugin --profile web add \
  '@liustack/modlens@3.22.0' \
  "$PWD" \
  "$PWD/packages/verification-policy" \
  "$PWD/packages/native-shell-legacy-adapted" \
  "$PWD/packages/runtime-dsh-provider" \
  "$PWD/packages/completion-receipt" \
  "$PWD/packages/runtime-contract" \
  "$PWD/packages/heartbeat" \
  "$PWD/packages/memory" \
  "$PWD/packages/plugin-governance" \
  "$PWD/packages/task-timeline" \
  "$PWD/runtime/DSH/packages/session-query/tool-session-query" \
  "$PWD/packages/product-bundle"
node ./scripts/ensure-profile-patch.mjs \
  --target "${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml" \
  --template ./setup/profile/cordis.patch.yml
pnpm --dir runtime/DSH dsh web --dump-config
```

## 目录

```text
packages/                 小蛇产品插件
runtime/DSH/              Agent 内核与 Web/CLI 运行时
runtime/xiaoshe-legacy/   旧版界面资产与桌面能力兼容层
src/                      桌面能力、产品身份和运行路由
python/                   Node 与 Python 桌面能力桥
setup/                    Windows/macOS 安装器与公开 Profile 配置
scripts/                  启动、停止、诊断和 Profile 辅助脚本
```

## 安全与数据边界

- 仓库不包含 API Key、Token、个人会话或本机权限状态。
- 点击、输入、按键和窗口聚焦接入 DSH 的执行前审批；拒绝不会被覆盖。
- 设置 `XIAOSHE_DESKTOP_ACTIONS=off` 可在部署层关闭桌面动作工具。
- 屏幕截图写入当前用户临时目录，并在桥接进程卸载时清理。
- `DSH_HOME`、`XIAOSHE_DSH_ROOT`、`XIAOSHE_LEGACY_ROOT`、`XIAOSHE_PYTHON` 可用于显式覆盖运行路径。

## 许可

根产品代码当前标记为 `UNLICENSED`，公开可见不等于授予复制、修改或再分发许可。`runtime/DSH` 保留其目录内的 MIT License 与第三方声明；该许可证不自动覆盖仓库其他目录。
