"""P4 · M5 Web 工具核心：抓网页→正文 / 搜索→结果表。纯标准库解析 + 系统 curl（走 config.PROXY）。

设计要点：
- **网页内容 = 不可信外部数据**：本模块只负责取回+解析成文本，打污点/加前缀在工具层（tools._web_*）做（同 MCP/OCR）。
- **SSRF 硬护栏** `is_safe_url`：只放行公网 http(s)，拒 file://、非 http 协议、localhost/.local/.internal 主机、
  环回/内网/链路本地/保留 IP 字面量（含云元数据 169.254.169.254、IPv6 ::1）。
- **DNS 静态解析预检** `_dns_precheck`（fetch 决策层、甲方拍板 1a 方案②纵深）：真域名放行前 getaddrinfo 解析，
  任一结果落非公网段 → 拒；解析失败/超时 → fail-open 放行但 network.log 如实留「预检未能完成」。
  唯一兼容例外是代理/TUN 常用的 RFC 2544 fake-IP 段 `198.18.0.0/15`：仅域名解析命中该段时允许交给 curl，
  IP 字面量以及混入其他非公网地址的解析结果仍拒绝。
  只挡「静态指向内网」，**不防 DNS-rebinding**（取回时由代理独立重解析，治本靠代理侧 REJECT 内网段）。
- 3xx 重定向不走 curl -L：Python 层逐跳复校验 is_safe_url + 预检后再手动跟（最多 4 跳）。
- 可注入 runner（curl 载体）/ fetcher（search 用）离线 TDD；大页截断在 fetch（max_bytes）+ 工具层 spill 落盘。
- 传输与 kimi_client 统一口径（curl_transport）：系统 curl（config.CURL）、代理经 `-K -` stdin 配置传入
  （可能含 user:pass@ 凭据，绝不进 argv）、-K 转义同一套 escape_cfg、错误串抹 URL 内嵌凭据再回传。
"""
from __future__ import annotations

import datetime
import ipaddress
import json
import re
import socket
import subprocess
import threading
import urllib.parse
from html.parser import HTMLParser

from . import config, curl_transport


def _audit_net(url: str, decision: str, tool: str = "web_fetch", note: str = "") -> None:
    """出网审计（3b，=乙9 effects.jsonl 先行切片）：每次真发 curl（含每跳重定向）追加一行到 logs/network.log——
    web 是本仓最大注入入口，事后可查『被注入后到底访问/被重定向去过哪些地址』。写失败绝不阻塞抓取。
    schema 对齐 effects.jsonl（乙9）：ts / kind=network / tool / target / decision(allow|deny)；
    note 可选（如 DNS 预检未能完成的 fail-open 如实留痕、预检拒绝原因）。"""
    try:
        rec = {"ts": datetime.datetime.now().isoformat(timespec="seconds"),
               "kind": "network", "tool": tool, "target": str(url)[:500], "decision": decision}
        if note:
            rec["note"] = str(note)[:300]
        p = config.ROOT / "logs" / "network.log"
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass

# 浏览器式 UA：不少站对非浏览器 UA 只回表单/挑战页，用真实 UA 才拿到内容。
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
# 搜索后端 = Mojeek（独立引擎，GET、耐爬、结果直链无跳板；真机验过）。DuckDuckGo 反爬对代理 IP 限流太狠、Bing 结构 JS 化，
# 都不适合稳定 scrape。方案首选「Kimi 自带联网」属更重的端点集成，留作后续 robustness 升级（本工具先给可用 best-effort scrape）。
_SEARCH_ENDPOINT = "https://www.mojeek.com/search"


# ── URL 安全（SSRF 护栏）─────────────────────────────────────────────
_HOST_OK = re.compile(r"^[a-z0-9.\-:]+$")   # 域名/IPv4/IPv6(:) 合法字符白名单——拒 {}[] 等 glob/注入字符（curl -g 也关 glob）


