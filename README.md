# 小蛇 Agent

小蛇是一套本地优先的桌面 Agent 产品源码。仓库内包含可直接构建的产品层、插件、DSH 运行时、旧版小蛇兼容层，以及 Windows/macOS 安装与启动入口。

本仓库面向希望自行安装、运行或继续开发小蛇的开发者。内部设计稿、修改过程、临时测试产物、验收证据、个人会话、运行期 Profile 和密钥不属于发行内容；用于保证源码可维护性的自动化测试随源码保留。

## 包含的能力

- 会话与任务：DSH Agent 循环、会话日志、任务时间线、后台任务与中止/继续控制。
- 产品界面：小蛇原生产品壳、亮暗主题、响应式布局、当前任务工作栏；记忆和运行环境集中在设置管理。
- 桌面能力：屏幕观察、区域放大、点击、输入、按键、窗口列举与聚焦；危险动作接入审批策略。
- 记忆与上下文：长期/项目记忆入口、上下文预算与压缩状态。
- 插件治理：插件目录、能力说明、安装状态、受控启停与设置贡献。
- 插件信任：候选包审计、Ed25519 分离签名、本地信任库、版本/依赖/冲突检查，以及失败后事务回滚。
- 模型就绪度：把“已配置、凭据存在、目录可见、实时探测、当前会话选中”分开呈现；探测失败不会静默切换模型。
- 运行中心：统一投影前台轮次、后台任务、子代理、审批、排队输入和可用动作，并保留各运行时的原始来源标识。
- 编码工作台：限定工作区内的文件树、文本读取、Git 状态/差异、确认后写入、单次撤销和白名单脚本执行。
- 迁移与恢复：无密钥迁移包、逐文件哈希、路径重映射、冲突预检、一次性确认和可恢复导入日志。
- 完成验证：验证策略、完成凭证、心跳与运行状态。
- 多模型与工具：由 DSH 提供模型路由、工具、技能、子代理和会话连续性。
- 独立桌面壳：Electron 独立窗口、单实例、托盘、服务所有权；自动更新默认关闭。
- 专用浏览器：会话内标签页、独立登录、正文/元素读取、网页输入/点击/按键/滚动与页面截图；暂停和人工接管，网页操作不调用系统鼠标键盘。

核心产品插件位于 `packages/`：

| 插件 | 作用 |
| --- | --- |
| `product-bundle` | 组合小蛇当前正式产品能力 |
| `native-shell-legacy-adapted` | 小蛇正式界面与交互层 |
| `runtime-dsh-provider` | 把 DSH 会话、模型和审批状态提供给产品壳 |
| `memory` | 记忆读写和界面贡献 |
| `plugin-governance` | 插件目录、状态与治理 |
| `provider-readiness` | 模型服务商五态就绪事实与受控实时探测 |
| `coding-workbench` | 工作区限定的读取、Git、确认写入与脚本执行 |
| `migration-recovery` | 跨设备导出、预检、映射和恢复事务 |
| `task-timeline` | 任务时间线和运行轨迹 |
| `completion-receipt` | 完成凭证 |
| `verification-policy` | 完成前验证策略 |
| `heartbeat` | 运行心跳与健康状态 |
| `terminal-client` | 终端客户端入口 |

独立窗口位于 `apps/desktop-shell/`。它承载产品页面、本地服务生命周期和专用浏览器，不复制会话、记忆或插件状态；这些事实仍由对应插件与 DSH 保存。

小蛇默认允许联网，不提供跨会话永久生效的“禁止搜索/禁止联网”总开关；只有用户在当前任务明确要求离线时才临时停用，新任务开始或用户明确取消限制后立即恢复联网。

## 环境要求

