# 小蛇手机 PWA 私网接入实施方案

> Plan 11 实现状态（2026-08-16）：本地 PWA 的静态 manifest、Service Worker、
> 最小离线 intent 队列和 `InboxAdapter` 安全边界已经落地。当前代码只把意图
> 持久化为 `accepted/duplicate` receipt，不直接运行工具；真正执行仍必须经过
> RuntimeSession、PlanGate、Permission 和 Verification。桌面 Chromium 可做本地
> 安装与离线壳验证；真实手机、Tailscale HTTPS、设备配对、远程撤销和真实网络
> 走查仍是外部验收项，未执行时必须记录 `not_run/hold`。

## Plan 11 本地优先契约

- 页面只加载同源 `/manifest.webmanifest` 和 `/service-worker.js`；Service Worker
  的缓存白名单只有 manifest 与现有 256/512 图标，不缓存 `/`、`index.html`、
  `/api`、WebSocket、会话、模型配置、凭据或用户正文。
- 断网导航显示由 Service Worker 即时生成的只读离线说明，响应为 `503` 和
  `Cache-Control: no-store`；它不是任务执行页面。
- 离线队列只接受 `client_id/project_id/title/goal/acceptance`，上限 50 条、合计
  64 KiB。cookie、bearer/CSRF、模型 endpoint、工具命令和附件正文不会进入队列。
- 重新联网时 Service Worker 只通知一个当前受控页面向
  `/api/v2/inbox/intents` 刷新；页面必须在有效身份、精确 Origin/Host、
  `Sec-Fetch-Site: same-origin`、CSRF 和五分钟请求 nonce 下调用适配器。
- 服务端以 `(identity_id, idempotency_key)` 和规范化内容指纹原子去重。相同内容
  返回同一 receipt 并标记 duplicate；相同 key 不同内容拒绝为
  `INBOX_IDEMPOTENCY_CONFLICT`。并发和进程重启语义相同。
- 附件只允许有限 MIME、10 MB/个、最多 8 个的 opaque `att_...` 引用，并且必须
  由调用方授权函数确认该引用属于当前 identity 和 project；本地路径与 URL 均拒绝。
- 登出会清空离线 intent/receipt 数据与本应用缓存。离线文本后续渲染必须使用
  `textContent`；不得以 HTML 注入 DOM。

下面的 Tailscale/设备配对章节仍是下一阶段外部接入设计，不代表本机已经配置或
真实手机已经验收。

> 状态：私网发布与设备配对设计完成，尚未实现。最后核对：2026-08-16。
> MVP 决策：复用现有响应式 Web UI，以 Tailscale Serve 把仍然只监听 `127.0.0.1` 的服务发布为 tailnet 内私有 HTTPS；不监听 `0.0.0.0`，不开放 LAN，不使用 Tailscale Funnel。
> “私网”只描述连接授权和应用内容；启用 Tailscale HTTPS 取得证书后，Windows 机器 FQDN 中的机器名与 tailnet DNS 名会进入公开、追加式的 Certificate Transparency（CT）日志，不能把这个名称当秘密。

## 1. 结论与不可破坏的边界

手机接入不是“把现有本地 URL 换成公网 URL”。当前实现的 `harness/ui_server.py` 只接受本机 `Host`/HTTP `Origin`，前端还会把本地配对 token 放入 `sessionStorage`、WebSocket 子协议和图片查询串。因此，在第 7 节的第一、二阶段完成前，**不得执行 Tailscale Serve 发布命令**。

实施后的固定链路是：

```text
iPhone / Android PWA
  https://xiaoshe-host.<tailnet>.ts.net
              │ HTTPS / WSS（仅 tailnet）
              ▼
      Tailscale Serve :443
              │ 仅反代回环 HTTP
              ▼
  http://127.0.0.1:7788
              │
              ▼
       小蛇现有 UI / Task v2
```

以下约束必须由代码和验收共同锁死：

