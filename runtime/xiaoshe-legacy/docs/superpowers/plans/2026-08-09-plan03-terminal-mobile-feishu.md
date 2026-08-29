# Plan 03 — 终端 S、手机 PWA、飞书机器人与本机模型配置

> 依赖 Plan 01、Plan 02 完成。每个代码 Task 遵循 RED → GREEN → 自审 → 独立审查 → 精确提交；文档 Task 做来源核对和逐项可执行性审查。

**Goal:** 让当前 Windows 机器可从任意终端唤醒小蛇，交付可直接继续开发的手机/飞书方案，并验证 DeepSeek 与保留的 Kimi 均可被本机模型注册表选择。

**Design:** `docs/superpowers/specs/2026-08-09-runtime-controls-product-integration-design.md`

## Global Constraints

- `S` 必须在 cmd、PowerShell 中都可解析，不依赖 profile，不修改 PowerShell 执行策略。
- 安装为当前用户，不要求管理员；参数原样转发；仓库路径可含中文和空格。
- 手机首版不公开暴露 `0.0.0.0`、LAN 或 Funnel；使用私有 HTTPS 与逐设备配对。
- 飞书首版使用企业自建应用机器人长连接，不要求公网回调；凭据只留本机/受控后端。
- Kimi 不删除、不覆盖；额度不足只能由真实调用返回，不能因配置层判断而隐藏。
- 密钥不回显、不进入 Git；本机证据只记录 configured 布尔值和来源类别。

## Task 1 — 可安装、可验证的 `S` 终端命令

**Files:**
- Create: `scripts/install_s_command.ps1`
- Modify: `install.ps1`
- Create: `tests/test_s_command_installer.py`
- Modify: `README.md` and/or `docs/GUIDE.md` with exact usage

1. RED：在临时 bin 目录安装，验证生成 `S.cmd`、中文/空格仓库路径、幂等更新和 `%*` 参数转发；缺少 `run.py` 明确失败。
2. GREEN：安装到 `%LOCALAPPDATA%\Microsoft\WindowsApps\S.cmd`，使用 `py -3` 和绝对 repo 路径；shim 必须显式禁用 delayed expansion，调用结束后恢复原 cmd 代码页并保留真实退出码；不读取/修改 `$PROFILE` 或 ExecutionPolicy。
3. 在本机执行安装器，`where.exe S`、`S --help`、重定向 `:exit` 的无模型交互启动均成功。
4. 独立审查与提交；安装出来的用户级 shim 不进入 Git。

## Task 2 — 手机 PWA 接入方案

**Files:**
- Create: `docs/integrations/mobile-pwa.md`

1. 写清 MVP 架构：现有 Web UI 响应式 PWA、Tailscale Serve 私有 HTTPS、MagicDNS/HTTPS 与手机加入同一 tailnet 的前置流程、证书域名进入公开 CT 日志的元数据风险、精确 HTTPS/WSS Origin、一次性 URL fragment 二维码换取 HttpOnly/Secure/SameSite 会话、设备撤销和过期。撤销只保证服务端立即失效与在线断连，不得承诺远程擦除离线设备数据。
2. 写清离线/推送边界：只缓存静态 UI 与脱敏只读快照；执行任务和审批要求桌面在线；iOS 推送需要加入主屏幕和用户手势授权。
3. 给出 Windows 实施命令、配置字段、威胁模型、阶段拆分、验收清单和回滚步骤，并逐条链接官方来源；二维码必须使用仓库内固定依赖渲染，且验收 fragment 在返回、刷新、历史和交换失败路径中都被清除且不可复用。
4. 来源与可执行性独立审查后提交。

## Task 3 — 飞书机器人接入方案

**Files:**
- Create: `docs/integrations/feishu-bot.md`

1. 写清 MVP：企业自建应用 + 应用机器人 + SDK 长连接；只需出网，不开放公网端口。
2. 写清消息、`im.message.receive_v1`、interactive card、`card.action.trigger`、3 秒确认后异步处理、`message_id`/`client_token` 幂等和 Task v2。出站幂等键必须按 send/reply/update-card 端点分别生成且满足官方长度上限；卡片 `action_token` 必须独立原子消费，任务和动作只从服务端 binding 读取，不能信任卡片 value，也不能与 `event_id` 组合后绕过一次性语义；联网开关关闭时必须主动断开现有 WebSocket 并停止重连，并用可审计的 online permit/epoch 线性化在途 Task 提交与 OpenAPI 请求：关闭需等待可取消请求收口，对不可确认结果记为 uncertain，禁止关闭后迟到提交或发送。
3. 区分群自定义 Webhook、应用身份和用户 OAuth；原生审批列入二期；App Secret/token 不进入桌面安装包或 Git。
4. 给出飞书后台配置、最小权限、Windows 服务流程、验收/故障排查和官方来源；冻结 inbox/outbox/dedupe/dead-letter 的留存 TTL；计划任务或服务必须显式绑定与 DPAPI 凭据相同的 Windows 用户 SID/principal；独立审查后提交。