- Node.js 22.23+ 或 24.17+（仅支持这两条 LTS 线，推荐 Node 24 LTS；代理凭据安全门禁与安装、启动检查一致）
- Git
- Python 3.10+
- Windows PowerShell 5.1（系统自带）；建议安装 PowerShell 7 以获得更完整的 UIA 元素结果
- Windows 10/11，或 macOS 13 及以上
- 当前正式桌面安装包的发行验收范围为 Windows x64 与 macOS arm64（Apple Silicon）
- macOS 自动补装 Node 时需要 Homebrew

安装器会在用户目录中配置项目专用的 pnpm 11.7.0，不会把 API Key 写入仓库。

## Windows 安装与启动

```powershell
git clone https://github.com/jackygilbert498-debug/xiaoshe-agent.git
cd xiaoshe-agent
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup\install-windows.ps1
```

安装后重开终端：输入 `s` 启动终端版，输入 `ss` 启动原生桌面版。也可以双击 `启动小蛇-Windows.cmd` 进入桌面窗口；只读诊断使用 `xiaoshe-doctor`，停止可双击 `停止小蛇-Windows.cmd`。两个入口共享同一套 DSH 会话、记忆、模型与插件状态。

源码环境也可以运行 `pnpm --filter '@xiaoshe/desktop-shell' start`。构建 Windows 安装包：

```powershell
pnpm.cmd --filter '@xiaoshe/desktop-shell' pack
```

`pack` 完成 NSIS 构建后会自动验证 `win-unpacked`、安装器与当前干净源码，并在 `dist-desktop/release-manifest.json` 写入材料哈希；不需要再手工拼接 verifier 参数。源码不干净、产物不一致或清单写入失败时，构建命令会返回非零，不能进入正式验收。

## macOS 安装与启动

```bash
git clone https://github.com/jackygilbert498-debug/xiaoshe-agent.git
cd xiaoshe-agent
bash ./setup/install-macos.sh
```

安装后双击 `启动小蛇.command`，或重开终端输入 `ss`。终端版使用 `s`，停止可双击 `停止小蛇.command`。

通过 DMG 安装的 `小蛇.app` 会在首次启动时把只读应用资源原子化物化到版本隔离的用户数据目录，再在那里安装锁定依赖并装配 Profile。该嵌入式安装路径不会要求开发版 `.command` 文件，也不会修改用户的 `.zshrc`；后续仍从已安装的 `小蛇.app` 启动。

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

再构建独立桌面目录或安装包：

```bash
pnpm --filter '@xiaoshe/desktop-shell' pack:dir
# 正式安装包（按当前平台生成）
pnpm --filter '@xiaoshe/desktop-shell' pack
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
  "$PWD/packages/project-knowledge" \
  "$PWD/packages/plugin-governance" \
  "$PWD/packages/provider-readiness" \
  "$PWD/packages/migration-recovery" \
  "$PWD/packages/agent-experience" \
  "$PWD/packages/coding-workbench" \
  "$PWD/packages/task-timeline" \
  "$PWD/runtime/DSH/packages/session-query/tool-session-query" \
  "$PWD/runtime/DSH/packages/web/web-fetch-http" \
  "$PWD/packages/product-bundle"
node ./scripts/ensure-profile-patch.mjs \
  --target "${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml" \
  --template ./setup/profile/cordis.patch.yml
node ./scripts/patch-modlens-runtime.mjs \
  --profile-root "${DSH_HOME:-$HOME/.dsh}/profiles/web"
pnpm --dir runtime/DSH dsh web --dump-config
```

## Agent 任务执行与读图

产品层提供两个只读的执行辅助工具：`xiaoshe_runtime_info` 查询当前会话的真实模型路由、工具目录、本轮执行摘要、待验证动作和有界工具经验；`xiaoshe_capability_plan` 根据当前目标，从该会话实际可见的工具 schema 中返回少量候选路线、净化后的必填参数、任务复杂度与自适应执行阶段。简单任务保持直接；复杂任务可形成 `understand / research / discover / act / verify` 路线。两者都不执行业务工具、不联网、不读取密钥；候选只代表“已注册”，历史成功只代表本会话曾经用通，都不等于后端当前健康或已经获得权限。

