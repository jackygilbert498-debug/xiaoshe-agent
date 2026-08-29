# 小蛇 · 本地优先桌面 Agent

小蛇以一个统一入口承接本地对话、项目任务、记忆、插件治理、权限审批、完成凭证和受控桌面操作。内置 DSH 负责 Agent 循环、会话与模型运行，产品能力继续通过可安装、可卸载、可审计的插件边界接入。

## 公开源码说明

本仓库将小蛇产品层、内置 DSH 运行时与 legacy 兼容层放在同一棵可安装源码树中，保留各自插件边界与上游许可证。根包当前为 `UNLICENSED`；`runtime/DSH` 继续遵循其目录内的 MIT 许可证，不能据此推定其余产品代码采用 MIT。

公开仓库不包含 API Key、Token、个人会话、系统权限授予、运行期 Profile、构建缓存、验收截图、仅限本机的路径证据、完整交接包或离线工件。这些内容不属于可安全公开的源码；需要换机时应使用单独生成并校验的交接包，而不是依赖 Git 仓库恢复本机状态。

界面采用可卸载的“小蛇产品视觉层”：以 DSH 稳定插槽和语义变量为边界，恢复亮白留白／墨玉银白双主题、玉绿色与香槟金 token、会话舞台、输入区和工具卡状态。正式品牌标识的唯一母本是 [`runtime/xiaoshe-legacy/ui/assets/snake.svg`](./runtime/xiaoshe-legacy/ui/assets/snake.svg)；它是带方瞳负空间与右侧视线切口的蛇形标，禁止用普通字母 `S`、圆点眼睛或临时重绘稿替代。

产品布局为“左侧项目/会话｜中间任务流｜右侧状态/记忆/系统”。右侧检查器通过 DSH 的根级扩展位接入：宽屏固定为 320px 第三栏，可收为 52px 工作台轨道并记住本浏览器偏好；窗口小于 1180px 时改用临时“状态”抽屉，不覆盖输入区。左栏继续使用 DSH 原生 280/56px 收放状态，小蛇通过真实网格列尺寸同步顶部抬头，不复制第二套侧栏逻辑。

无任务首页采用“小蛇待命 · ATELIER／正式蛇标与小蛇字标／一句话承诺”的主视觉。定位文案明确为“看懂屏幕、接手本机任务、关键动作先确认、完成后再验证”，其下只保留“看得见桌面／真能动手做／关键操作可控”三项静态特点；特点采用无底色、无圆框的轻量标线排列，避免厚重胶囊被误认成按钮。原 01–03 通用示例任务已经移除，不再把产品能力说窄。不显示 DSH 的“探索未至之境/预览版”文案，也不在空态或会话底部叠加巨大文字水印。输入区使用清晰的实体边界、悬浮层级和聚焦反馈。按钮与选择器不再使用浏览器默认蓝框：鼠标点击保持安静，键盘导航显示墨玉绿细环与柔和外晕。右栏仅对当前任务使用强调卡，其余信息为扁平分组；状态来自真实 Bridge 接口和当前页面工具、计划、审批、消息与上下文轨迹，记忆页只呈现 DSH 已有边界，不伪造数量。

当前版本采用迁移桥接：Node 插件通过 JSON-RPC stdio 调用 `runtime/xiaoshe-legacy` 中已经验证过的 Python 屏幕能力。桥接进程不继承 API Key、Token、Secret 或 Password 环境变量，截图写入仅当前用户可访问的临时目录，进程卸载时清理。启动器优先使用 XS 内置的 `runtime/DSH` 和 `runtime/xiaoshe-legacy`，显式环境变量仍可覆盖；只在未带交接载荷时才回退到 `$HOME/Desktop/DSH` 与 `$HOME/Desktop/小蛇`。

## 换机交接

GitHub 仓库是可冷安装的公开源码快照，不是包含本机状态的完整交接包。跨设备迁移时应另行生成并校验整个 XS 交接单元；接收方先打开 [`交接工具/从这里开始.md`](./交接工具/从这里开始.md)，按其中的 macOS/Windows 安装、哈希与 Git 复验流程执行。

本包故意不收录 API Key、Token、个人会话、本机权限授予和 `node_modules`。这些不是源码，也不能安全或可靠地跨机复用；接收工具会重建依赖与 Profile，密钥和系统权限由新设备重新配置。

## 能力

- `screen_observe`：截取主屏、读取 AX/UIA 元素、创建不可复用的视口版本。
- `screen_zoom`：裁剪并放大指定视口区域，同时保留回屏坐标映射。
- `screen_click`：按元素标识或视口图内坐标点击；动作前检查视口是否过期。
- `screen_type`：向当前聚焦控件输入文本，不在结果中回显原文。
- `screen_press`：向当前前台窗口发送按键。
- `screen_verify`：重新观察并比较截图哈希与 AX/UIA 元素变化。
- `screen_list_windows`：只读列出唯一顶层窗口标题，重复标题不生成可执行目标。
- `screen_focus_window`：用临时 ID 和完全一致标题聚焦窗口；执行前重新复核，属于审批动作。

点击、输入、按键和窗口聚焦始终向 DSH 的 `tools/pre-execute` 管线返回 `ask`；下游策略的拒绝不会被覆盖。若会话关闭审批提示，这些动作会失败关闭，不会静默执行。设置 `XIAOSHE_DESKTOP_ACTIONS=off` 后，四个动作工具不会注册。

