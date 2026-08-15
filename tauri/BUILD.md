# 小蛇桌面壳 · 构建说明（tauri/）

Tauri 2 薄壳：系统 WebView 渲染 `run.py serve` 的本机 Web UI（http://127.0.0.1:7788），
两端零代码分叉，差异只在壳层能力（托盘/单实例/自启/深链 TODO）。

## 1. 工具链

| 依赖 | 安装 | 备注 |
|---|---|---|
| Rust（rustup） | https://rustup.rs | MSRV 1.77.2（Tauri 2） |
| tauri-cli | `cargo install tauri-cli --version '^2.0'` | 提供 `cargo tauri` 子命令 |
| Windows | Visual Studio Build Tools（MSVC + Windows SDK） | WebView2 运行时由安装包带：`tauri.conf.json` 已配 `webviewInstallMode: embedBootstrapper`（随包 ~1.8MB 引导器，安装时需联网；要纯离线改 `offlineInstaller`，+~127MB） |
| macOS | Xcode Command Line Tools | 分发需签名+公证（见 §4） |
| Linux（可选第三平台） | `webkit2gtk-4.1` 等，见官方 Prerequisites | 非本里程碑目标 |

侧车运行时需要 **Python ≥3.11**（发现策略见 §3）。

## 2. 构建与产物

```bash
# 开发：起壳 → 壳自动 spawn 仓库根的 run.py serve --no-browser
cd tauri && cargo tauri dev

# 发布：双平台安装包
cd tauri && cargo tauri build
```

产物位置（`tauri/target/release/bundle/`）：

- Windows：`msi/小蛇_0.1.0_x64_en-US.msi`、`nsis/小蛇_0.1.0_x64-setup.exe`
- macOS：`macos/小蛇.app`、`dmg/小蛇_0.1.0_aarch64.dmg`

注意：**打包产物默认不含 python 侧车**（run.py/harness/ui 不进 bundle），
安装包当前等价于「要求系统 python」方案（§3-甲）。要出自包含安装包，
先按 §3-乙/丙备好运行时，再经 `bundle.resources` 挂入（届时补 conf）。

## 3. 侧车（python）打包三案

壳的进程发现顺序：`XIAOSHE_PYTHON` 环境变量 → exe 同级 `runtime/python/` 内嵌解释器
→ 系统 `python3`/`python`/`py -3`（均探测版本 ≥3.11）；`run.py` 同理可用
`XIAOSHE_RUN_PY` 显式指定。三案利弊：

- **甲 · 要求系统 Python ≥3.11**：包最小（壳仅 ~10MB），无额外维护。
  弊端：用户环境参差（未装/版本旧/被 venv 遮蔽）→ 全部落到壳的错误面如实报，
  首装体验差。适合开发者分发，不适合最终用户。
- **乙 · PyInstaller 单文件 harness**：把 `run.py serve` 打成单 exe，
  壳把 spawn 目标从 `python run.py serve` 换成该 exe（改 main.rs 一处 + conf 挂 resource）。
  利：单文件、免装 python、分发简单。弊：杀软误报率高、启动有解包开销、
  跨平台要各打一份、stdout 就绪行协议必须原样保留（--no-browser 分支已满足）。
- **丙 · 内嵌 python-build-standalone**：官方预编译 CPython 随包解压到
  `runtime/python/`（壳的发现策略②已认这个布局），侧车仍跑源码 run.py。
  利：行为与开发态 100% 一致（同一源码、同一依赖解析），无 PyInstaller 黑盒；
  弊：包 +60~80MB，安装器要处理解压/清理。最终用户分发推荐此案。

## 4. 图标与杂项

- 图标全部程序化生成：`python scripts/export_icons.py`（改 ui/assets/snake.svg 后重跑）。
  `tauri/icons/icon-{16,32,128,256,512}.png` 已进 git，被 conf `bundle.icon` 与
  main.rs 托盘（include_bytes）引用。Windows `.ico` / macOS `.icns` 由
  tauri-cli 在构建时从 PNG 自动转换；也可 `cargo tauri icon tauri/icons/icon-512.png`
  重新生成全套（会覆盖 icons/ 目录，注意保留 icon-16/256）。
- macOS 分发：需 Apple Developer 证书做 Developer ID 签名 + notarytool 公证，
  否则 Gatekeeper 拦截；conf 无需改，`cargo tauri build` 读环境变量
  （`APPLE_CERTIFICATE` / `APPLE_API_KEY` 等，见官方 Signing 文档）。开发者自测
  可右键打开绕过。
- 深链 xs://：main.rs 已留 TODO 方案（tauri-plugin-deep-link + 单实例回调转发），
  待 Web 侧有消费方再接。

## 5. 常见坑

1. **7788 端口被占**：serve 固定 `--port 7788`，被占则进程退出 → 壳显示错误页
   「未输出就绪行」，dev 终端 stderr 有真实原因。先释放端口再启动。
2. **就绪超时 5s**：main.rs `READY_TIMEOUT` 常量，冷机/慢盘可调大；错误页会写明秒数。
3. **python 探测慢**：四个候选逐个 `--version` 探测各起一次进程（共 ~百毫秒级），
   属一次性启动开销，勿为此引入缓存复杂度。
4. **窗口导航用 eval(location.replace)**：刻意不用 `WebviewWindow::navigate`
   （2.x 早期小版本签名有变动），勿「顺手优化」回去。
5. **capabilities**：壳未暴露任何 IPC 权限（无 capabilities/ 目录）。
   接 autostart/deep-link 的 JS API 时须新增 capabilities 清单并过安全评审。