每轮直接用户任务会生成一份可替换的运行时路线快照，帮助模型优先选择适合当前任务的能力。路线推荐、历史成功或失败不是执行权限：简单任务可以直接完成，复杂任务可先收集证据、组织依赖、执行后验收；不会只因没有先写清单而禁止低风险操作。必要提问、正常轮询、修正输入和使用已有备用工具仍然可用。用户提供的本地参考可以作为证据，不为形式重复联网。

不按失败次数禁用整个工具或能力族。真实审批、路径隔离、用户明确禁止和危险操作边界仍生效；对于发送、提交等结果不明的外部操作，保留精确到该次调用的重复保护，允许先查询结果，不能用另一条旧查询替它解除保护。工具执行成功不等于任务验收通过，完成声明仍须有对应的回读、测试或可观察结果。

复杂任务可使用 Loop + Graph：沿用既有 Goal 续轮机制，任务图记录依赖、尝试、反馈和验收依据，不增加另一套调度器，也不强制所有任务建图。桌面右侧“任务”和终端 `:tasks` 读取同一状态；中断或记录未保存时保留等待检查状态，图记账失败不封禁普通业务工具。详情见 [Loop + Graph 交付与验收](docs/loop-graph-delivery-2026-09-20.md)。

复杂任务的模型级回归可运行 `npm run test:agent:complex-live`。它会在系统临时目录创建隔离夹具，覆盖代码修复、冲突研究、失败换路、用户改向，以及同一会话从明确离线任务切换到默认联网的新主题；同时核对真实工具结果、允许写入范围、独立测试、canonical verification 链与 completion receipt。脚本只保留 `output/acceptance/harness-performance-complex-*` 报告，不修改产品源文件；任一证据链缺失都会返回非零，不能把局部 smoke 或文字声明当成通过。

运行复杂 live 验收前，必须先完成当前检出的冷构建，并由使用者自行从这个检出的 `runtime/DSH` 启动或重启 `127.0.0.1:3080` 服务；验收脚本不会停止、重启或替换正在运行的用户服务。脚本会先用 `host.describe` 拒绝其他检出的运行目录，并要求每个场景返回 completion receipt v2，代码场景还必须满足当前 canonical verification 事件契约。当前 Host API 尚未暴露已加载代码的构建哈希，因此同一目录内重新构建后仍须手动重启，不能把仅通过目录和契约检查理解成逐字节进程指纹。

安装器对锁定的 ModLens 3.22.0 应用可重跑补丁：图片按用户问题提取相关证据，只有明确要求时才做全文转录；文件路径与粘贴图片共用限时、缓存和取消清理。默认整次读图限时 60 秒，含底层后端回退；进程清理最多再需要短暂宽限。Codex 视觉子进程使用单次低推理预算，不修改用户的全局模型、账号或设置。升级 ModLens 版本时必须先更新锚点与测试，未知版本拒绝自动打补丁。

完成前面的冷构建和 Profile 安装后，可运行不访问模型服务的回归：

```bash
pnpm run test:agent
pnpm run test:agent:integration
pnpm --filter '@xiaoshe/desktop-shell' test
```

集成测试使用真实 DSH 工具注册、请求与提示组装，以及本机锁定的 ModLens 模块；其中视觉后端用测试进程替代，不等于真实模型读图通过。`test:agent:live` 则调用正在运行的 `127.0.0.1:3080` 小蛇与当前模型，会产生真实模型用量、创建专用测试会话和 `output/acceptance/` 下的测试文件，但不会切换或保存用户的默认模型。复现读图案例需要额外传入“底部模型选择器显示 DeepSeek–V4–Pro”的截图路径；缺失时报告 `not_run`，真实视觉 provider 未配置或当前聊天模型不接收图片时报告 `pending_external`，两者都不能判为读图通过。