1. 小蛇仍只绑定 `127.0.0.1:7788`；不新增 `--host`，不加 Windows 防火墙入站规则，不直接监听 Tailscale IP 或 LAN IP。
2. 只运行 `tailscale serve`，绝不运行 `tailscale funnel`。Serve 面向 tailnet；Funnel 才会把服务开放给互联网，[Tailscale 官方明确区分两者](https://tailscale.com/docs/features/tailscale-funnel/how-to/host-websites)。
3. 外部唯一浏览器源为精确值 `https://xiaoshe-host.<tailnet>.ts.net`；不接受 `*.ts.net`、正则后缀、HTTP、裸 IP、额外端口、`Origin: null`。
4. WebSocket 目标固定为 `wss://xiaoshe-host.<tailnet>.ts.net/ws`，握手中的浏览器 `Origin` 仍必须精确等于上述 **HTTPS Origin**。RFC 6455 要求浏览器发送 Origin，并允许服务端以 403 拒绝不可信源，[见 RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html#section-10.2)。
5. 手机端不复用或暴露 `.state/ui_token`；现有本机 bearer/query-token 流程只留给 `127.0.0.1`/`localhost`。
6. 手机凭据只进入浏览器受保护的 Cookie jar；JavaScript、URL 查询串、`localStorage`、`sessionStorage`、Cache Storage、IndexedDB、日志和 Git 中都不得出现会话 token 或密钥。
7. 离线态绝不执行任务、发送消息或审批。执行与审批只在桌面服务在线、WSS 已连接且设备会话具备相应 scope 时开放；既有权限、人工审批、效果账本和 Task v2 检查仍全部生效。

## 2. 官方来源矩阵

下表链接已在 2026-08-09 逐项打开核对。这里只采用产品官方、标准组织或规范型资料，不用博客摘要替代安全结论。

| 决策/事实 | 官方依据 | 落地含义 |
|---|---|---|
| Serve 只在 tailnet 内分享；Funnel 才公开互联网 | [Tailscale：Host a website](https://tailscale.com/docs/features/tailscale-funnel/how-to/host-websites)、[Funnel](https://tailscale.com/docs/features/tailscale-funnel) | MVP 只用 Serve，检查配置中不存在 Funnel |
| 当前 Serve CLI、`--bg`、`--https`、状态和关闭语法 | [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve) | 使用第 4 节命令；不要沿用 1.52 以前的旧语法 |
| Serve HTTPS 由 Tailscale 终止 TLS；反代目标只支持 `http://127.0.0.1` | [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve#use-https-and-http-servers) | 后端保持回环 HTTP，外部得到受信 HTTPS/WSS |
| Serve 依赖 tailnet HTTPS；未启用时 CLI 会引导有权限的用户完成同意 | [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) | 由 Owner/Admin 在发布前显式完成 DNS、HTTPS 和披露决策，不依赖运行时临时点击 |
| MagicDNS 提供机器 FQDN；HTTPS 证书会把机器名与 tailnet DNS 名写入公开 CT 日志 | [Tailscale MagicDNS](https://tailscale.com/docs/features/magicdns)、[Tailscale HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates) | 发证前先清理敏感机器名并获得管理员接受；拒绝披露就不启用本方案 |
| 关闭 HTTPS 是 tailnet 级操作，且既有证书不会因此吊销，不能只吊销单台机器证书 | [Tailscale HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates#disable-https) | 回滚先关本机 Serve/Grant；不得承诺删除 CT 记录或用“关 HTTPS”做无影响的单机回滚 |
| Grants 为并集，窄规则不会覆盖已有宽规则 | [Tailscale Grants syntax](https://tailscale.com/docs/reference/syntax/grants) | 必须删除/收窄已有 `* → *`；仅新增窄 grant 不算完成 |
| 策略可写 accept/deny 回归测试 | [Tailscale policy file tests](https://tailscale.com/docs/reference/syntax/policy-file#tests) | 保存策略前证明授权用户能访问、其他成员不能访问 443 |
| 手机必须安装 Tailscale、完成 VPN 配置并登录同一 tailnet | [Tailscale iOS](https://tailscale.com/docs/install/ios)、[Tailscale Android](https://tailscale.com/docs/install/android)、[添加设备](https://tailscale.com/docs/features/access-control/device-management/how-to/set-up) | 手机连接 tailnet 并在 Machines 页确认正确用户/批准状态后，才扫描小蛇 QR |
| 从 tailnet 删除丢失手机会使它立即失去 tailnet 资源连接 | [Tailscale：Remove a device](https://tailscale.com/kb/1260/device-remove) | 丢机同时撤销小蛇设备会话和 Tailscale 设备；这仍不等于远程擦除浏览器离线数据 |
| PWA 生产环境与 Service Worker 需要 HTTPS；manifest 与静态资源可本地缓存 | [Microsoft Edge PWA](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/) | Tailscale HTTPS 是 PWA 安全上下文；只预缓存版本化 UI |
| URL fragment 不随初始 HTTP 请求发给服务端 | [MDN：URI fragment](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment) | 二维码原始一次性码只放 `#pair=...`，首屏脚本立即擦除后再 POST 交换 |
| QR 渲染器使用固定上游版本与许可证 | [`qrcode-generator` 官方 `js1.4.4` release](https://github.com/kazuhikoarase/qrcode-generator/releases/tag/js1.4.4)、[MIT LICENSE](https://raw.githubusercontent.com/kazuhikoarase/qrcode-generator/js1.4.4/LICENSE) | 实现时 vendor 到仓库并以 SHA-256 锁定；运行时零 CDN/零第三方请求 |
| 32 字节随机量适合典型安全 token | [Python `secrets`](https://docs.python.org/3/library/secrets.html#how-many-bytes-should-tokens-use) | 配对码和会话 ID 用 `secrets.token_urlsafe(32)`，不用 `random` |
| `__Host-`、Secure、HttpOnly、SameSite 的约束 | [MDN：Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#cookie_prefixes)、[安全 Cookie 配置](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Cookies) | 手机会话使用 host-only Cookie，不设 Domain，Path 固定 `/` |
| Fetch Metadata 可区分 same-origin/cross-site | [MDN：Sec-Fetch-Site](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site) | 跨站写请求直接 403；缺失时仍按精确 Origin 和 CSRF nonce 失败关闭 |
| `no-store` 才是不存储响应；旧缓存还需主动清理 | [MDN：HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching#dont_cache) | API/配对/审批返回 `private, no-store`；撤销时另行清 Cache/IDB |
| iOS/iPadOS Web Push 需要主屏幕 Web App，授权必须由直接用户手势触发 | [WebKit：iOS/iPadOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) | 推送后置；只能在用户点击“开启通知”时请求权限 |

## 3. MVP 架构与身份边界

### 3.1 两套身份通道必须隔离

本机访问继续使用现有短生命周期 UI token：

- `http://127.0.0.1:7788` / `http://localhost:7788`；
- REST `Authorization: Bearer ...`、WS `xs-token...` 和现有图片兼容路径；
- 不允许这个 token 出现在手机二维码中。

手机访问改用独立设备会话：

- 页面、REST、图片和 WSS 都是同一个精确 HTTPS Origin；
- 浏览器自动携带两个 `__Host-` Cookie，JS 永远读不到它们；
- 服务器端以设备记录绑定 session、scope、绝对过期、空闲过期和撤销状态；
- REST 写请求另需只保存在页面内存的短期 CSRF nonce；WSS 以精确 Origin + Cookie 鉴权。

建议 Cookie：

```http
Set-Cookie: __Host-xs-device=<128-bit opaque id>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800
Set-Cookie: __Host-xs-session=<256-bit opaque id>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800
```

服务端只保存 `SHA-256(session)`、`SHA-256(device id)`、设备显示名、scope、创建/最近使用/过期/撤销时间，不保存可直接使用的原值。MVP 的“设备绑定”是“两个 Cookie + 服务端设备记录必须同时匹配”，不是硬件证明；如果整份浏览器资料被盗，仍要依靠单设备撤销和过期止损，不能宣称具备硬件级绑定。

### 3.2 一次性二维码交换

1. 用户在**本机桌面 UI**点击“添加手机”，选择设备名与 scope。创建接口只接受本机 Host、本机 Origin、现有本机 token 和一次明确点击；手机会话不能生成新的配对码。
2. 后端用 `secrets.token_urlsafe(32)` 生成 256-bit 配对码，只保存哈希，默认 TTL 300 秒，并返回：

   ```text
   https://xiaoshe-host.<tailnet>.ts.net/#pair=<一次性高熵码>
   ```

3. QR 固定使用仓库内 vendored 的 [`qrcode-generator` `js1.4.4`](https://github.com/kazuhikoarase/qrcode-generator/releases/tag/js1.4.4)：文件落点为 `ui/vendor/qrcode-generator/1.4.4/qrcode.js`、同目录 `LICENSE` 与 `SHA256SUMS`。合并前从该 release 获取一次，记录**实际 vendored 字节**的 SHA-256；测试必须重新计算并与 `SHA256SUMS` 相等。`ui/js/mobile/qr-renderer.js` 只调用本地库并把矩阵绘入 `<canvas>`，禁止 `innerHTML`、第三方二维码网站、包管理器运行时下载或 CDN。该 vendor 文件与包装器进入版本化静态 allowlist，可离线渲染；CSP 保持 `default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:`，不得为 QR 增加外域。
4. `ui/js/mobile/pairing-bootstrap.js` 必须是 `<head>` 中第一个、无 `defer`/`async` 的同源脚本；它在任何主应用 import、fetch、Service Worker 注册或统计代码之前同步读取并校验 `location.hash`，只把码保存在闭包内存，随后立即执行 `history.replaceState(null, "", location.pathname + location.search)`。主应用只能通过一次性 `consume()` 取得码，取得后删除 getter；构造交换请求体后、`await fetch()` 前清空最后一个 JS 引用。原始码不得进入 DOM、全局变量、Storage、Cache、日志、错误对象或埋点。
5. 后端要求精确 Host/Origin、`Sec-Fetch-Site: same-origin`、JSON Content-Type，按哈希查找并在同一事务内执行“未使用 + 未过期 → 标记已使用 → 创建设备会话”。并发第二次交换必须得到相同的通用错误，不泄漏“存在但已用”之类枚举信息。
6. 成功响应只设置 Cookie 和返回脱敏设备信息；响应体不返回 session token。失败 5 次后对该配对记录锁定；另设全局滑动窗口限制，避免无法可靠识别反代后客户端时仍可暴力尝试。
7. 桌面可在 TTL 内主动取消未使用配对码；成功、失败、过期、取消都写脱敏审计事件。

配对页面和响应同时发送 `Referrer-Policy: no-referrer`。配对码放 fragment 可避免它进入**初始**请求行，但脚本随后仍必须经 HTTPS 主动提交给交换接口；浏览器扩展、扫码器历史、剪贴板、系统截图、相机照片或肩窥可能已经在清除前复制它，应用无法远程删除这些副本，只能依靠 5 分钟 TTL、单次使用、取消和限速止损。

历史与失败语义必须保守：`replaceState` 替换当前条目，刷新、前进或后退回到 PWA 时不得恢复 fragment 或自动重试；后退到相机/扫码器属于外部历史，应用不能承诺清除。无论交换得到 201、通用 4xx/5xx、超时，还是发生“请求可能已到服务端”的网络错误，手机都必须保持无 fragment、无本地副本且不自动重发，统一提示“从桌面生成新的二维码”。手工重放旧链接只能得到通用失败。

### 3.3 scope 与高风险操作

设备 scope 固定为：

- `read`：查看在线状态、会话和任务摘要；不能发送消息、运行/取消任务或审批；默认值。
- `operate`：包含 `read`，可发送消息、启动/取消任务、回答普通问题；仍经过既有权限与任务规则。
- `approve`：包含 `operate`，允许处理既有审批；配对时必须在桌面单独勾选，手机每次审批仍展示副作用摘要并要求显式确认。

服务端逐路由校验 scope，不能只靠前端隐藏按钮。离线时所有 scope 一律降为只读快照。

## 4. Windows 部署命令（代码落地后执行）

本机当前没有检测到 `tailscale.exe`，所以下列命令已按 2026-08-09 官方文档核对语法，但**没有伪称在本机运行成功**。安装、登录和 tailnet 管理均由设备所有者完成，不由小蛇静默执行。

### 4.1 管理员先作 CT 披露决策

Tailscale HTTPS 证书的公开 CT 日志会永久暴露用于证书的**机器名和 tailnet DNS 名**。它不公开应用内容，也不绕过 Tailscale 访问控制，但公开名称本身不可撤销。因此，Owner/Admin 必须在发证前完成以下门禁：

1. 在 Machines 页检查并按需重命名 Windows 主机，确保名称不含人名、客户名、项目代号、资产编号或位置等敏感信息；同时检查 DNS 页显示的 tailnet DNS 名。
2. 若接受这两个名称进入公开 CT 日志，在 DNS 页启用 MagicDNS 与 HTTPS，并完成官方披露确认；在交付记录中保存“接受的精确 FQDN、决策人、时间”，不保存账号凭据。
3. 若不接受披露，**停止此方案**：不启用 HTTPS、不运行 Serve，继续仅用 `http://127.0.0.1:7788` 的桌面版。不得改用 Funnel、LAN 暴露、自签名证书例外或忽略浏览器 TLS 警告来绕过。
4. 如果 tailnet 已启用 HTTPS，也仍需检查当前名称是否可公开。名称变更或接受记录与现有 FQDN 不匹配时，`S mobile configure` 必须失败关闭并要求重新确认。

官方还明确说明：关闭 HTTPS 是整个 tailnet 的操作，会破坏其他 HTTPS 链接；已经签发的证书不会因此被吊销，也不能只吊销某台机器的证书。故第 10 节默认回滚只关闭本机映射和访问授权，**不能承诺从 CT 日志抹除名称**。

### 4.2 Windows 与手机前置条件

Windows 设备所有者先安装官方 Tailscale 客户端、完成登录，并确认服务在线：

```powershell
Get-Command tailscale.exe
tailscale version
$xsTs = tailscale status --json | ConvertFrom-Json
$xsTs.BackendState
$xsTs.Self.Online
$xsDns = [string]$xsTs.Self.DNSName
$xsDns = $xsDns.TrimEnd('.')
if ($xsTs.BackendState -ne 'Running' -or -not $xsTs.Self.Online) { throw 'Windows Tailscale 尚未在线' }
if (-not $xsDns.EndsWith('.ts.net', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Self.DNSName 不是完整 ts.net FQDN' }
$xsOrigin = "https://$xsDns"
$xsOrigin
Resolve-DnsName $xsDns
```

验收：`$xsDns` 是当前 Windows 机器的完整 `*.ts.net` 名称，不是手机名称、短 MagicDNS 名称、IP 或 `localhost`；状态为 `Running`/online，MagicDNS 能解析该名称。这里的 DNS 成功还不代表 HTTPS 或 Grants 已正确。

手机由设备所有者完成，不能由桌面程序静默代办：

1. iPhone/iPad 从 App Store 安装 Tailscale（iOS/iPadOS 15 或更高），Android 从 Google Play/官方渠道安装（Android 8 或更高）。
2. 启动应用、允许安装 VPN 配置，通过计划授权的身份登录，并明确选择与 Windows **同一个 tailnet**。
3. 若启用了 device approval，Owner/Admin 在 Machines 页批准手机；在 Machines 页核对手机的设备名、所属用户、已连接/最近在线状态，不以“应用已安装”代替验收。
4. 保持手机 Tailscale 为 Connected。随后由这台手机执行第 4.5 节授权 HTTPS 测试；只有来自手机到 Windows 的真实连接结果才能证明方向正确。

### 4.3 先收窄 tailnet Grants

以下是需替换占位符的策略片段。`xiaoshe-host` 是 `hosts` 中指向小蛇主机 Tailscale IP 的别名；`group:xiaoshe-mobile` 只列真实允许访问的人：

```jsonc
{
  "groups": {
    "group:xiaoshe-mobile": ["owner@example.com"]
  },
  "hosts": {
    "xiaoshe-host": "100.64.0.10"
  },
  "grants": [
    {
      "src": ["group:xiaoshe-mobile"],
      "dst": ["xiaoshe-host"],
      "ip": ["tcp:443"]
    }
  ],
  "tests": [
    {
      "src": "owner@example.com",
      "proto": "tcp",
      "accept": ["xiaoshe-host:443"]
    },
    {
      "src": "untrusted-member@example.com",
      "proto": "tcp",
      "deny": ["xiaoshe-host:443"]
    }
  ]
}
```

这不是可直接覆盖整份 tailnet policy 的文件，只是需合并的最小片段。**必须先保存并通过 policy tests，才可运行 Serve。** 合并前审计并移除会覆盖目标主机 443 的宽规则，例如 `src:["*"] / dst:["*"] / ip:["*"]`。Tailscale Grants 取并集，更具体的规则不会抵消已有宽授权，[官方语义如此](https://tailscale.com/docs/reference/syntax/grants#core-concepts)。策略测试仍只是静态证明；第 4.5 节还要用授权与未授权真实身份分别验收。

### 4.4 配置小蛇，再启用 Serve

第 7 节实现后新增以下本机命令；它只写入被 Git 忽略的 `.state/mobile-access.json`，不保存 Tailscale 密钥：

```powershell
S mobile configure --origin $xsOrigin --ack-public-ct-name $xsDns --enable
S mobile status
S serve --port 7788 --no-browser
```

保持这个终端运行。在另一个 PowerShell 中：

```powershell
tailscale serve --bg --https=443 http://127.0.0.1:7788
tailscale serve status
tailscale serve status --json
```

此语法来自当前 [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)：`--bg` 使配置在后台持续，Tailscale 在 443 终止 HTTPS，并只反代回环 HTTP。不要改成 `--http`，不要把目标改成 `0.0.0.0`，不要运行 `tailscale funnel`。

### 4.5 DNS、HTTPS 与身份真机验收

Windows 先核对映射和 HTTPS，不把自签名忽略、HTTP 200 的本机地址或浏览器缓存当作成功：

```powershell
tailscale serve status
tailscale serve status --json
$xsResponse = Invoke-WebRequest -UseBasicParsing -Uri $xsOrigin -Method Get
$xsResponse.StatusCode
$xsResponse.BaseResponse.ResponseUri.AbsoluteUri
```

预期精确 HTTPS Origin 返回 PWA 壳且证书无浏览器警告；重定向后的 host 仍必须等于 `$xsDns`。然后完成两组真实测试：

- 授权手机：Tailscale Connected、Machines 页用户正确，可打开 `$xsOrigin`；未配对时只能看到无秘密配对壳，API 返回 401，配对后才按 scope 使用。
- 未授权身份：在独立 Tailscale 账号/设备上登录同一 tailnet但不属于 `group:xiaoshe-mobile`，连接 TCP/HTTPS 443 必须失败。不得只用退出 PWA、无 Cookie或应用 401 冒充网络拒绝。

若 DNS 失败，回到 MagicDNS/同一 tailnet/设备状态；若 TLS 失败，回到 HTTPS 与证书状态；若身份结果错误，先关闭 Serve，再修正 Grants。任何一步失败都不得临时开放 `*`、LAN 或 Funnel。

## 5. 本地配置契约

文件：`.state/mobile-access.json`；原子写入、当前用户可读写、Git 永久忽略。示例：

```json
{
  "version": 1,
  "enabled": false,
  "origin": "https://xiaoshe-host.tail1234.ts.net",
  "ct_disclosure_accepted_fqdn": "xiaoshe-host.tail1234.ts.net",
  "ct_disclosure_accepted_at": "2026-08-09T12:00:00Z",
  "pair_ttl_seconds": 300,
  "session_idle_ttl_seconds": 86400,
  "session_absolute_ttl_seconds": 604800,
  "csrf_ttl_seconds": 900,
  "offline_snapshot_ttl_seconds": 86400,
  "max_devices": 5,
  "default_scope": "read",
  "allowed_scopes": ["read", "operate", "approve"]
}
```

加载时失败关闭：

- `origin` 必须可解析为仅含 scheme + host 的 URL；scheme 必须是 `https`，主机必须是精确小写 FQDN，端口只能省略或为 443；拒绝用户名、路径、查询、fragment、通配符、尾点和 IDN 混淆形式。
- `ct_disclosure_accepted_fqdn` 必须与标准化后的 origin host 完全相等且时间有效；缺少、名称变化或不匹配时 `enabled` 必须失败关闭，CLI 重新展示 CT 披露并要求显式确认。
- 从同一个标准化 origin 派生 `expected_host`、REST Origin、`wss://.../ws` 和 CSP `connect-src`；不得分别手填造成漂移。
- `enabled=false` 或配置无效时，外部 Host/Origin 全部 421/403，本机流程不受影响。
- 后端只信任配置中的公开 origin，不信任客户端提交的 Host、`X-Forwarded-Host` 或 `X-Forwarded-Proto` 来动态扩大白名单。
- 会话记录放 `.state/mobile-sessions.sqlite3`，只存 token/device 哈希和脱敏元数据；配对码、Cookie 原值、CSRF 原值不得落盘。

## 6. API 与浏览器契约草案

所有 API 错误使用稳定 `code`，不回显 token、哈希、绝对本机路径、数据库异常或设备 IP。所有配对、会话、快照、审批和图片响应均发送 `Cache-Control: private, no-store`。

| 方法与路径 | 身份/Scope | 请求 | 成功响应 | 失败要点 |
|---|---|---|---|---|
| `POST /api/mobile/pairings` | 仅本机 token + 本机 Origin | `{device_label, scope}` | `{pairing_url, expires_at}` | 手机 Host 即使有 cookie 也 403；原始码不写日志 |
| `POST /api/mobile/pairings/cancel` | 仅本机 token | `{pairing_id}` | `{cancelled:true}` | 幂等，未知/已过期均用通用结果 |
| `POST /api/mobile/pair/exchange` | 无旧会话；精确外部 Origin | `{pair_token}` | Set-Cookie；`{device:{label,scope}, expires_at}` | TTL、单次事务、限速；不区分错误细节 |
| `GET /api/mobile/session` | 手机 Cookie | 无 | `{device, scope, expires_at, desktop_online}` | 401 响应以过期 `Set-Cookie` 清当前浏览器 Cookie，运行页面尽力清 Cache/IDB 并回配对页；不承诺唤醒离线手机远程擦除 |
| `GET /api/mobile/csrf` | 手机 Cookie | 无 | `{csrf, expires_at}` | nonce 只进 JS 内存；响应 no-store |
| `GET /api/mobile/devices` | 仅本机 token | 无 | 设备列表和最近使用时间 | 不返回任何 token/hash |
| `POST /api/mobile/devices/revoke` | 仅本机 token | `{device_id}` | `{revoked:true}` | 服务器记录立即失效并关闭在线 WS；幂等；响应只证明服务端撤销，不声称远程擦除手机 |
| `POST /api/mobile/session/revoke` | 手机 Cookie + CSRF | 无 | 清 Cookie | 在线自助退出；当前页面尽力清本机离线存储，失败要明确提示用户去系统设置清站点数据 |
| `GET /api/mobile/offline-snapshot` | 手机 Cookie + `read` | 无 | 第 6.2 节固定 schema | 服务端先脱敏；不得返回任意透传 payload |
| `GET /ws` Upgrade | 手机 Cookie + 精确 Origin | 浏览器握手 | 现有事件流 | 禁止手机使用 `xs-token.<token>` 子协议 |

### 6.1 REST/WS 安全门顺序

每个外部 API / WS 请求按以下顺序检查，任一失败立即停止。顶层文档和静态资源允许 `Sec-Fetch-Site: none` 的用户导航，但只返回无秘密的 PWA 外壳，绝不借此返回 Cookie 保护的数据：

1. 手机功能 enabled；
2. Host 精确等于配置 FQDN（443 时不带端口）；
3. WS 和所有写请求的 Origin 精确等于配置 HTTPS Origin；缺失、`null`、same-site 但非 same-origin 均拒绝；同源 GET fetch 可能不带 Origin，不把缺失本身当作放行依据；
4. 手机 API 强制 `Sec-Fetch-Site: same-origin`；静态顶层导航才允许 `none`，cross-site/same-site 一律不进入 API；
5. Cookie 会话存在、双 Cookie 匹配、未撤销、未空闲/绝对过期；
6. 路由 scope 足够；
7. 非安全方法要求 `Content-Type: application/json` 和 `X-XS-CSRF`；CSRF nonce 短期、会话绑定、常量时间比较；
8. 最后才进入既有权限、Task v2、审批和效果账本。

服务端不返回 CORS 放行头，尤其不得返回 `Access-Control-Allow-Origin: *` 或 credentials CORS。WSS 不能自定义 CSRF 头，因此必须校验 Cookie、精确 Origin 和会话状态；非浏览器客户端可以伪造 Origin，所以 Origin 从来不替代会话认证。

MVP 只支持会发送 Fetch Metadata 的现代浏览器；手机首次加载要做能力预检，缺少所需能力时显示“浏览器版本不受支持”，不能为了兼容而跳过 `Sec-Fetch-Site` 安全门。iOS 推送的最低边界另见第 7 节阶段 4。

### 6.2 离线快照固定 schema

服务端只允许以下脱敏聚合字段：

```json
{
  "version": 1,
  "captured_at": "2026-08-09T12:00:00Z",
  "expires_at": "2026-08-10T12:00:00Z",
  "desktop": {"last_seen_at": "2026-08-09T12:00:00Z"},
  "tasks": {"queued": 2, "running": 1, "waiting": 0, "succeeded": 5, "failed": 0},
  "notices": [{"kind": "task_completed", "count": 2}]
}
```

禁止字段：会话正文、用户输入、模型输出、任务标题/描述、项目名、审批正文/选项、命令、脚本正文、diff、文件路径、截图、ArtifactRef、token、密钥、模型配置、错误堆栈和可逆标识符。

### 6.3 撤销与本地清除的准确语义

必须把两个控制面分开显示和验收：

- **服务端撤销是权威且立即的**：提交单设备/全部撤销的事务后，旧 Cookie 对 REST/图片/WSS 立即无权，在线 WS 被服务端关闭；即使手机继续保留 Cookie 字节，也不能重新取得在线数据。
- **本地清除只对正在运行或后来重连的页面尽力执行**：在线退出、401、撤销 WS 事件、scope 降级或下次启动时，页面删除 `xs-offline-v1`、相关 Cache 与内存状态；删除失败要保持锁定页并提示系统级清除，不能悄悄继续显示。
- **离线/关机/丢失手机不能被 Web 应用远程擦除**：在它重连或打开应用之前，服务器无法删除浏览器已经保存的离线字节。快照携带不可续期的固定 `captured_at`/`expires_at`；每次渲染前若当前时间不在该区间，或当前运行周期的单调计时已超过 TTL，UI 必须先拒绝渲染再尝试清除。关机后人为把系统时钟调到该区间仍可能延长展示，这是浏览器离线模型的残余风险；因此 schema 禁止敏感字段，不能把 TTL 描述成可靠远程擦除。即使 UI 不再展示，物理字节仍可能留到浏览器/OS 清站点数据或整机远程抹除。
- Cookie 的 `Max-Age`、24 小时离线快照 TTL 和“不含敏感字段”的 schema 是残留影响上限，不是远程删除证明。验收报告必须分别写“服务器已失效”“在线客户端已清”“离线客户端待重连/系统清除”，不得合并成一个绿色状态。

丢机处置顺序：立即在桌面执行 `S mobile revoke <device-id>`（身份不明则 `--all`）并记录服务器撤销时间；在 Tailscale Machines 页 Remove 该手机，使其立即失去 tailnet 资源；再使用 Apple/Google 的设备查找与远程抹除能力。设备找回后仍要清除该 FQDN 的站点数据、卸载 PWA/Tailscale 配置并重新配对。若手机从未再次联网，唯一能确认的是服务器已拒绝与 TTL 后 UI 应拒绝展示，不能确认旧离线字节已被擦掉。

## 7. 分阶段实现与文件落点

每阶段都先补失败测试，再实现，再独立审查；前一阶段未绿不得启用下一阶段。

### 阶段 0：冻结现状和安全回归

目标：证明当前外部 Host/HTTPS Origin 被拒，本机工作流不退化。

- 修改/新增测试：`tests/ui_server/test_mobile_origin.py`。
- RED：外部 FQDN 目前 421/403；记录现有本机 Host/Origin/token/WS 测试基线。
- GREEN 条件：这里只增加基线测试，不扩大生产白名单。

### 阶段 1：配置、配对、设备会话与撤销

文件落点：

- 新增 `harness/mobile_access.py`：严格配置模型、SQLite 迁移、哈希存储、TTL、单次事务、撤销和审计适配器；
- 新增 `harness/mobile_access_cli.py`：`S mobile configure|status|pair|devices|revoke|disable`；原始 token 只在显式 `pair` 输出一次；
- 修改 `run.py`：注册 `mobile` 子命令；
- 修改 `harness/ui_server.py`：双身份分派、精确 Host/Origin、Cookie、CSRF、外部图片 cookie 鉴权、WS cookie 鉴权；
- 新增 `tests/test_mobile_access.py`、`tests/ui_server/test_mobile_pairing.py`。

必须覆盖：配置畸形、尾点/端口/大小写规范化、过期、并发双换、重放、取消、5 次失败锁定、全局限速、双 Cookie 缺一、空闲/绝对过期、单设备/全部撤销、scope 越权、错误体和日志无 token/hash/path。

### 阶段 2：PWA 外壳与严格离线

文件落点：

- 新增 `ui/manifest.webmanifest`；复用本地 `ui/assets/icon-*.png`，补齐 192/512 和 maskable 声明前先做视觉验收；
- 新增 `ui/sw.js`：只预缓存带内容版本号的 HTML/CSS/JS/icon/manifest；activate 删除旧版本；
- vendor `qrcode-generator` `js1.4.4` 到 `ui/vendor/qrcode-generator/1.4.4/`，同交 `LICENSE`、锁定实际字节的 `SHA256SUMS` 与本地 canvas 包装器；构建/测试重算哈希，绝不从 CDN 或 npm runtime 加载；
- 新增 `ui/js/mobile/pairing-bootstrap.js`：作为 `<head>` 第一段同步同源脚本，读取 fragment 后立刻 `replaceState`；新建 `ui/js/mobile/pairing.js`：一次性消费内存码、交换、设备状态和退出；
- 新增 `ui/js/mobile/offline.js`：只将固定 schema 写入 `xs-offline-v1` IndexedDB；
- 修改 `ui/js/net.js`：本机 bearer 与手机 cookie 两种模式互斥；手机 `fetch(..., {credentials:"same-origin"})`，写请求加内存 CSRF；
- 修改 `ui/index.html`：manifest、theme、安装/离线/撤销 UI；
- 修改 `harness/ui_server.py`：静态资源 MIME、Service-Worker-Allowed、缓存头和 CSP；
- 新增 `tests_js/mobile-pwa.test.mjs`、`tests/ui_server/test_mobile_cache_policy.py`。

Service Worker 只处理同源 GET 静态 allowlist；对 `/api/`、`/ws`、`/api/images/`、配对路径和非 GET 一律 network-only 且不得 `cache.put()`。API 的 `no-store` 不能替代这条代码级 denylist。当前运行页在退出、撤销通知、401、scope 降级和 manifest 版本变化时主动删除旧 Cache Storage 与 IndexedDB；离线/关机设备只在下次启动或重连时执行，语义以第 6.3 节为准。

浏览器自动化必须用网络记录器与可控 History 覆盖：第一次执行的应用代码在任何交换、主入口 import、Service Worker 注册前已清除 fragment；201、通用 4xx/5xx、超时和网络中断后，地址栏、`history.state`、DOM、全局对象、local/session storage、Cache、IDB、控制台、请求 URL/Body 以外的 header（特别是 `Referer`）都不残留原始码；交换 POST 的 body 是唯一允许的网络出现点。成功或失败后刷新、前进、后退再回 PWA 均不恢复 fragment、不再次交换；测试记录交换计数始终为 1。CSP/离线测试断网启动时只能加载同源固定 vendor，外域请求计数为 0，`SHA256SUMS` 校验通过。

### 阶段 3：响应式交互与在线强制

- 修改 `ui/styles/base.css`、`ui/styles/components.css`、`ui/styles/panels.css`：安全区、触控目标、窄屏单列、键盘避让；
- 修改任务和审批视图：`desktop_online=false`、WS 未连或快照模式时禁用并解释所有变更按钮；
- 在线操作以现有 Task v2 `client_token`/幂等机制提交，断线不自动重放未确认写操作；
- 用 iPhone Safari 主屏幕、Android Chrome、桌面 Edge 三端真机/浏览器验收。

### 阶段 4：可选推送（不阻塞 MVP）

只有前三阶段稳定后才实现。iOS/iPadOS 需要先加入主屏幕，且 `Notification.requestPermission()` 必须由用户点击“开启通知”直接触发，[WebKit 官方边界](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) 不允许启动时偷偷弹窗。

推送 payload 只包含 `task_completed`、`task_waiting` 等类别和计数，不含会话、任务名、错误、审批、脚本或路径。用 feature detection，不用 UA 猜测。关闭推送不影响 PWA；推送抵达也不能在桌面离线时执行或审批。

## 8. 威胁模型与控制

| 威胁 | 现实后果 | 必须控制 | 验收证据 |
|---|---|---|---|
| QR 被拍照/截屏或留在扫码器历史 | 攻击者抢先配对；应用无法删除外部副本 | 256-bit、5 分钟、一次使用、scope 默认 read、桌面可取消、全局限速；手机首屏同步清 fragment | 首次成功后 100 次重放均失败；过期/取消失败；成功/失败/刷新/历史导航均无 fragment 与自动重试 |
| 两个客户端同时交换 | 生成两个设备会话 | 单个数据库事务做 compare-and-consume | 并发屏障测试只产生一条 session |
| CSRF/恶意网页 | 借 Cookie 发写请求或开 WS | SameSite=Strict、`__Host-`、精确 Origin、Sec-Fetch-Site、JSON + 内存 CSRF；WS Origin 403 | cross-site/same-site/null/缺 Origin 全部拒绝 |
| 恶意 tailnet 成员 | 探测、暴力尝试、利用宽 ACL | 移除 allow-all、仅许可指定组到 tcp:443、policy deny 测试；应用仍要求配对会话 | 未授权真实账号 TCP/HTTPS 失败，授权账号未配对仍 401 |
| 手机丢失 | 持有活跃 Cookie 和离线摘要；离线本地字节无法由服务器远程擦除 | 服务器立即撤销、断在线 WS、从 tailnet Remove、24 小时快照 TTL 后拒绝渲染；在线/重连时尽力清理，必要时 OS 远程抹除 | 分别证明服务器立即 401/断 WS、在线页已清、离线页重连前不再渲染；未重连设备只标“待系统清除”，绝不声称已擦除 |
| 桌面离线/睡眠 | 手机误以为操作已提交 | WSS/心跳作为在线事实；断线 UI 只读；写请求不离线排队、不自动重放 | 断网后按钮禁用，恢复后必须重新确认未提交动作 |
| Service Worker 误缓存 | token、审批或脚本长期留机 | 静态 allowlist + API denylist + `private,no-store` + 在线/重连清理；不宣称远程擦除离线设备 | 遍历 Cache/IDB，敏感哨兵零命中；离线 TTL 到期先拒绝渲染 |
| QR 依赖供应链/外域泄漏 | 运行时下载脚本或把配对链接交给第三方 | 固定 `js1.4.4` vendor、LICENSE、逐文件 SHA-256、同源 CSP、离线 allowlist、canvas 包装 | 哈希重算一致，断网可渲染，CSP 报告与网络录制外域请求为 0 |
| XSS | 借同源脚本操纵会话 | `script-src 'self'`、无第三方 QR/统计脚本、输出转义；HttpOnly 使 JS 不能直接读 Cookie | CSP/E2E 注入用例；`document.cookie` 看不到凭据 |
| 代理头伪造/DNS 重绑定 | 扩大允许 Host/Origin | 后端只绑定回环，只信本地配置中的精确公开 origin，不根据转发头扩白 | 伪造 Host/X-Forwarded-Host/Origin 均 421/403 |
| 本机 `.state` 被复制 | 攻击者分析会话库 | 只存单向哈希和脱敏审计；文件限当前用户 | 数据库扫描无可直接使用 token/密钥 |

## 9. 验收清单

### 9.1 自动化

- [ ] 当前本机 Host/Origin、bearer、WS 和图片用例全绿；手机通道没有改变本机语义。
- [ ] 配置 fail-closed、单次原子交换、TTL、限速、scope、撤销、审计脱敏全绿。
- [ ] 精确 `https://FQDN` REST Origin 和 `wss://FQDN/ws` 工作；HTTP、IP、短主机名、子域/后缀欺骗、额外端口、null/缺 Origin 全拒。
- [ ] 手机所有 JSON/图片响应无 bearer/query token；浏览器存储扫描仅 Cookie jar 有不透明凭据。
- [ ] Service Worker 缓存键只属于版本化静态 allowlist；含敏感哨兵的 API、审批、脚本、图片在 Cache/IDB 中零命中。
- [ ] QR 运行时依赖只有 repo-local `qrcode-generator` `js1.4.4`；许可证在仓库，逐文件 SHA-256 重算与锁文件一致；断网仍可渲染，CSP/网络录制没有 CDN、第三方脚本或外域 connect。
- [ ] 配对首屏在任何 fetch/import/SW 注册前同步读 fragment 并 `replaceState`；201、4xx/5xx、超时与网络失败后，刷新/前进/后退均无原始码且交换计数仍为 1。请求 URL、`Referer`、DOM、History/Storage/Cache/IDB/console 零命中；只有第一次交换 POST body 允许出现一次。
- [ ] 断线期间没有 Background Sync 或自建队列提交写操作；恢复后没有自动执行。

### 9.2 Windows + tailnet 真机

- [ ] Windows 已安装并登录 Tailscale，`BackendState=Running`、Self online、`Self.DNSName` 为精确 `*.ts.net`，`Resolve-DnsName` 成功；手机已安装 Tailscale、接受 VPN、用授权身份登录同一 tailnet并在 Machines 页处于已批准/在线状态。
- [ ] Owner/Admin 已检查机器名与 tailnet DNS 名；记录对公开、不可抹除 CT 元数据的接受决定。拒绝披露时验收结果必须是“维持桌面本地版、未启用 Serve”，不能勉强放行。
- [ ] Grants 在 Serve 前完成 allow/deny policy tests，且不存在覆盖目标 443 的宽规则；`tailscale serve status` 只显示 HTTPS 443 → `http://127.0.0.1:7788`，`tailscale funnel status` 没有小蛇入口。
- [ ] `$xsOrigin` 的 Windows HTTPS GET 返回预期状态且证书无警告；授权手机真实 HTTPS 可达，独立未授权 tailnet 身份在 TCP/HTTPS 443 被拒，不能用应用 401 代替网络拒绝证据。
- [ ] `Get-NetTCPConnection -State Listen` 显示 Python 仅监听 `127.0.0.1:7788`，没有 `0.0.0.0:7788`、LAN 或 Tailscale IP 监听。
- [ ] 授权手机可打开精确 FQDN；未授权 tailnet 成员不能连接 443；非 tailnet 网络不可达。
- [ ] 未配对手机只能看到安全配对壳，无法读 API；配对后按 scope 工作。
- [ ] 二维码 5 分钟过期、一次使用；取消/重放/并发第二次均失败且日志无原始码。
- [ ] 在线撤销：服务器事务完成后目标 WS 立即关闭、REST/图片 401；运行中的页面删除离线库/缓存并锁定，其他设备不受单设备撤销影响。
- [ ] 离线后撤销再重连：服务器在手机离线期间已拒绝旧会话；首次启动/重连在渲染快照前发现撤销/到期并尽力清除，不能先闪现旧数据；全部撤销覆盖每台设备。
- [ ] 永不重连/丢机：报告不得声称远程擦除。24 小时 `expires_at` 后 PWA 必须拒绝渲染快照；残留字节只标记为等待浏览器/OS 清站点数据或远程抹除，并记录 tailnet Remove 与服务器撤销时间。
- [ ] Windows 睡眠/小蛇退出后手机进入脱敏只读；不得显示旧审批或脚本；恢复后在线操作重新确认。
- [ ] iPhone/iPad：加入主屏幕后可独立启动；通知权限只在点击按钮后请求。Android/Edge 用 feature detection 正常降级。

## 10. 回滚

回滚顺序遵循“先断入口，再停应用功能”：

```powershell
tailscale serve --https=443 off
tailscale serve status
S mobile disable
S mobile revoke --all
```

不要用 `tailscale serve reset` 作为首选，因为它会清除该节点的全部 Serve 配置；只有确认节点没有其他 Serve 映射时才考虑官方的 reset 命令。随后：

1. 在 tailnet policy 删除小蛇专用 grant/tests（不要恢复 allow-all）；
2. 在线手机端退出并在系统浏览器设置中清理该站点数据/PWA；离线/丢失手机只能先撤销服务器会话并从 Machines 页 Remove，待重连或依靠系统远程抹除，不能报告“已远程清缓存”；
3. 保留脱敏审计，删除未使用配对记录；
4. 本机 `http://127.0.0.1:7788` 继续可用，证明回滚没有破坏桌面流程。

默认**不要**为了单个小蛇入口关闭 MagicDNS 或 tailnet HTTPS：它们是 tailnet 级能力，关闭会破坏其他依赖 HTTPS 的链接；已经签发的证书不会被吊销，也没有单机证书失效开关。若 Owner 确认整个 tailnet 都不再需要 HTTPS，才可在 DNS 页执行 tailnet 级关闭并另行验收受影响服务。无论是否关闭，既有公开 CT 条目都不能由本方案删除；回滚记录必须保留这一残余披露，而不是写成“恢复到从未公开”。

## 11. 故障排查

| 现象 | 检查 | 处理 |
|---|---|---|
| `tailscale` 命令不存在 | `Get-Command tailscale.exe` | 按 [Tailscale Windows 官方安装说明](https://tailscale.com/docs/install/windows) 由设备所有者安装并登录；不要由小蛇静默安装 |
| Serve 状态正常但手机打不开 | `tailscale status --json` 的 Self.DNSName、手机 tailnet、grant 和 443 policy test | 使用完整 FQDN；审计是否仍有错误账号/设备；不改为 LAN/Funnel 绕过 |
| 421 `bad_host` | 配置 origin 与浏览器地址、Host 是否完全一致 | 重新运行 `S mobile configure --origin <精确FQDN>`；不加通配符 |
| 403 `bad_origin` | 浏览器 Origin、是否从书签/IP/短名进入 | 只从精确 HTTPS FQDN 进入；WS Origin 也应是同一个 HTTPS Origin |
| 401 `mobile_session_required` | Cookie 是否过期/撤销、桌面是否重置会话库 | 从桌面重新生成一次性 QR；不要把本机 UI token 粘到手机 |
| PWA 显示旧版本 | manifest/service-worker 版本、Cache Storage | 先走应用内“清除离线数据”，再注销 SW；不要通过缓存 API 响应修补 |
| 离线仍能点审批/运行 | WSS/在线门和视图状态 | 视为阻断发布的安全缺陷；立即关闭 Serve，修复后重验 |
| iOS 无通知按钮/提示 | 是否加入主屏幕、是否由点击触发、系统版本与权限 | 推送非 MVP；保持普通 PWA，按 WebKit 边界排查，不循环弹权限 |
| 关闭后仍可访问 | `tailscale serve status`、其他 Serve/Service/Funnel 映射 | 精确关闭 443 映射；确认没有同主机其他公开入口；必要时仅在专用节点用 reset |

## 12. 完成定义

只有同时满足以下条件，才可以说“手机 PWA 已接通”：

- 自动化与三端真机验收全部通过；
- 小蛇进程仍只监听回环，Serve 状态只有私有 HTTPS，Funnel 不存在；
- 授权/未授权 tailnet 身份的真实网络结果与 policy tests 一致；
- 配对、Cookie、CSRF、WS、撤销、过期、离线和缓存边界有可复现证据；
- 文档、界面与审计明确标注在线/离线、scope 和风险，不把“方案完成”写成“功能已实现”。