## Task 4 — DeepSeek/Kimi 本机配置验收

**Tracked files:**
- Modify: `harness/config.py`
- Modify: `harness/kimi_client.py`
- Modify: `harness/curl_transport.py`
- Modify: `harness/model_registry.py`
- Modify: `harness/model_transport.py`
- Modify: `harness/model_client.py`
- Create: `tests/test_provider_delivery_closure.py`

只允许提交 DeepSeek/Kimi provider 在 clean HEAD 中可复现所需的最小 hunk；必须排除 tasking、UI 标签和其他继承修改。

1. 从用户指定的本地文件导入时先验证它非空；不得输出内容。若文件为空，不得声称从该文件导入成功。
2. 将 DeepSeek 凭据保存到 Windows DPAPI 保护的 `.state/model_secrets.bin`；Kimi 原配置保持不变。
3. 用清空 process env / env-file 的 registry 实例验证 DeepSeek 可仅凭 secret store 解析；常规实例验证 Kimi、DeepSeek Flash、DeepSeek Pro 都 `configured=true`。
4. 验证 `.state/model_secrets.bin` 被 Git 忽略，`git diff --cached` 无任何密钥或状态文件。
5. RED→GREEN：新增无真实密钥的交付闭包测试；在 clean HEAD 上先证明缺少 provider hunk 时失败，再精确加入 `config.py`、`kimi_client.py`、`curl_transport.py` 的最小闭包并验证通过。不得夹带模型管理 UI 或其他工作树修改。
6. 选中的服务商缺少凭据时必须保持当前选择并以稳定的 `missing_credential` / `MODEL_SECRET_MISSING` 失败；即使另一服务商有凭据，也禁止静默跨服务商回退或发送请求。
7. `ModelRegistry` 必须在真实 UI/`ModelClient` 注册链过滤其他已知服务商前缀；例如 DeepSeek 下的 `XS_MODELS` 不得注册 `kimi-*`，Kimi 下同理不得注册 `deepseek-*`。
8. 从真实 curl HTTP response/stream 开始保留净化后的状态分类：实际 HTTP 状态必须经独立元数据通道取得，不能假设 JSON body 自带 `status`；429 或 `insufficient_balance`/额度错误映射 `quota_limited`，401/403 或认证错误映射稳定认证类别，未知传输错误才映射 `network_error`。非 2xx 即使没有标准 `error` envelope 也必须按净化后的 HTTP 状态失败；不得把状态标记混入 JSON/SSE 正文，也不得回显上游原始错误、凭据或响应体。
9. 旧 `kimi_client.chat(..., model=...)` 的普通与流式入口必须把显式请求模型传给缺省响应解析；上游响应省略 `model` 时，Pro 不得被误报为默认 Flash。以上四条都先补 RED 回归，再做最小 GREEN 修复并独立复审。
10. HTTP 状态回归必须启动本机 `127.0.0.1` 测试服务并让真实 curl 完成非流与流式请求；至少覆盖 HTTP 429 + body 仅含 `insufficient_balance`（无 `status`），并证明两条路径都得到 `quota_limited`、状态为 429、正文/标记不泄漏。只在 body 注入 `status=429` 的 mock 不计作此项验收。
11. stderr 状态解析器只能信任并移除绝对末尾、格式完整且在 100–599 范围内的私有状态行；更早出现的同名文本、重复/非法状态行和其他真实 stderr 必须原样保留，不能影响末尾真实状态，也不能被全局替换吞掉。用“早期伪 marker + 末尾合法 marker”“只有早期 marker”“末尾非法 marker”三类回归锁定该边界。

## Batch Acceptance

- 新开 cmd 与 PowerShell 都能用 `S` 唤醒终端版小蛇并正常退出。
- 两份接入方案由另一位审查者逐项确认可执行、安全边界明确、官方链接有效。
- 模型列表仍有 Kimi、DeepSeek Flash、DeepSeek Pro；密钥错误/额度错误只在真实调用时如实显示。