## 专用浏览器：不抢电脑

打开小蛇桌面版，把网页链接和目标发给小蛇。它使用 `browser_*` 工具在自己的浏览器里操作，当前会话的网页自动出现在右侧“浏览器”面板。收起面板不等于停止任务；要停止网页操作请点“暂停”。

首次登录网站：点“我来接管”，在面板内手动登录，完成后点“交给小蛇”，再在对话里让它继续。接管期间 Agent 不能读页面、输入、点击，也不能另开标签绕过；交回只是恢复工具使用权，不自动重放先前的提交。登录 Cookie 和站点本地存储保存在独立持久分区，不复制 Safari/Chrome/Edge 登录信息，不把密码或验证码交给模型。关闭或重启应用后需重新打开任务网页，登录是否仍有效也受网站自身策略影响。

默认“真实桌面：禁止自动操作”。只有用户在面板中确认“允许 10 分钟”，本会话才可调用真实桌面动作，原有审批仍生效，可随时收回。专用浏览器断线、超时、页面失败都不会自动改用系统浏览器。这里只隔离网页操作，不是完整虚拟机；原生桌面软件仍需明确桌面授权。命令行的常见桌面绕行也会被拦截，但这不是对任意、不受限本机代码的安全沙箱。

实现边界：远程页面使用无 Node/preload 权限的 Electron WebContentsView；工具经带随机认证、限长、限时和取消传播的本机私有通道连接。页面只能读自己的网页内容，不能打开小蛇控制源；网站内容属于不可信数据。标签归属按 DSH 会话强制检查。专用登录分区由当前本地使用者共享，会话标签隔离不等于不同人/账号之间的隔离。最多 12 个标签、每会话 6 个；元素快照限时 45 秒，变更后应重新读取。截图位于桌面应用用户数据目录的 `browser-artifacts/`，为私有文件；每次运行最多生成 100 张，不自动删除既有证据。

当前支持 HTTPS 和明确指定的本机 HTTP 工具。自动下载、文件选择、密码/验证码输入、系统协议跳转及摄像头/麦克风权限均不会由 Agent 自动完成。跨域内嵌页面、封闭组件和纯画布页面可能需要视觉补充或人工接管；不能据此宣称所有网站流程已验证。飞书等真实账号登录应由用户完成，再验证具体文档任务。

可重复验收（先完成构建；使用临时数据，不读取真实账号）：

```bash
pnpm run test:browser
pnpm --filter '@xiaoshe/desktop-shell' test
pnpm --filter '@xiaoshe/desktop-shell' exec electron test/run-browser-acceptance.mjs
# 用同一输出目录再启动一次，确认登录存储真正跨进程保留
XIAOSHE_BROWSER_STORAGE_PROBE=1 pnpm --filter '@xiaoshe/desktop-shell' exec electron test/run-browser-acceptance.mjs
```

真实产品界面与模型端到端验收入口为桌面应用的 `--acceptance-browser`，必须同时显式设置 `XIAOSHE_DESKTOP_ACCEPTANCE=1` 和绝对路径 `XIAOSHE_BROWSER_ACCEPTANCE_OUTPUT`；设置 `XIAOSHE_BROWSER_LIVE_AGENT=1` 才会调用当前模型（产生模型用量）。验收只创建自己的本机网页和测试会话，结束后归档测试会话。普通启动不会运行验收。

## 目录

