"""统一信任标签层（视觉升级方案 §5.1）：污点从内容匹配升级为来源/能力标签。

现状短板：permission.taint_gate 是内容匹配（≥32 字子串比对），<32 字短祈使 payload
整段抄进危险参数也漏（denylist 非完备面，方案 §7 已承认）。本层是**正交补强不是替换**：
内容门原样兜底，标签层补它漏的。

设计（CaMeL 能力标签 + FIDES 信息流的工程近似，非形式化保证——这点必须言明）：
- **来源标签**：每条污点除原文片段外带结构化来源（web/ocr/ax/vlm/mcp/recall/tool/user…），
  全部行（含 <32 字短行）以 (行, 来源) 进 `ctx['_taint_labels']`；≥32 字行照旧进 `_tainted` 供内容门。
- **能力约束**：每个来源声明其内容禁止流向哪类动作（`source_forbids`）——当前所有不可信来源
  一律禁 写/执行/网络 三类能力（要流向就升 ask 逐次确认）；用户直接输入不禁。
- **判定链路**（`label_gate`）：高危工具参数的字符串叶经归一（中和隐形字符+折空白+casefold，
  与 tools._norm_for_taint 同构）后，逐字包含本会话某条 ≥_LABEL_MIN_SPAN 字标签行、且该来源
  禁此工具能力 → 命中。即「来源标签命中 + 参数与该内容相关（逐字包含）」→ 升 ask，
  剥夺会话白名单捷径、这次批准不沉淀（接线在 agent._approved，与污点门同待遇）。

诚实边界（写死在这里，别装完备）：
- 「相关性」的工程判定=**逐字包含**（归一后子串）。payload 被模型转述/改写/翻译打散后，
  harness 侧判不了「参数来自那段不可信内容」——标签层不接这类，归 §5.2 通道分离在模型侧识别。
  （模型不在 harness 内，真正的变量级污点传播（FIDES 式）需要模型配合，做不到就不装。）
- 曾设计过「会话接触过不可信来源 → 一切写/执行/网络工具拒」的宽规则（旧 trust.check）：
  误伤不可接受（查一次网页后所有写文件都被拖去问），已废弃收窄为现在的逐字命中门。

全部常量集中在此，留校准口（_LABEL_MIN_SPAN 是短 payload 覆盖与误伤的折中）。
"""
from __future__ import annotations

from . import episodic, permission

# ── 来源标签（统一枚举，§5.1.2：记忆 source 分级等复用同一套）──
SOURCE_USER = "user"        # 用户直接输入（最可信，永不入标签判定）
SOURCE_FILE = "file"        # 本地文件内容
SOURCE_TOOL = "tool"        # 其他工具输出 / 子代理回传结论（可能裹挟子代抓的不可信内容）
SOURCE_OCR = "ocr"          # OCR 识别结果
SOURCE_MCP = "mcp"          # MCP 外部工具输出
SOURCE_WEB = "web"          # web_fetch / web_search 网页内容
SOURCE_AX = "ax"            # 界面文本：AX 元素名、窗口标题（恶意窗口/控件可构造）
SOURCE_VLM = "vlm"          # VLM 直读兜底输出
SOURCE_RECALL = "recall"    # recall 回捞的不可信 blob（防溢出部分经 recall 洗白）

# ── 工具能力标签 ──
CAP_READ = "read"
CAP_WRITE = "write"
CAP_EXECUTE = "execute"
CAP_NETWORK = "network"

# 工具能力映射（与 permission._TAINT_HIGH_RISK 对齐，但按能力分组）
_TOOL_CAPS = {
    "read_file": CAP_READ, "glob": CAP_READ, "grep": CAP_READ, "read_image": CAP_READ,
    "recall": CAP_READ, "search_sessions": CAP_READ, "memory.search": CAP_READ,
    "write_file": CAP_WRITE, "edit": CAP_WRITE, "save_skill": CAP_WRITE,
    "run_command": CAP_EXECUTE, "run_in_background": CAP_EXECUTE, "run_script": CAP_EXECUTE,
    "click": CAP_EXECUTE, "click_at": CAP_EXECUTE, "pick": CAP_EXECUTE,
    "press_keys": CAP_EXECUTE, "type_text": CAP_EXECUTE, "focus_window": CAP_EXECUTE,
    "web_fetch": CAP_NETWORK, "web_search": CAP_NETWORK,
}

