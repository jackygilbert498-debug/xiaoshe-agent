# 小蛇（Xiaoshe Agent）

小蛇是一个在本机运行的个人 Agent 工作台。它提供终端模式、本地网页界面、模型切换、工具审批、任务队列、会话记忆、后台任务以及可回退的 Runtime feature flags。

这个公开仓库只包含运行和构建所需的源码与配置模板，不包含 API 密钥、会话、日志、截图、评测产物、开发记录或交接材料。

## 环境要求

- Windows、macOS 或 Linux
- Python 3.11 或更高版本
- 可用的 DeepSeek、Kimi 或其他兼容模型服务密钥
- 可选：构建桌面壳时需要 Rust 与 Tauri 2 工具链

Python 运行端只使用标准库，不需要执行 `pip install`。

## 快速开始

```powershell
git clone https://github.com/jackygilbert498-debug/xiaoshe-agent.git
cd xiaoshe-agent
Copy-Item .env.example .env
notepad .env
py -3 run.py serve
```

浏览器通常会自动打开本地界面。如果没有打开，请访问终端显示的 `127.0.0.1` 地址。

Windows 也可以配置一字母终端入口：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

重新打开 PowerShell 后，输入 `s` 启动交互模式，或执行：

```powershell
s -p "检查这个项目并给出下一步建议"
```

不安装快捷入口也可以直接运行：

```powershell
py -3 run.py
py -3 run.py -p "读取 README 并总结"
```

## 配置模型

1. 将 `.env.example` 复制为 `.env`。
2. 填写你自己的服务商密钥。
3. 用 `MODEL_PROVIDER` 选择新会话默认服务商。
4. 启动后可以在模型菜单即时切换已配置的 Kimi、DeepSeek，或通过“＋ 添加模型”配置兼容服务商。

密钥只保存在本机；界面不会回显完整密钥，`.env` 与本地状态目录也不会进入 Git。

## 安全控制

- 危险工具调用会经过权限审批。
- `SANDBOX_BACKEND=auto` 默认优先使用可用的隔离后端。
- `TOOL_NET_MODE=off` 默认阻止工具子进程出网；可信任务需要联网时可以显式改为 `proxy` 或 `open`。
- E0-E4 Runtime 能力支持 `off`、`shadow`、`on`，可以逐项启用和回退。
- 会话、日志、模型密钥和任务数据库保存在 `.state/` 等本地目录中，不参与同步。

关闭沙箱或开放网络会降低隔离强度。只应对你信任的项目和命令启用。

## 可选桌面壳

桌面壳位于 `tauri/`，它会启动本地 Python 服务并通过系统 WebView 展示界面。

```powershell
cargo install tauri-cli --version "^2.0"
cd tauri
cargo tauri build
```

当前源码包不捆绑 Python 运行时，因此目标机器仍需安装 Python 3.11+。详细构建要求见 `tauri/BUILD.md`。

## 目录

```text
run.py        终端、无头任务和本地界面入口
harness/      Agent Runtime、权限、模型、任务与记忆能力
ui/           本地网页界面
tauri/        可选桌面壳
.env.example  不含真实密钥的配置模板
```

## 本地数据边界

公开仓库不会收集或附带你的本地数据。请不要提交以下内容：

- `.env` 或任何真实 API key
- `.state/`、数据库、会话与记忆文件
- `logs/`、截图、诊断包或评测输出
- 私有 MCP 配置

## License

MIT
