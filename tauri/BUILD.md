# 桌面壳构建

桌面壳使用 Tauri 2。它启动仓库根目录的 `run.py serve --no-browser`，并在系统 WebView 中展示本地界面。

## 要求

- Python 3.11+
- Rust 1.77.2+
- Tauri CLI 2
- Windows：Visual Studio Build Tools（MSVC 与 Windows SDK）
- macOS：Xcode Command Line Tools

## 构建

```powershell
cargo install tauri-cli --version "^2.0"
cd tauri
cargo tauri build
```

构建结果位于 `tauri/target/release/bundle/`。当前桌面包不内嵌 Python，因此运行机器仍需安装 Python 3.11+；也可以通过 `XIAOSHE_PYTHON` 指定解释器，通过 `XIAOSHE_RUN_PY` 指定入口文件。

Windows 安装包首次运行依赖 WebView2。macOS 对外分发需要开发者签名与公证。
