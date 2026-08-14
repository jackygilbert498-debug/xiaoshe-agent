"""配置加载：环境变量 > .env > 代码内置默认值（契约里写死的优先级）。

不散落任何硬编码密钥/绝对路径——线路、代理、key 都从 .env 读。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"


def _load_env_file(path: Path) -> dict[str, str]:
    vals: dict[str, str] = {}
    if path.exists():
        try:
            text = path.read_text(encoding="utf-8-sig")  # #29 utf-8-sig：有 BOM 自动吞、无 BOM 等价，防首行 key 挂
        except UnicodeDecodeError:
            # 本函数在模块导入时刻执行，此处不许崩：指清问题、按未配置处理（缺 key 的指路提示随后自然出现）
            # 不用 _io.warn：config 是最底层模块，避免引入 harness 内部依赖
            try:
                sys.stderr.write(f"[!] {path} 不是 UTF-8 编码（可能被编辑器存成了 ANSI/GBK）——"
                                 "请用 UTF-8 重新保存该文件；本次按未配置处理。\n")
            except Exception:
                pass
            return vals
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip()
            # #22 剥最外层一对成对引号（Windows/复制粘贴常写 KEY="sk-xxx"，带引号进 Authorization 头会 401）；
            # 只剥首尾同种引号、只剥一层，引号内空白保留。
            if len(v) >= 2 and v[0] == v[-1] and v[0] in ("\"", "'"):
                v = v[1:-1]
            vals[k.strip()] = v
    return vals


_FILE = _load_env_file(ENV_PATH)


def env_file_values() -> dict[str, str]:
    """Return a copy of parsed .env values without changing configuration precedence."""
    return dict(_FILE)


def get(key: str, default: str = "") -> str:
    """环境变量优先（显式设成空串也算数），其次 .env，最后默认值。"""
    v = os.environ.get(key)
    if v is not None:
        return v
    return _FILE.get(key, default)


def _state_dir() -> Path:
    """Return the local runtime-state root, optionally redirected for isolation.

    The override is intentionally environment-only: it is never read from or
    written to `.env`, so a browser walk-through cannot accidentally persist a
    temporary path or point a normal launch at test data.
    """
    raw = os.environ.get("XIAOSHE_STATE_DIR", "").strip()
    if not raw:
        return ROOT / ".state"
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError("XIAOSHE_STATE_DIR 必须是绝对路径")
    return path.resolve()


STATE_DIR = _state_dir()


def get_int(key: str, default: int) -> int:
    """读整数配置：解析失败回退默认，别让坏配置打崩启动。"""
    try:
        return int(get(key, str(default)))
    except (ValueError, TypeError):
        return default


def get_float(key: str, default: float) -> float:
    """读浮点配置：解析失败回退默认（同 get_int 的容错纪律）。"""
    try:
        return float(get(key, str(default)))
    except (ValueError, TypeError):
        return default


def _resolve_provider(raw_provider: str, getter=get) -> dict[str, str]:
    provider = (raw_provider or "kimi").strip().lower()
    if provider == "kimi":
        prefix = "KIMI"
        label = "Kimi"
        default_base_url = "https://api.kimi.com/coding/v1"
        default_model = "kimi-for-coding"
    elif provider == "deepseek":
        prefix = "DEEPSEEK"
        label = "DeepSeek"
        default_base_url = "https://api.deepseek.com"
        default_model = "deepseek-v4-flash"
    else:
        raise ValueError(
            f"MODEL_PROVIDER={raw_provider!r} 不支持；只允许 kimi 或 deepseek。")

    api_key_env = f"{prefix}_API_KEY"
    proxy_env = f"{prefix}_PROXY"
    return {
        "provider": provider,
        "label": label,
        "api_key_env": api_key_env,
        "api_key": getter(api_key_env, ""),
        "base_url": getter(f"{prefix}_BASE_URL", default_base_url),
        "model": getter(f"{prefix}_MODEL", default_model),
        "proxy_env": proxy_env,
        "proxy": getter(proxy_env, ""),
    }


_ACTIVE_PROVIDER = _resolve_provider(get("MODEL_PROVIDER", "kimi"), get)
PROVIDER = _ACTIVE_PROVIDER["provider"]
PROVIDER_LABEL = _ACTIVE_PROVIDER["label"]
API_KEY_ENV = _ACTIVE_PROVIDER["api_key_env"]
API_KEY = _ACTIVE_PROVIDER["api_key"]
BASE_URL = _ACTIVE_PROVIDER["base_url"]
MODEL = _ACTIVE_PROVIDER["model"]
PROXY_ENV = _ACTIVE_PROVIDER["proxy_env"]
PROXY = _ACTIVE_PROVIDER["proxy"]


def model_candidates() -> list[str]:
    """UI 可切换模型清单：当前 MODEL 恒在首位，后接同提供商的 XS_MODELS，去重保序。

    `kimi-` / `deepseek-` 只过滤明确属于另一提供商的前缀；无固定前缀的自定义同端点别名保留。
    此过滤仅约束 UI 候选，不限制直接 `chat(model=...)` 覆盖。未配 XS_MODELS → 单元素清单
    （UI 如实降级为不可点的静态 pill）。只读配置、不写 .env；重启后回活动提供商默认。"""
    out: list[str] = []
    foreign_prefix = "deepseek-" if PROVIDER == "kimi" else "kimi-"
    for m in [MODEL] + [p.strip() for p in get("XS_MODELS", "").split(",")]:
        if (m and m not in out
                and (m == MODEL or not m.lower().startswith(foreign_prefix))):
            out.append(m)
    return out
CURL = get("CURL_PATH", "curl")


def tasking_mode() -> str:
    """读取可逆 Task 工作台开关；运行时读取环境，方便测试和 launcher 覆盖。"""
    value = get("XIAOSHE_TASKING_V2", "off").strip().lower()
    if value not in {"off", "on", "shadow"}:
        raise ValueError("XIAOSHE_TASKING_V2 只能是 off、on 或 shadow")
    return value
# D1-1b 工具子进程出网管控（netguard 消费；config 不 import netguard 防循环依赖）：
# off（默认）= 环境擦除 + 代理指死地址零出网 / proxy = 本地 FilterProxy 白名单过滤 / open = 旧行为显式降级。
TOOL_NET_MODE = get("TOOL_NET_MODE", "off")
TOOL_NET_ALLOW = get("TOOL_NET_ALLOW", "")  # 逗号分隔白名单域名；空 = 全拒（fail-closed）
# 上下文窗口合理界（calibrate.py 也复用这一对，单一真源）：比下界还小没法干活、判坏值；
# 比上界还大多半是坏配置/畸形报错，会架空 75% 闸致每次必溢。
WINDOW_MIN = 16384
WINDOW_MAX = 8_000_000


def _clamp_window(v: int) -> int:
    """窗口夹到 [WINDOW_MIN, WINDOW_MAX]——坏配置/坏值不许突破这条不变量（红队 LOW）。"""
    return min(WINDOW_MAX, max(WINDOW_MIN, v))


def _parse_budget_override(raw: str):
    """显式预算覆盖：仅当是 **>0** 的整数才采纳，否则 None（回退派生）。
    0/负数是「关掉/无限」的自然约定，绝不能被当成合法预算 0（那会让每轮必压、白烧摘要）（红队 MED）。"""
    try:
        v = int(raw) if raw else None
    except (ValueError, TypeError):
        return None
    return v if (v is not None and v > 0) else None


# 上下文窗口真值（探针实测 Kimi 超限报错明说 262144；kimi-for-coding=256K）。窗口自校准的默认起点，
# 一旦从真超限报错学到别的（更小模型/账户降级）就落盘沿用（见 calibrate.py）。源头就夹取，坏配置不越界。
CONTEXT_WINDOW_TOKENS = _clamp_window(get_int("KIMI_CONTEXT_WINDOW_TOKENS", 262144))
# 压缩触发比：达真窗口这么大比例即压缩，留 (1-比例) 头寸给本轮回复+下轮增长。默认 0.75（业界惯例）。
# 夹到 [0.1, 0.95]：至少留 5% 头寸，别设成 ≥1 让 75% 闸失效必溢。
COMPACT_TRIGGER_RATIO = min(0.95, max(0.1, get_float("KIMI_COMPACT_TRIGGER_RATIO", 0.75)))
# 压缩触发的 token 预算（#13）：**显式设 KIMI_CONTEXT_BUDGET_TOKENS(>0) 则尊重覆盖**（回退旧行为/自定义），
# 否则由「真窗口 × 触发比」派生（262144×0.75=196608）——治「128000 对 262K 窗口过保守、白烧摘要」。
CONTEXT_BUDGET_OVERRIDE = _parse_budget_override(get("KIMI_CONTEXT_BUDGET_TOKENS", "").strip())
CONTEXT_BUDGET_TOKENS = CONTEXT_BUDGET_OVERRIDE if CONTEXT_BUDGET_OVERRIDE is not None \
    else int(CONTEXT_WINDOW_TOKENS * COMPACT_TRIGGER_RATIO)
# 5e 多 agent 旋钮：嵌套深度上限（默认 2，同现状）、并行 fan-out 上限（默认 4，控 ~15× token 放大）。
SUBAGENT_MAX_DEPTH = max(1, get_int("SUBAGENT_MAX_DEPTH", 2))
SUBAGENT_MAX_FANOUT = max(1, get_int("SUBAGENT_MAX_FANOUT", 4))
# 5b Reflexion 情节记忆开关（默认开）：关掉后 reflect_and_write / system_message 全链路短路，不写不注入。
EPISODIC_ENABLED = get("EPISODIC_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off")
# 经验层最轻一档 · 战术小抄开关（默认开）：关掉后 cheatsheet.add_tip / system_message 全链路短路，不写不注入。
CHEATSHEET_ENABLED = get("CHEATSHEET_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off")
# C1 ReAct 显式轨迹开关（默认开）：关掉后 memory.system_message 摘掉基座纪律⑤「先想后做」引导，
# 模型回到纯反应式工具循环；thought 仍照常进 history/日志（那是循环固有行为），只是不再主动引导。
REACT_ENABLED = get("REACT_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off")
