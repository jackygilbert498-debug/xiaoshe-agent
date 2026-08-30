"""出网 HTTP 统一传输口径：全部走**系统 curl 子进程**（Python 层不碰 TLS——哲学详见 kimi_client 模块头：
本机 TLS 重协商/代理怪癖下 Python OpenSSL 握手会跪，curl 稳；二进制走 config.CURL，CURL_PATH 可覆盖）。

本模块只放两处出网传输（kimi_client API、web 抓取/搜索）**共用的最小件**：
- `escape_cfg`：curl `-K` stdin 配置里双引号值的转义规则（反斜杠/双引号），两处同一把尺。
- `proxy_stdin_config`：config.PROXY 经 stdin 配置传入——代理串可能含 user:pass@ 凭据，
  与 kimi_client 密钥同哲学：**敏感串绝不进进程 argv**（本机进程列表可窥 argv），只留 `-K -` 入口。

**不硬统的口径**（语义本就不同，各自保留）：超时/重试——kimi API 流式用空闲失速检测+按退出码分类重试
（生成非幂等），web 抓取用 --max-time/--max-filesize 限时限量；错误——kimi 抛 KimiError（附结构化 error），
web 返回 (ok, msg) 元组。见 docs/离生产级还差什么.md「传输统一 curl」排期项。
"""
from __future__ import annotations

from . import config


def escape_cfg(v: str) -> str:
    """curl -K 配置里双引号值需转义反斜杠与双引号，否则会破坏解析/发错 header。"""
    return v.replace("\\", "\\\\").replace('"', '\\"')


def proxy_stdin_config(proxy: str | None = None, proxy_env: str | None = None) -> str | None:
    """config.PROXY 非空 → 单行 `proxy = "..."` 的 -K stdin 配置（末尾 \\n）；未配代理 → None。

    curl 语义与 `-x` 完全等价（均覆盖 env 代理变量 http_proxy/https_proxy），但代理串不出现在 argv。
    调用方 argv 须含 `-K -`，并把返回值作为子进程 stdin 输入（None 则不传 input）。
    代理串含换行/控制字符 → ValueError 硬拒：单行配置会被撑成多行、注入任意 curl 选项，绝不静默放行。
    """
    active_proxy = config.PROXY if proxy is None else proxy
    active_proxy_env = config.PROXY_ENV if proxy_env is None else proxy_env
    if not active_proxy:
        return None
    if not isinstance(active_proxy, str) or any(
            ord(c) < 0x20 or ord(c) == 0x7f for c in active_proxy):
        raise ValueError(
            f"代理配置（{active_proxy_env}）含换行/控制字符，疑似配置注入，已拒绝。")
    return f'proxy = "{escape_cfg(active_proxy)}"\n'