def _numeric_host_to_ipv4(host: str):
    """按 curl/inet_aton 语义把**数字 host**（十进制整数/0x hex/0 前导八进制/短式/点分不足四段）解析成 32bit int。

    非纯数字形式（真域名，含字母）→ 返回 None。用于堵 SSRF：ipaddress 不认这些编码却被 curl 解析到内网
    （http://2130706433/=127.0.0.1、http://2852039166/=169.254.169.254 云元数据）。
    """
    host = host.rstrip(".")
    if not host:
        return None
    parts = host.split(".")
    if len(parts) > 4:
        return None
    vals = []
    for p in parts:
        if not p:
            return None
        try:
            if p[:2] in ("0x", "0X"):
                v = int(p, 16)
            elif len(p) > 1 and p[0] == "0":
                v = int(p, 8)
            else:
                v = int(p, 10)
        except ValueError:
            return None                    # 含字母 → 真域名，交给 is_safe_url 当域名放行
        if v < 0:
            return None
        vals.append(v)
    n = len(vals)
    if n == 1:
        ip = vals[0]
    elif n == 2 and vals[0] <= 0xff and vals[1] <= 0xffffff:      # a.b → a 占高 8 位、b 占低 24 位
        ip = (vals[0] << 24) | vals[1]
    elif n == 3 and vals[0] <= 0xff and vals[1] <= 0xff and vals[2] <= 0xffff:
        ip = (vals[0] << 24) | (vals[1] << 16) | vals[2]
    elif n == 4 and all(v <= 0xff for v in vals):
        ip = (vals[0] << 24) | (vals[1] << 16) | (vals[2] << 8) | vals[3]
    else:
        return None
    return ip if 0 <= ip <= 0xffffffff else None


def is_safe_url(url: str) -> bool:
    """只放行公网 http(s)。拒非 http 协议、非法 host 字符（{}[] 等）、localhost/.local/.internal、
    环回/内网/链路本地/保留 IP——含 curl 认的非常规数字 IP 编码（十进制/hex/octal/短式）。
    纯函数、不触网：真域名的静态解析预检在 fetch 决策层 `_dns_precheck` 做（纵深，见模块 docstring）。"""
    raw = (url or "").strip()
    if any(ord(c) < 0x20 or ord(c) == 0x7f for c in raw):
        return False   # 中段控制字符(\r\n\t 等)：urlparse 按 WHATWG 静默剥除 → 校验器与 curl 取回解析分歧，直接拒（#9）
    try:
        u = urllib.parse.urlparse(raw)
    except ValueError:
        return False
    if u.scheme not in ("http", "https"):
        return False
    host = (u.hostname or "").lower()
    if not host or not _HOST_OK.match(host):   # 空 / 含 {}[] 等非法字符 → 拒（防 URL-glob 绕过）
        return False
    if host == "localhost" or host.endswith((".local", ".internal", ".localhost")):
        return False
    ip = None
    try:
        ip = ipaddress.ip_address(host)                    # 点分 IPv4 / IPv6 字面量
    except ValueError:
        n = _numeric_host_to_ipv4(host)                    # curl 认的非常规数字编码
        if n is not None:
            ip = ipaddress.ip_address(n)
    if ip is None:
        return True                                        # 真域名放行
    return ip.is_global   # 只放行全球可路由公网 IP：一举覆盖 private/loopback/link_local/reserved 及黑名单漏掉的 100.64.0.0/10（CGNAT/阿里云元数据 100.100.100.200，#4）


# ── DNS 静态解析预检（纵深防御，甲方拍板 1a 方案②）────────────────────
_DNS_TIMEOUT = 3.0   # 预检超时上限（秒）：getaddrinfo 无超时参数，用线程包住 + join 封顶，防 DNS 假死拖住 fetch
_PROXY_FAKE_IP_NET = ipaddress.ip_network("198.18.0.0/15")


def _default_resolver(host):
    """真解析器：socket.getaddrinfo → getaddrinfo 形状条目列表。模块级 = 测试可整体 patch（tools 层注入不到 resolver 时）。"""
    return socket.getaddrinfo(host, None)


def _real_domain_of(url: str):
    """URL 的 host 是**真域名**（非 IP 字面量/非常规数字编码）则返回小写域名，否则 None——IP 已被 is_safe_url 验过，跳过预检。"""
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
    except ValueError:
        return None
    if not host:
        return None
    try:
        ipaddress.ip_address(host)
        return None                                        # IP 字面量
    except ValueError:
        pass
    if _numeric_host_to_ipv4(host) is not None:
        return None                                        # 十进制/hex/八进制/短式数字编码
    return host


