# SSRF 治本：Clash 内网网段 REJECT 规则（2026-07-25，甲方拍板 1a）

> 背景：`docs/superpowers/specs/2026-07-11-SSRF-DNS-rebinding分析与建议.md`——DNS-rebinding 的治本点在代理侧
> （Clash 才是真正解析+连接的一方）。本文件给出可直接贴进 Clash 配置的规则片段。
> Python 侧静态解析预检（`harness/web.py`）是纵深补充，只挡静态指向内网；rebinding-through-proxy 只能靠这里的规则堵。

## 贴法（Clash for Windows / Clash Verge / clash.meta 通用）

把下面规则加到配置 `rules:` 段的**最前面**（规则按序匹配，必须排在任何 MATCH/代理规则之前）：

```yaml
rules:
  # ── SSRF 治本：内网/环回/链路本地/运营商级 NAT 一律 REJECT（2026-07-25）──
  # 注意：必须去掉 no-resolve，否则 Clash 对域名请求直接跳过 IP 类规则，
  # rebinding 域名（如 127.0.0.1.nip.io）会绕过拦截。代价是每个域名请求
  # 在规则匹配阶段多一次本地 DNS 解析（通常 <10ms，可接受）。
  - IP-CIDR,127.0.0.0/8,REJECT                 # 环回
  - IP-CIDR,10.0.0.0/8,REJECT                  # 私网 A
  - IP-CIDR,172.16.0.0/12,REJECT               # 私网 B
  - IP-CIDR,192.168.0.0/16,REJECT              # 私网 C
  - IP-CIDR,169.254.0.0/16,REJECT              # 链路本地
  - IP-CIDR,100.64.0.0/10,REJECT               # CGNAT
  - IP-CIDR6,::1/128,REJECT                    # IPv6 环回
  - IP-CIDR6,fc00::/7,REJECT                   # IPv6 ULA
  - IP-CIDR6,fe80::/10,REJECT                  # IPv6 链路本地
  # ── 之上为 SSRF 段，其余原有规则接在下面 ──
```

注意：
- **去掉 `no-resolve` 是堵 rebinding 的关键**：带 `no-resolve` 时 IP 类规则对域名请求直接跳过（Clash 不为它触发 DNS 解析），rebinding 域名会绕过全部拦截；去掉后 Clash 在匹配阶段解析域名，解析结果落内网即 REJECT。
- 若你的配置有「局域网设备要经代理访问」的正当需求（如代理同网段 NAS），把对应网段那条删掉或改成更窄的排除——删之前知道自己在放行什么。
- 改完重启 Clash 生效。

## 验证（贴完后跑）

```bash
# 直连内网应被 REJECT（连接失败/超时即生效）
curl -x http://127.0.0.1:7897 --max-time 5 http://192.168.1.1/ -v
curl -x http://127.0.0.1:7897 --max-time 5 http://127.0.0.1:80/ -v
# 域名 rebinding 也应被 REJECT（关键验证：去掉 no-resolve 后才会生效）
curl -x http://127.0.0.1:7897 --max-time 5 http://127.0.0.1.nip.io/ -v
curl -x http://127.0.0.1:7897 --max-time 5 http://192.168.1.1.nip.io/ -v
# 公网照常
curl -x http://127.0.0.1:7897 --max-time 8 https://api.kimi.com -o /dev/null -w "%{http_code}"
```

预期：前四条连接被重置/拒绝，最后一条返回 HTTP 状态码（404 也算通）。

## 两侧分工（一句话）

- **Clash REJECT（本文件）**：治本——任何经代理的请求，真实连接目标落内网就拒。规则必须去掉 `no-resolve`，Clash 才会在匹配阶段解析域名，rebinding 翻转也逃不掉。
- **Python 预检（`harness/web.py`）**：纵深——静态 A/AAAA 记录就指向内网的域名（如 `127.0.0.1.nip.io`）在放行前直接拒，fail-open（DNS 不可达不硬拒、如实告知）。