## 本地开发

DSH `0.1.0-rc.8` 要求 Node `^22.19` 或 `>=24`。全新源码目录必须先构建内置 DSH，再按拓扑构建 XS 工作区包；不能依赖旧设备遗留的 `lib`：

```sh
PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin pnpm --dir runtime/DSH install --frozen-lockfile
PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin pnpm --dir runtime/DSH run build
PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin pnpm install --frozen-lockfile
PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin pnpm -r --filter './packages/**' run build
PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin pnpm run check
```

构建和验收通过后，从 XS 内置 DSH 安装到当前 Web Profile：

```sh
pnpm --dir runtime/DSH dsh plugin --profile web add @liustack/modlens@3.22.0 "$PWD"
pnpm --dir runtime/DSH dsh web --dump-config
```

## 日常启动与设置

macOS 可双击 [`启动小蛇.command`](./启动小蛇.command)，或在新终端输入 `ss`。Windows 可双击 [`启动小蛇-Windows.cmd`](./启动小蛇-Windows.cmd)，也可在新终端输入 `s`；停止和只读诊断分别可双击 [`停止小蛇-Windows.cmd`](./停止小蛇-Windows.cmd)、[`诊断小蛇-Windows.cmd`](./诊断小蛇-Windows.cmd)，诊断命令为 `xiaoshe-doctor`。Windows 的 `.cmd` 外层使用系统自带 PowerShell 5.1 且绕过用户 Profile，再由 ASCII 入口调用必需的 PowerShell 7，避免中文 UTF-8 脚本被旧宿主误解码。所有入口都指向当前 XS 和同一个 DSH `web` Profile，不调用旧 `run.py`。启动入口会启动唯一的 DSH `web` Profile、等待 `/xiaoshe/desktop/status` 证明 Bridge 与小蛇插件就绪，再打开浏览器。健康实例会直接复用；如果 3080 被其他程序占用，入口只报出 PID，不会结束该进程。

服务由当前 macOS 用户的 `launchd` 直接监督最终 DSH Node 进程，关闭启动终端不会让小蛇随之消失。可双击 [`停止小蛇.command`](./停止小蛇.command) 安全停止；Windows 可双击 [`停止小蛇-Windows.cmd`](./停止小蛇-Windows.cmd)，底层按所有权 PID 结束进程树。`ss`（macOS）和 `s`（Windows）都已指向统一入口；旧 Python CLI 不再是日常入口。

在“小蛇 → 设置 → 插件 → 小蛇桌面能力”中可以：

- 查看 Bridge、ModLens 和系统屏幕权限状态；
- 真实检测一次屏幕权限，并仅通过一次性随机 URL 预览私有截图；
- 持久开启或关闭桌面动作。关闭后点击、输入、按键工具会从模型工具表动态移除；部署级 `XIAOSHE_DESKTOP_ACTIONS=off` 仍是不可由界面绕过的上限。

观察、验证和动作工具都声明了可回放结果卡。动作卡只持久化操作前后视口、是否变化、元素增删数量和目标摘要；输入卡隐藏原文，只显示字符数。

环境覆盖项：

- `XIAOSHE_DSH_ROOT`：DSH 源码根目录；默认优先 `XS/runtime/DSH`。
- `XIAOSHE_LEGACY_ROOT`：旧小蛇兼容层根目录；默认优先 `XS/runtime/xiaoshe-legacy`。
- `XIAOSHE_PYTHON`：Python 解释器；默认优先 `/opt/miniconda3/bin/python3`，其次 `python3`。
- `XIAOSHE_DESKTOP_ACTIONS=off`：完全关闭点击、输入和按键工具。
- `XIAOSHE_DESKTOP_TIMEOUT_MS`：单次桥接请求超时，默认 60000 毫秒，允许 5000–180000。

## macOS 系统权限

`screen_observe` 需要实际运行 DSH 的宿主进程拥有“屏幕与系统录音”权限。未授权时桥接会以 `SCREEN_CAPTURE_FAILED` 明确失败，不会伪造截图、沿用旧图或在缺少画面证据时继续执行桌面动作。AX 辅助功能和视觉 Provider 是独立链路，必须分别验收。

macOS 的授权按宿主区分，`ss`/launchd 正式入口与 Terminal 诊断进程可能拥有不同授权。日常应以“小蛇 → 设置 → 插件 → 小蛇桌面能力”的真实探针为准；下面脚本只诊断 Terminal 这条宿主路径。当前版本已通过 Windows 冷安装与自动化门禁，目标 macOS 设备上的最终实机验收仍需在迁移后执行：

```sh
./scripts/run-macos-screen-smoke.command
```

脚本会真实执行截图、元素读取、私有文件权限和退出清理检查，并把日志与退出码写入已被 Git 忽略的本机 `docs/evidence/`。公开源码不携带这些设备证据；验收设备应重新生成并保存自己的结果。

## 当前边界

本阶段只提供主显示器能力。ModLens 负责理解 `screen_observe` 返回的图片路径；本 Bundle 不复制另一套视觉模型。截图路径是运行期证据，进程退出后失效；G4 会接入 DSH 附件存储，提供可配置的持久证据保留，并收口原生 Provider、Windows、多显示器与 DSH TUI。
