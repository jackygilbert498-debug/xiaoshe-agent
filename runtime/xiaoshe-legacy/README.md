# 小蛇 Legacy 兼容层

该目录保存小蛇已经验证过的 Python 桌面能力和界面资产，供仓库根目录的正式产品插件通过 JSON-RPC stdio 桥接复用。

正常安装和启动请回到仓库根目录运行：

- Windows：`setup/install-windows.ps1`
- macOS：`setup/install-macos.sh`

主要目录：

- `harness/`：桌面观察、权限、工具、会话、记忆和运行适配器。
- `ui/`：小蛇正式视觉资产，`ui/assets/snake.svg` 是产品蛇标母本。
- `run.py`：兼容层独立入口，主要用于底层诊断；日常产品入口由根目录启动器负责。

模型凭据只应写入本机环境或安全存储；仓库只提供 `.env.example`，不包含实际密钥和个人运行状态。