def _dns_precheck(host, resolver=None, timeout=None):
    """静态 DNS 解析预检 → (safe, note)。任一解析结果落非公网段（内网/环回/链路本地/保留，含 IPv6 映射 IPv4）→ 拒。

    - **只挡「域名静态指向内网」**（A/AAAA 常驻 127/8、10/8、172.16/12、192.168/16、169.254/16、100.64/10、
      ::1、fc00::/7、fe80::/10 等——复用 ip.is_global 判定，与 is_safe_url 字面量护栏同一把尺）。
    - **不防 DNS-rebinding**：若配置了 config.PROXY 则取回经代理独立重解析，rebinding 治本靠代理侧
      对内网段一律 REJECT（见 docs/superpowers/specs/2026-07-11-SSRF-DNS-rebinding分析与建议.md）；
      未配代理时 curl 自解析，rebinding 无代理侧兜底，属如实接受的残余。本层只是纵深。
    - **代理 fake-IP 兼容**：域名仅解析到 RFC 2544 `198.18.0.0/15` 时，视为 Clash/TUN 等代理的占位地址并放行；
      URL 中直接填写该段 IP 仍由 `is_safe_url` 拒绝，且解析结果混入任何其他非公网地址时仍拒绝。
    - **fail-open**：解析失败/超时/返回畸形（离线、弱网、DNS 暂不可达）→ 不硬拒，返回 (True, 「预检未能完成…」)，
      由 fetch 落 network.log 如实留痕——纵深层绝不把离线/弱网用户锁死。
    safe=False 时 note = 拒绝原因；safe=True 且 note 非空 = 预检未能完成（fail-open 放行，须留痕）。
    """
    if resolver is None:
        resolver = _default_resolver
    if timeout is None:
        timeout = _DNS_TIMEOUT
    box = {}

    def _job():
        try:
            box["res"] = resolver(host)
        except Exception as e:                     # gaierror/超时/任意解析器异常 → 未能完成（fail-open）
            box["err"] = e

    t = threading.Thread(target=_job, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        return (True, f"预检未能完成（DNS 解析超时 >{timeout:g}s，离线/弱网？），按 fail-open 放行：{host}")
    if "err" in box:
        return (True, f"预检未能完成（DNS 解析失败：{box['err']}），按 fail-open 放行：{host}")
    ips = []
    try:
        entries = list(box["res"] or [])
    except TypeError:
        entries = []
    for info in entries:
        try:
            ips.append(ipaddress.ip_address(info[4][0]))   # getaddrinfo 条目 = (family,type,proto,canonname,sockaddr)
        except (TypeError, IndexError, KeyError, ValueError):
            continue                                       # 畸形条目跳过（真 getaddrinfo 不产出，防注入假 resolver）
    if not ips:
        return (True, f"预检未能完成（DNS 未返回可用地址），按 fail-open 放行：{host}")
    proxy_fake_ips = []
    for ip in ips:
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped                            # ::ffff:127.0.0.1 按映射的 IPv4 判（双保险）
        if isinstance(ip, ipaddress.IPv4Address) and ip in _PROXY_FAKE_IP_NET:
            proxy_fake_ips.append(ip)
            continue
        if not ip.is_global:
            return (False, f"URL 不安全：域名 {host} 静态解析到非公网地址 {ip}（内网/环回/链路本地/保留段），已拒绝。"
                           f"（仅挡静态指向内网；DNS-rebinding 翻转由代理侧 REJECT 治本）")
    if proxy_fake_ips:
        rendered = ", ".join(str(ip) for ip in proxy_fake_ips[:4])
        return (True, f"检测到代理/TUN fake-IP（RFC 2544 198.18.0.0/15：{rendered}），"
                      "保留域名、逐跳重定向与 IP 字面量校验后放行。")
    return (True, "")


# ── HTML → 可读正文 ─────────────────────────────────────────────────
class _TextExtractor(HTMLParser):
    _SKIP = {"script", "style", "noscript", "head", "template", "svg", "iframe"}
    _BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
              "section", "article", "header", "footer", "ul", "ol", "table", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip += 1
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip:
            self._skip -= 1
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._skip:
            return
        t = data.strip()
        if t:
            self.parts.append(t)


def html_to_text(html: str) -> str:
    """把 HTML 抽成可读正文：剥 script/style/head 等噪声、块级标签处断行、折叠多余空白。解析出错也不炸。"""
    p = _TextExtractor()
    try:
        p.feed(html or "")
        p.close()
    except Exception:
        pass
    text = " ".join(p.parts)  # 各片段（含 \n 断行标记）拼回；F47：删原恒真的死条件
    # 折叠：每行去首尾空白、行内多空格合一、连续空行压成一空行
    lines = []
    for raw in text.split("\n"):
        s = " ".join(raw.split())
        if s:
            lines.append(s)
    return "\n".join(lines)


# ── 抓取（curl 走代理）──────────────────────────────────────────────
# 重定向标记：curl -w 把「若跟随会去的目标 url」追加到 body 尾部，Python 层剥下来复校验（不用 -L 自动跟，防重定向 SSRF）。
_REDIR_MARK = "\n\x01HARNESS_REDIRECT\x01="

# 抓取超时/体积上限（秒/字节）：_curl_argv 夹取，防异常调用方让 curl 无限跑/无限收（红队：超时上限）。
# tools 层固定传 timeout=25 / max_bytes=2MB（模型不可控），上限只挡未来调用方/直接 API 调用的坏值。
_TIMEOUT_CAP = 300
_MAX_BYTES_CAP = 20_000_000


def _pos_int(v, default: int, cap: int) -> int:
    """强制成 [1, cap] 的正常数：垃圾值（字符串/None/负数/0）回退 default——这些值会被 str 拼进 curl argv，
    绝不许破坏 argv 结构或生成非法参数。"""
    try:
        n = int(v)
    except (TypeError, ValueError):
        n = default
    return min(cap, max(1, n))


_URL_CRED = re.compile(r"://[^:/@\s]+:[^@\s]+@")


def _scrub_creds(s: str) -> str:
    """脱敏（对齐 kimi_client._scrub 哲学）：stderr 里若出现 scheme://user:pass@ 形态
    （curl 报错带出 URL/代理内嵌凭据），抹掉 userinfo 再回传给模型/日志；host 等排障信息保留。"""
    return _URL_CRED.sub("://***@", (s or "").strip())


def _curl_argv(url: str, max_bytes: int, timeout: int, post_fields=None) -> list:
    # -g 关 URL glob（防 http://{169.254.169.254}/ 展开绕过）；不用 -L 自动跟重定向（改 Python 层拿 %{redirect_url} 复校验）。
    timeout = _pos_int(timeout, 25, _TIMEOUT_CAP)
    max_bytes = _pos_int(max_bytes, 2_000_000, _MAX_BYTES_CAP)
    argv = [config.CURL, "-sS", "-g", "--compressed", "-A", _UA,   # 与 kimi_client 统一走 config.CURL（CURL_PATH 可覆盖），别硬编码 "curl"（#10）
            "--max-time", str(timeout), "--max-filesize", str(max_bytes),
            "-w", _REDIR_MARK + "%{redirect_url}"]
    if post_fields:
        for k, v in post_fields.items():
            argv += ["--data-urlencode", f"{k}={v}"]   # curl 负责 URL 编码，值里的特殊字符不破坏请求
    argv.append(url)
    if config.PROXY:
        # 代理串（可能含 user:pass@ 凭据）不进 argv（本机进程列表可窥），只留 `-K -` 入口、本体走 stdin 配置
        # （curl_transport.proxy_stdin_config，fetch 真跑分支喂入）——与 kimi_client 密钥同哲学，curl 语义同 -x。
        argv += ["-K", "-"]
    return argv


def fetch(url, runner=None, max_bytes: int = 2_000_000, timeout: int = 25, post_fields=None,
          _hops: int = 4, resolver=None, env=None):
    """抓一个 http(s) 网页 → (ok, 原始HTML或错误)。不安全 URL 直接拒（不真抓）。可注入 runner/resolver 离线 TDD。

    runner(argv) → (rc, stdout, stderr)。curl 走 config.PROXY、限时限体积；body 再按 max_bytes Python 侧兜底截断。
    代理串只经 `-K -` stdin 配置传入（可能含凭据，不进 argv——curl_transport.proxy_stdin_config）；注入 runner 时
    argv 仅多 `-K -` 入口标记。timeout/max_bytes 强制夹成 [1, 上限] 正常数（垃圾值回退默认，不破坏 argv）。
    resolver(host) → getaddrinfo 条目列表，供 DNS 静态解析预检（`_dns_precheck`，纵深防御）：真域名放行前解析一次，
    静态指向内网 → 拒；解析失败/超时 → fail-open 放行并 network.log 留「预检未能完成」。IP 字面量不触发解析。
    **重定向**：不用 curl -L 自动跟，改从尾部标记拿目标、对每一跳重过 is_safe_url + 预检再手动跟（防重定向 SSRF），最多 _hops 跳。
    post_fields 给出则改 POST（--data-urlencode）；跟随重定向时降级为 GET（不带 post_fields）。
    """
    timeout = _pos_int(timeout, 25, _TIMEOUT_CAP)           # 垃圾值回退默认，别传进 subprocess timeout/argv 炸掉
    max_bytes = _pos_int(max_bytes, 2_000_000, _MAX_BYTES_CAP)
    if not is_safe_url(url):
        _audit_net(url, "deny")
        return (False, "URL 不安全或不支持：只允许公网 http(s)，拒 file://、localhost、内网/云元数据 IP。")
    precheck_note = ""
    domain = _real_domain_of(url)
    if domain is not None:                              # 真域名：静态解析预检（单次）；IP 字面量已被 is_safe_url 验过
        safe, precheck_note = _dns_precheck(domain, resolver)
        if not safe:
            _audit_net(url, "deny", note=precheck_note)
            return (False, precheck_note)
    _audit_net(url, "allow", note=precheck_note)   # 3b：真发 curl 前留痕（每跳重定向经递归各记一行）；预检未能完成也如实记入 note
    try:
        argv = _curl_argv(url, max_bytes, timeout, post_fields)
        stdin_cfg = curl_transport.proxy_stdin_config()   # 代理走 stdin（无代理=None）；坏配置（含换行/控制字符）在此硬拒
        if runner is not None:
            rc, out, err = runner(argv)
        else:
            p = subprocess.run(argv, input=stdin_cfg, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=timeout + 15, env=env)
            rc, out, err = p.returncode, p.stdout, p.stderr
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return (False, f"抓取子进程失败：{e}")
    if rc != 0:
        return (False, _scrub_creds(err) or f"curl 非零退出（{rc}）")
    body, redirect = out or "", ""
    i = body.rfind(_REDIR_MARK)               # 剥掉尾部重定向标记（注入 runner 无标记时 i=-1，原样当 body）
    if i != -1:
        redirect = body[i + len(_REDIR_MARK):].strip()
        body = body[:i]
    if redirect and _hops > 0:                # 有重定向目标：复校验后手动跟一跳（GET）
        if not is_safe_url(redirect):
            _audit_net(redirect, "deny")      # 3b：重定向被拒也留痕（正是"被注入后想跳内网"的场景）
            return (False, f"重定向到不安全地址（内网/元数据/非 http），已拒绝：{redirect[:100]}")
        ok2, out2 = fetch(redirect, runner=runner, max_bytes=max_bytes, timeout=timeout,
                          _hops=_hops - 1, resolver=resolver, env=env)
        if not ok2 and out2.startswith("URL 不安全"):     # 递归层护栏/预检拒：点明发生在重定向目标上
            return (False, f"重定向目标被拒：{out2}")
        return (ok2, out2)
    return (True, body[:max_bytes])


# ── 搜索（抓 Mojeek 结果页并解析）───────────────────────────────────
class _MojeekParser(HTMLParser):
    """解析 Mojeek 结果页：`<h2><a class="title" href="直链">标题</a></h2>` + `<p class="s">摘要</p>`（含 <strong> 高亮）。"""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results = []
        self._in_title = False        # 在 <a class="title"> 内
        self._in_snip = False         # 在 <p class="s"> 内
        self._href = ""
        self._tbuf = []
        self._sbuf = []

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        classes = (d.get("class", "") or "").split()
        if tag == "a" and "title" in classes:      # 标题锚（非 class="ob" 的外层链接）
            self._in_title = True
            self._href = d.get("href", "")
            self._tbuf = []
        elif tag == "p" and "s" in classes:         # 摘要段
            self._in_snip = True
            self._sbuf = []

    def handle_endtag(self, tag):
        if tag == "a" and self._in_title:
            title = "".join(self._tbuf).strip()
            if title and self._href.startswith(("http://", "https://")):
                self.results.append({"title": title, "url": self._href, "snippet": ""})
            self._in_title = False
        elif tag == "p" and self._in_snip:
            snip = " ".join("".join(self._sbuf).split())
            if self.results and not self.results[-1]["snippet"]:
                self.results[-1]["snippet"] = snip
            self._in_snip = False

    def handle_data(self, data):
        if self._in_title:
            self._tbuf.append(data)
        elif self._in_snip:                          # <strong> 高亮等嵌套标签内文本也一并收进摘要
            self._sbuf.append(data)


def search(query, runner=None, fetcher=None, limit: int = 8, env=None):
    """搜索 query → [{title,url,snippet}]（抓 Mojeek 结果页解析）。可注入 fetcher(url)->(ok,html) 离线 TDD。"""
    if fetcher is None:
        def fetcher(url):
            return fetch(url, runner=runner, env=env)
    url = _SEARCH_ENDPOINT + "?" + urllib.parse.urlencode({"q": query or ""})
    ok, html = fetcher(url)
    if not ok or not html:
        return []
    p = _MojeekParser()
    try:
        p.feed(html)
        p.close()
    except Exception:
        pass
    return p.results[:limit]