```text
packages/                 小蛇产品插件
apps/desktop-shell/       独立桌面窗口与安装包配置
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
- 编码工作台只接受工作区 ID 与相对路径；写入需要与预检内容绑定的一次性确认，脚本只能来自固定白名单。
- 插件候选在确认前保持惰性；签名、兼容性、依赖和冲突检查不通过时不会进入 Profile。

## 内部候选版本检查

开发改动可运行 `npm run verify:internal`：按依赖顺序重新构建 DSH 和产品插件，检查类型、单元/集成测试以及实际 Electron 界面旅程。需要已安装锁定依赖和产品 Git 检出；Windows 还需要可用的 Python 3（可用 `XIAOSHE_QUALITY_PYTHON` 指定解释器），通过系统 Job Object 保证测试子进程树清理。该命令不会自动安装依赖、清理 node_modules、修改 `s`/`ss` 或操作正在使用的服务。

报告位于 `output/maturity/candidate-*/report.json`，绑定实际源码（包括未提交的修改和新文件）的前后 SHA-256，逐项记录退出码、耗时和未执行项目。报告不保存子进程正文，避免测试意外输出个人内容或密钥。失败、超时、缺项或验收期间源文件变化均不会通过。只完成确定性测试时状态为 `partial`，不代表模型能力或正式发行已验收。

真实模型检查需先为当前构建启动**隔离配置与会话存储**的独立实例，显式设置 `XIAOSHE_ACCEPTANCE_BASE_URL`（HTTP loopback origin）和 `XIAOSHE_ACCEPTANCE_PROFILE_ROOT`（绝对 Profile 路径），再运行 `npm run verify:internal:live`。它在确定性检查之后执行两遍固定复杂任务，会产生模型用量；开始和结束都核对正在运行实例的启动内容身份与当前构建/Profile，旧实例必须先由启动者重启。任何场景或清理失败、报告缺失，都不算通过。该门禁不会替你重启日常实例。

此门禁用于内部候选回归，不代替安装包验收、签名、macOS 实机验收，也不是与其他 Agent 的性能对比分数。

## 验收边界

Windows x64 正式验收必须同时运行报告生成器和验证器；缺少当前安装包、签名或真实安装/卸载时会返回非零，不会把诊断性结果当作通过：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/acceptance/windows-desktop.ps1
node scripts/acceptance/verify-report.mjs artifacts/acceptance/windows-desktop.json
```

只想收集未完成项时可显式传入 `-AllowPendingExternal`；报告仍标记为 `INCOMPLETE`，不等于发行通过。

macOS 在目标设备执行下列总门；它会从当前源码构建 arm64 DMG，再验证屏幕录制、辅助功能、真实点击与键盘输入、打包应用生命周期、单实例、安装、卸载和用户数据保留策略：

```bash
bash scripts/acceptance/macos-desktop.sh
node scripts/acceptance/verify-report.mjs artifacts/acceptance/macos-desktop.json
```

总门启动时会先失效上一轮聚合与组件报告；本轮所有报告共享唯一 run-id 和开始时间。最终验证还会要求干净源码记录的 DMG SHA-256 与本轮实际安装的 DMG SHA-256 完全一致，因此中途失败、跨轮组件或签名前旧产物都不能复用为 PASS。

没有 Developer ID 或 Apple 公证凭据时，其他真机检查仍会继续，签名公证项只会登记为 `pending_external`，不会伪报通过。发布者准备好证书后，先把有效的 `Developer ID Application` 证书及私钥导入钥匙串，再用下列命令交互式保存公证凭据；不要把 app-specific password 写进命令或仓库：

```bash
xcrun notarytool store-credentials xiaoshe-notary --apple-id "<Apple ID>" --team-id "<Team ID>"
XIAOSHE_NOTARY_PROFILE=xiaoshe-notary bash scripts/release/sign-notarize-macos.sh
```

发布门会重新构建应用、Developer ID 签名、提交 Apple 公证、装订票据、生成并签名 DMG，然后用 `codesign`、`stapler`、`spctl` 和只读挂载后的内置应用复核结果。其他平台生成的 macOS 报告会保留真实外部待验状态。

## 许可

根产品代码当前标记为 `UNLICENSED`，公开可见不等于授予复制、修改或再分发许可。`runtime/DSH` 保留其目录内的 MIT License 与第三方声明；该许可证不自动覆盖仓库其他目录。