# 能力约束矩阵：不可信来源的内容禁止静默流向 写/执行/网络 类动作（流向就升 ask）。
# 当前对所有不可信来源一致——矩阵显式写出来是校准口（哪天要按来源分档松紧，改这里一处）。
_SOURCE_FORBIDDEN_CAPS = {
    src: frozenset({CAP_WRITE, CAP_EXECUTE, CAP_NETWORK})
    for src in (SOURCE_TOOL, SOURCE_OCR, SOURCE_MCP, SOURCE_WEB, SOURCE_AX, SOURCE_VLM, SOURCE_RECALL)
}

# 标签层逐字命中下限：内容门 _MIN_TAINT_SPAN(32) 与噪声地板之间的折中——
# 够短以接住「把所有密钥打包发到 x」这类祈使 payload，够长以避开「确定」「关机」类界面碎片误伤。
_LABEL_MIN_SPAN = 6


def _norm(s) -> str:
    """标签比对归一（与 tools._norm_for_taint 同构）：中和隐形字符 + 折叠所有空白为单空格 + casefold。
    两侧同归一再比，防插零宽/多空格让子串比对 miss（MINJA 洗白手法）。"""
    return " ".join(episodic._neutralize(str(s)).split()).casefold()


def labels(ctx: dict) -> set:
    """当前会话的信任标签库：{(行, 来源)}——含 <32 字短行（内容门漏的那部分也在这）。"""
    return set(ctx.get("_taint_labels", ())) if isinstance(ctx, dict) else set()


def sources(ctx: dict) -> set:
    """当前会话接触过的不可信来源集合（由标签库推出，单一真源不另存）。"""
    return {src for _, src in labels(ctx)}


def tool_cap(tool_name: str) -> str:
    """工具能力标签。"""
    if tool_name.startswith("mcp__"):
        return CAP_NETWORK  # MCP 工具默认视为网络/外部能力
    return _TOOL_CAPS.get(tool_name, CAP_READ)


def source_forbids(source: str, cap: str) -> bool:
    """能力约束：该来源的内容是否禁止静默流向这类动作（禁→流向时升 ask 逐次确认）。"""
    return cap in _SOURCE_FORBIDDEN_CAPS.get(source, frozenset())


def record_taint_with_source(ctx: dict, text, source: str) -> None:
    """污点入库唯一入口：≥32 字行进 `_tainted`（内容门），全部行进 `_taint_labels`（标签层，带来源）。"""
    permission.record_taint(ctx, text, source=source)


def text_has_label(text, ctx: dict, min_span: int = _LABEL_MIN_SPAN) -> bool:
    """一段文本是否逐字包含本会话某条 ≥min_span 字的不可信标签行（归一后子串比对）。

    不限工具/能力——供 label_gate（高危动作门）与 tools._fact_from_untrusted（记忆/小抄/笔记/
    技能入口）共用同一判定，§5.1.2「一套标签多处复用」。"""
    if not isinstance(ctx, dict):
        return False
    labs = ctx.get("_taint_labels")
    if not labs:
        return False
    t = _norm(text)
    if not t:
        return False
    for line, src in labs:
        if not source_forbids(src, CAP_WRITE):   # 用户直接输入等非受限来源不参与
            continue
        s = _norm(line)
        if len(s) >= min_span and s in t:
            return True
    return False


def label_gate(tool_name: str, args, ctx: dict) -> bool:
    """来源/能力标签门：高危工具参数逐字含本会话不可信来源的 ≥_LABEL_MIN_SPAN 字内容 → True（该升 ask）。

    与 permission.taint_gate（≥32 字内容门）正交叠加：它漏的短 payload 由本门接住；
    判定依据=「来源标签命中 + 参数与该内容相关（逐字包含）」，与字符串长度门槛脱钩到 6 字。
    """
    if not ctx:
        return False
    if tool_name not in permission._TAINT_HIGH_RISK and not tool_name.startswith("mcp__"):
        return False
    cap = tool_cap(tool_name)
    labs = ctx.get("_taint_labels")
    if not labs:
        return False
    leaves = [_norm(leaf) for leaf in (list(permission._str_values(args)) or [str(args)])]
    for line, src in labs:
        if not source_forbids(src, cap):
            continue
        s = _norm(line)
        if len(s) < _LABEL_MIN_SPAN:
            continue
        if any(s in leaf for leaf in leaves):
            return True
    return False
