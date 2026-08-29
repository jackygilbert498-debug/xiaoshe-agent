"""权限闸门（阶段1）：一条有序策略链，首个命中即定；决议三态 approve / deny / ask。

照 Kimi 的 permission 思路：
- 默认不信任——没在只读白名单里的工具，一律先问你（ask）。
- 只读、无副作用工具（read_file）白名单放行（approve）。
- 敏感资源（.env / 私钥 / credentials）和越出工作区的路径是**硬护栏**——直接拒（deny），
  连问都不问；即使是"读"也拒，防把密钥喂给模型。

工作区根 ROOT 默认 = 整个仓库目录；测试可 patch 本模块的 ROOT 换成临时目录。
"""
from __future__ import annotations

import contextlib
import contextvars
import os
import re
from dataclasses import dataclass, replace
from pathlib import Path

from . import config

# 污点闸门：高危工具的参数原样含够长的不可信文本时升级为 ask。
# 含原生 UI 动作工具（click/press_keys/focus_window）——它们能驱动整机键鼠，绝不能让界面注入文本经会话白名单洗白后
# 静默驱动（对抗审查确认：不覆盖则一次 'a' 后 press_keys 成为免污点复问的任意输入通道）。
_TAINT_HIGH_RISK = ("run_command", "run_in_background", "write_file", "edit", "click", "click_at", "pick", "press_keys", "type_text",
                    "focus_window", "screenshot",   # 红队 F1：screenshot 也写盘（模型逐字把不可信 OCR/网页文本当 path→静默覆盖），补齐
                    "propose_tool")   # A2b：提案代码整段抄自不可信源 → 提案时就升 ask 点醒人（纵深，不只靠批准时看代码）
_MIN_TAINT_SPAN = 32  # 太短的片段易误伤，只认够长的不可信文本


def record_taint(ctx, text, source: str = None) -> None:
    """把一段不可信文本按行记入 ctx['_tainted']（够长的行才认）。MCP/网页/OCR 输出、溢出全文、recall 回捞都走它，
    保证"不可信内容的每一段"都在污点集里——别只污点预览窗、让溢出部分经 recall 洗白（对抗审查逮出的回归）。

    S4 统一信任标签层：带 source 调用时，**全部行**（含 <_MIN_TAINT_SPAN 的短行）以 (行, 来源) 另记
    ctx['_taint_labels']——内容门（taint_gate）只认长行，来源/能力标签门（trust.label_gate）靠短行
    接住内容门漏掉的 <32 字 payload；两者叠加不是替换。来源枚举与能力约束见 trust.py。"""
    if ctx is None:
        return
    for line in str(text).splitlines():
        line = line.strip()
        if not line:
            continue
        if len(line) >= _MIN_TAINT_SPAN:
            ctx.setdefault("_tainted", set()).add(line)
        if source is not None:
            ctx.setdefault("_taint_labels", set()).add((line, source))

ROOT = config.ROOT.resolve()

# 工作区根的"上下文覆盖"（#33）：无头 --workdir / 子 agent 切根时用它，而非改全局 ROOT——
# contextvar 每线程/每上下文各持一份，嵌套用 token 复位，异常路径也稳，绝不把边界串给别的上下文。
_root_override: contextvars.ContextVar = contextvars.ContextVar("harness_root_override", default=None)


def active_root() -> Path:
    """当前生效的工作区根：上下文覆盖优先，否则模块级 ROOT。每次都 resolve、不缓存（保 symlink/patch 正确）。"""
    ov = _root_override.get()
    return Path(ov if ov is not None else ROOT).resolve()


@contextlib.contextmanager
def use_root(path):
    """在本上下文内把工作区根临时切到 path（不动全局 ROOT）；退出（含异常）自动复位。"""
    token = _root_override.set(Path(path).resolve())
    try:
        yield
    finally:
        _root_override.reset(token)

# 无头运行上下文（D3 P2-5）：无用户在场，ask 决议无人可答。None=不在无头模式（交互语义不变）。
# contextvar 与 _root_override 同理：每上下文各持一份，绝不把无头语义串给别的上下文（如交互 repl）。
_headless_allow: contextvars.ContextVar = contextvars.ContextVar("harness_headless_allow", default=None)


@contextlib.contextmanager
def headless_mode(allow):
    """在本上下文内标记「无头模式 + --allow 白名单」：白名单外的 ask 如实落成 deny（审批策略拒绝）。
    注意只装裱话术/决议形态，不放松任何硬护栏；白名单内工具的普通 ask 保留给会话白名单捷径。"""
    token = _headless_allow.set(frozenset(allow))
    try:
        yield
    finally:
        _headless_allow.reset(token)


def is_headless() -> bool:
    """当前上下文是否在无头模式（headless_mode 内）——公开访问器。

    消费方（agent 的拒绝话术归因等）一律走它，别直探 _headless_allow 私有 var
    （私有 var 保留为唯一真源，本访问器只包它、不改语义）。"""
    return _headless_allow.get() is not None

# 安全工具（只读 / 只改会话内状态 / 只写 agent 自己的记忆文件 / 派分身——分身内部危险操作各自过闸门）：
# 直接放行，不打扰用户。
SAFE_TOOLS = {"read_file", "update_todos", "note", "remember", "note_tip", "spawn_subagent", "check_background", "list_background",
              "glob", "grep",     # A5：只读搜文件名/内容，只在 ROOT 内、跳敏感文件（grep 不泄漏 .env 内容），同 read_file 级别
              "read_skill",       # A2a：只读取一份已存技能全文（照技能做时里面的危险动作仍各自过审批）
              "recall",           # recall 只回捞本会话已采集字节、不新增采集、只收 ref 不收路径（接口层免穿越）
              "read_image",       # read_image 只读工作区内文件（safe_path 拒越界/敏感）、只加载给模型看，同 read_file 级别
              "ocr",              # ocr 只读工作区内图片（path 硬护栏拒越界/敏感）、只把图里文字读成文本（不泄文件内容），同 read_image 级别
              "spawn_parallel",   # 5e：并行分身内部各自过闸门（且强制非交互 approver 自动拒危险），派活本身不危险
              "recall_subagent",  # 5e：只读进程内子结论共享区
              "propose_tool"}     # A2b：提案只写待审草稿、无任何效力——真正的门在 :approve 人审那一刻，别让用户批两道

# A2b：本会话装载的自定义工具（人审批准+哈希校验过、沙箱执行）→ 免问执行。
# 只由 tools.load_user_tools/unload_user_tools 在会话初/收尾设置，随字节冻结——中途批准的不进这里。
_USER_TOOL_SAFE: set = set()


def set_user_tool_safe(names) -> None:
    """整体替换免问自定义工具集（会话初装载时设置一次；传空即清空）。"""
    _USER_TOOL_SAFE.clear()
    _USER_TOOL_SAFE.update(names)

# 敏感文件名（小写）：即使是"读"也硬拒。
_SENSITIVE_NAMES = {"id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "credentials", "secrets.json", "mcp.json",
                    "hooks.json"}   # A6：hooks 配置模型读写不了——否则注入=任意命令执行（命根子）
_SENSITIVE_SUFFIXES = (".pem", ".key", ".env")   # *.env 后缀(app.env/config.env)也是密钥载体（审查 LOW；.env.example 由豁免挡）
_SENSITIVE_EXEMPT = {".env.example"}  # 显式豁免，与敏感判定解耦，避免后续改动引入前缀绕过
# 敏感文件名前缀：连改名规避变体一起拦（id_rsa.bak / credentials.old / secrets.json.save …）
_SENSITIVE_PREFIXES = ("id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "credentials", "secrets")

# run_command 命令文本里出现这些密钥类片段一律硬拒——run_command 走 shell，permission 对它
# 内部引用的路径不设防，靠扫命令文本堵住"批准一次即 type .env 泄漏密钥"这条路。
# state/schedule：定时任务档案目录（M3）——agent 改它=给未来的自己扩权，与 mcp.json 同级设防。
# 词边界组：加尾部词边界，治 .env 误伤 .environment、credentials 误伤 credentialstore；
# 但真 app.env / .env.local / credentials.json 仍拦（尾部是 . / 空白 / 行尾都算边界）。
_CMD_WB_TOKENS = (".env", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
                  "credentials", "secrets.json", "mcp.json", "hooks.json",   # A6：hooks 配置=命根子，命令文本也硬拒（防 echo> 绕 path 闸）

                  # 常见凭据文件（.git-credentials 已被 "credentials" 覆盖；.config 太宽会误伤 git config 故不收）：
                  ".aws", ".netrc", ".npmrc", ".pypirc", ".pgpass", ".dockercfg", ".gnupg")
# 子串强匹配组：目录/后缀类，误伤风险低、且要连改名变体一起拦。
# state/schedule：定时任务档案目录（M3）——agent 改它=给未来的自己扩权，与 mcp.json 同级设防。
_CMD_SUBSTR_TOKENS = (".pem", ".key", ".ssh", "state/schedule", "state\\schedule",
                      "state/hooks.json", "state\\hooks.json",   # A6：.state/hooks.json 目录路径写法也硬拒
                      "state/user_tools", "state\\user_tools",    # A2b：工具注册表——命令文本也硬拒，防 echo> 绕 path 闸
                      "state/undo", "state\\undo")                # 文件级 undo 栈——命令文本也硬拒，防 echo> 篡改栈

# 与 _is_sensitive 对齐的凭据集（#1 漂移修复）：dotfile 前缀 + 整目录设防，杜绝同批文件走 read_file 零审批读凭据。
_SENSITIVE_DOTFILE_PREFIXES = (".env", ".netrc", ".npmrc", ".pypirc", ".pgpass", ".dockercfg", ".git-credentials")
_SENSITIVE_DIRS = (".ssh", ".aws", ".gnupg")
# 通配符绕过检测覆盖**全部**敏感 token（含命根子 hooks.json/mcp.json、凭据 credentials/secrets、state/ 目录）。
# 前缀下限按 token 类型分档，见 _glob_floor（dotfile=2 / 路径类=分隔符后 / 其余长词=4）。
# （不能对全部 token 一刀切 range(4,)：`.env`(长4) 会落空范围、`.e*` 反而漏——A6增量2 红队 HIGH 教训。）
_GLOB_TOKENS = _CMD_WB_TOKENS + _CMD_SUBSTR_TOKENS
_GLOB_META = re.compile(r"[*?\[]")


def _glob_floor(tok: str) -> int:
    """通配前缀下限（决定攻击者最多能把 token 尾部截掉多少再接 `*`）：
    - dotfile/id_ 类（前缀短又敏感）=2：`.e*`/`id_rs?` 要拦；
    - 含路径分隔符的 token（`state/schedule` 等）=「最后一个分隔符 +2」：让公共词干 `state`/`state/` 单独**不**匹配，
      杜绝 `docs/state*` 误伤；只有 `.state/schedul*` 这类深前缀才拦（`.state/*` 整目录 glob 仍是已知 best-effort 缺口）；
    - 其余长词 token=4：避 `cr*`/`mc*`/`se*` 短前缀误伤良性 glob。"""
    if tok.startswith((".", "id_")):
        return 2
    sep = max(tok.rfind("/"), tok.rfind("\\"))
    return sep + 2 if sep >= 0 else 4


# H2 去混淆：shell 引号/反引号/^ 插入符/反斜杠转义不改变执行语义，却能把 .env 拆成 .e''nv/.e^nv/`.e`nv`/.e\nv
# 躲过字面扫描。扫描前剥掉这些「零效字符」，让 _cmd_hits 也扫到还原后的命令。
# 剥 `\` 会让 state\schedule 折成 stateschedule 而漏——但那是 SUBSTR token，raw 路径（_cmd_hits 原串）已兜住，故安全。
# 诚实边界：`-join`/[char] 数组拼接、换行分隔的写文件再执行等仍绕得过（治本在 batch1a 指纹白名单 + 基M2）。
_FOLD_CHARS = str.maketrans({c: None for c in "'\"`^\\"})

# H2 解码-执行管道：解码原语(base64/openssl/certutil/FromBase64String) 与 执行原语(管道进解释器/iex) 顺序无关地共现
# → 混淆执行信号。去混淆挡不住，但命中不硬拒（可能是合法安装脚本）而是 force_ask、剥夺会话白名单（见 Decision.force_ask）。
_DECODE_KW = re.compile(r"base64|openssl\s+enc|certutil|frombase64string|frombase64", re.I)
_EXEC_KW = re.compile(r"\|\s*(sh|bash|zsh|python3?|node|eval)\b|\bi?ex\b|\binvoke-expression\b", re.I)


def _defold(cmd: str) -> str:
    """去引号折叠：剥掉 shell 里不改变执行语义的零效字符（引号/反引号/^/\\），供扫描还原后的命令。"""
    return (cmd or "").translate(_FOLD_CHARS)


def _obfuscated_exec(cmd: str) -> bool:
    """命令是否含「解码原语 + 执行原语」共现（顺序无关，含去折叠后）——混淆执行管道，force_ask 用。"""
    for c in (cmd or "", _defold(cmd or "")):   # 扫原串 + 去折叠串：ba''se64 折叠后才现出 base64
        if _DECODE_KW.search(c) and _EXEC_KW.search(c):
            return True
    return False


def _cmd_hits_folded(cmd: str) -> bool:
    """扫原串 + 去引号折叠后的串——两者任一命中敏感 token 即算命中（H2）。"""
    return _cmd_hits(cmd) or _cmd_hits(_defold(cmd))


def _touches_state_dir(cmd: str) -> bool:
    """命令是否触达 .state 内部状态目录（含工具注册表/定时任务档案等命根子）→ 强制 force_ask。

    对抗审查#1（MED）：run_command 不把 command 当路径扫（只字面子串），运行时拼路径
    $d=Join-Path ".state" (...) 能绕过 `state/user_tools` 完整字面。但拼路径最终仍要出现 `.state`
    这四字符——故折叠去引号后扫 `.state` 子串即中（抓住实测 PoC）。命中→force_ask：即便 --allow
    run_command 在会话白名单也重问，无人值守 approver 恒拒=断掉「拼路径植入 active/manifest」攻击链。
    best-effort（连 .state 都拆成 [char]46 拼的极端混淆会落到 _obfuscated_exec 或变得高度可疑）；
    完美需 OS 级只读 ACL——.state 是 harness 内部状态，正常任务命令几乎不碰它，误伤面小。"""
    return ".state" in _defold(cmd or "")


def _cmd_hits(cmd: str) -> bool:
    """命令文本（调用方已 lower）是否命中敏感 token：WB 组要尾部词边界，子串组照旧强匹配；
    再加一层 shell 通配符绕过检测（best-effort，非强隔离）：敏感 dotfile/id_ token 的前缀紧跟 * ? [ 也拦（.e*/.en?/id_rs?）。"""
    if any(tok in cmd for tok in _CMD_SUBSTR_TOKENS):
        return True
    if any(re.search(re.escape(tok) + r"(?![a-z0-9_])", cmd) for tok in _CMD_WB_TOKENS):
        return True
    # shell 先做通配展开，令 .env 的字面被 .e*/.en?/.e[n] 代替而躲过上面的字面扫描——对症拦（对抗审查 #3，宁可多拒）。
    if _GLOB_META.search(cmd):
        for tok in _GLOB_TOKENS:
            for L in range(_glob_floor(tok), len(tok)):
                if re.search(re.escape(tok[:L]) + r"[*?\[]", cmd):
                    return True
    return False


_SENDKEYS_BRACE = re.compile(r"\{([^}]*)\}")


def _expand_sendkeys_brace(m) -> str:
    """把一个 {..} SendKeys 组还原成它实际敲出的字面串：{X}/{+}/{{} 单字符转义→该字面字符；
    {X N} 重复语法→X 重复 N 次（{h 10}=hhhhhhhhhh）；命名功能键 {ENTER}/{LEFT}/{F5}→零宽删除。"""
    raw = m.group(1)
    parts = raw.split()
    if not parts:                        # {} 空 / { } 纯空白：单空格保留、其余删
        return " " if raw == " " else ""
    head = parts[0]
    if len(head) == 1:                   # 单字符 = 会真敲出的字面字符（可带重复数）
        n = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 1
        return head * min(n, 500)        # cap 防构造超长串
    return ""                            # 命名功能键：零宽，删


def _flatten_sendkeys(keys: str) -> str:
    """把 SendKeys 串近似成"实际会敲出的字面串"，供 _cmd_hits 扫（防花括号/净零键拆分敏感 token 绕过）。

    对抗审查坐实两类绕过：① {LEFT}{RIGHT} 净零光标键把 .env 拆成 .e{LEFT}{RIGHT}nv；② {n 1}/{h 10} 产字符组
    删掉后字符丢失但 SendKeys 仍敲出（.e{n 1}v→.env）。故按 SendKeys 语义**展开产字符组**、只删零宽功能键，再剥裸修饰符 ^%+()~。"""
    s = _SENDKEYS_BRACE.sub(_expand_sendkeys_brace, keys or "")
    return s.translate({ord(c): None for c in "^%+()~"})


@dataclass
class Decision:
    action: str  # "approve" | "deny" | "ask"
    reason: str = ""
    force_ask: bool = False  # ask 决议：即使本会话白名单里有该工具也必重新问（防混淆命令被 'always' 静默放行，H2）
    # Beta 审计字段只记录裁决摘要，不保存工具参数、路径或用户文本。
    code: str = "PERMISSION_POLICY"
    raw_action: str | None = None
    context_hash: str | None = None

    def with_audit(self, *, raw: "Decision", context_hash: str, code: str | None = None) -> "Decision":
        return replace(self, raw_action=raw.action, context_hash=context_hash, code=code or self.code)


class PathError(Exception):
    """路径越界或命中敏感文件时抛出（工具执行层的硬护栏）。"""


def _win32_equiv(name: str) -> str:
    """Win32 文件名等价归一：剥掉一段尾部的 '.' 与空格。

    Windows 建/开文件时会**静默**剥掉每个路径段尾部的点和空格，故 `.state.`/`.env `/`secret.pem ` 落盘即
    `.state`/`.env`/`secret.pem`。敏感判定若按字面比对就漏这族等价变体（实测：无 `.state` 目录时 resolve 不归并、
    `.state./approvals.json` 逃过 `".state" in parts` → 静默写审计账本/放行清单）。比对前对每段做同样剥离堵住它。
    刻意不按 os 分平台：POSIX 上 `.state.` 是另一个目录、归一至多**多拦**一个畸形裸名（deny 侧过严无害），
    却让跨平台同步/CI 任一环境都没有这道窗口。"""
    return name.rstrip(". ")


def _sensitive_form(parts: list, name: str) -> bool:
    """单形态敏感判定（parts 已小写、name 已小写）。豁免只对**该形态自身**成立——
    `.env.example` 豁免、`.env.example.` 不豁免（后者字面命中 dotfile 前缀）。"""
    if any(part in _SENSITIVE_DIRS for part in parts):  # .ssh/.aws/.gnupg 整目录设防（与 _cmd_hits 对齐，#1 漂移修复）
        return True
    if ".state" in parts:   # 红队 F3：.state 整个 harness 内部状态树设防（注册表/账本 effects.jsonl/undo 栈/blobs/approvals/会话档）——
        # 模型经文件工具没有正当理由读写它（harness 自身写 .state 走 _io 直连 Path、不过 safe_path，不受影响）；
        # 与 run_command 的 _touches_state_dir 对齐（那边 force_ask、这边更严直接 deny）。原只拦 schedule/user_tools/undo 三子目录、漏了账本。
        return True
    if name in _SENSITIVE_EXEMPT:  # 显式豁免（.env.example 等）
        return False
    if name.endswith(".pub"):  # 公钥豁免：真 SSH 公钥(id_* 系)不敏感；credentials.pub/secrets.pub 是伪装，不豁免
        return name.startswith(("credentials", "secrets"))
    if name.startswith(_SENSITIVE_PREFIXES):  # id_rsa/credentials/secrets 及其改名规避变体
        return True
    if name in _SENSITIVE_NAMES or name.endswith(_SENSITIVE_SUFFIXES):
        return True
    if name.startswith(_SENSITIVE_DOTFILE_PREFIXES):  # .env/.netrc/.npmrc/.pypirc/.pgpass/.dockercfg/.git-credentials 及改名变体（.env.example 已豁免）
        return True
    return False


def _is_sensitive(p: Path) -> bool:
    # 刻意比 Kimi 更严：敏感文件一律 deny（连问都不问），而非 Kimi 的 ask——符合"不读代码也不怕被诱导泄密"的定位。
    if ":" in p.name:  # NTFS 交替数据流(.env:stream)/冒号技巧——一律当敏感拒掉（原始名判，冒号不受尾部归一影响）
        return True
    # 并集判定：字面容 ∨ Win32 归一容，任一敏感即拒——归一只能**加拦**不能**放宽**：
    # `.env.example.`（POSIX 上是独立文件，可能是攻击者摆放）字面命中 dotfile 前缀照样拒，不许归一成豁免名放行。
    lit_parts = [x.lower() for x in p.parts]
    eq_parts = [_win32_equiv(x) for x in lit_parts]   # 每段 Win32 等价归一（堵 `.state.`/`.ssh ` 尾点/空格变体）
    return (_sensitive_form(lit_parts, p.name.lower())
            or _sensitive_form(eq_parts, _win32_equiv(p.name.lower())))


def _root() -> Path:
    # ROOT 可能是未展开的路径（macOS 下 /var 是 /private/var 的符号链接；测试也会 patch 进临时目录）。
    # 判定一律用展开后的根，避免"文件路径展开了、根没展开"的误判越界。
    # 刻意每次都 resolve、不缓存：缓存会破坏测试 patch，也会在链接变化时留下过期判定。
    # 走 active_root()：上下文有 use_root 覆盖就用覆盖，否则回退模块 ROOT（#33）。
    return active_root()


def _within_root(p: Path) -> bool:
    try:
        p.relative_to(_root())
        return True
    except ValueError:
        return False


def resolve(path_str: str) -> Path:
    if not isinstance(path_str, str):
        raise ValueError("路径必须是字符串")
    if any(ord(ch) < 32 for ch in path_str):
        raise ValueError("路径含控制字符")
    p = Path(path_str)
    if not p.is_absolute():
        p = _root() / p
    return p.resolve()


def safe_path(path_str: str) -> Path:
    """解析并校验路径（工具执行前再兜一层）：越界或敏感直接抛 PathError。"""
    if not isinstance(path_str, str):
        raise PathError("路径必须是字符串")
    # Treat Windows separators and drive-qualified paths as hostile on every
    # host.  Otherwise a payload rejected on Windows (``..\\secret``) becomes
    # a harmless-looking filename on macOS and can later escape after syncing.
    if os.name != "nt" and re.match(r"^[A-Za-z]:[\\/]", path_str):
        raise PathError("Windows 盘符路径不允许跨工作区输入")
    p = resolve(path_str.replace("\\", "/"))
    if not _within_root(p):
        raise PathError(f"路径越出工作区 ROOT：{p}")
    if _is_sensitive(p):
        raise PathError(f"敏感文件，禁止访问：{p.name}")
    return p


_DRIVE_RE = re.compile(r"^[A-Za-z]:[\\/]")       # Windows 盘符前缀 C:\ / D:/
_URL_RE = re.compile(r"^(https?|ftp)://", re.I)  # URL 不是路径


def _looks_like_path(s) -> bool:
    """粗判一个字符串像不像路径：含分隔符 / 盘符 / 敏感裸名都算；URL 排除。

    刻意保守，别把随手的字符串都当路径去 resolve（#7 的坑：run_command 的 command 必须另行豁免）。
    """
    if not isinstance(s, str) or not s or _URL_RE.match(s):
        return False
    if "/" in s or "\\" in s or _DRIVE_RE.match(s):
        return True
    return _is_sensitive(Path(s))  # 无分隔符的敏感裸名（.env / id_rsa / *.pem …）也算


# 内容类参数名（大小写无关）：值是代码/正文而非路径——代码里冒号（dict/注解）、C:\ 盘符、反斜杠是常态。
# D3 P0-1：write_file 的 content 无斜杠含冒号时被 _is_sensitive 的 NTFS ADS 规则误判「敏感文件」硬拒致死，
# 故这些键的整棵子树豁免路径形态扫描；路径类参数（path/file/target/…）照扫不误。
_CONTENT_PARAM_KEYS = frozenset({"content", "text"})
_PATH_PARAM_KEYS = frozenset({
    "path", "paths", "file", "files", "filename", "target", "targets",
    "src", "dst", "dest", "destination", "dir", "directory", "folder",
    "root", "input_path", "output_path",
})


def _iter_pathlike(args, _depth: int = 0, _path_hint: bool = False):
    """递归(限深 4)从 args 里 yield 出所有像路径的字符串——覆盖别名(file/target/dst)与嵌套。

    F36：限深从 2 抬到 4，与污点扫描 _str_values 对齐——否则 MCP 深层嵌套 path 逃过敏感/越界硬拒。
    D3 P0-1：content/text 键豁免——正文不是路径，别拿 NTFS ADS 规则往代码上套。
    路径类别名提供显式提示，不能要求畸形路径先带斜杠才进入硬护栏。"""
    if _depth > 4:
        return
    if isinstance(args, dict):
        for k, v in args.items():
            key = k.casefold() if isinstance(k, str) else ""
            if key in _CONTENT_PARAM_KEYS:
                continue
            yield from _iter_pathlike(
                v, _depth + 1, _path_hint=key in _PATH_PARAM_KEYS)
    elif isinstance(args, (list, tuple)):
        for v in args:
            yield from _iter_pathlike(v, _depth + 1, _path_hint=_path_hint)
    elif isinstance(args, str) and (_path_hint or _looks_like_path(args)):
        yield args


def _str_values(args, _depth: int = 0):
    """递归(限深 4)从 args 里 yield 出所有字符串**原值**（不转义）——污点比对用，别拿 json 文本比。"""
    if _depth > 4:
        return
    if isinstance(args, str):
        yield args
    elif isinstance(args, dict):
        for v in args.values():
            yield from _str_values(v, _depth + 1)
    elif isinstance(args, (list, tuple)):
        for v in args:
            yield from _str_values(v, _depth + 1)


def check(tool_name: str, args: dict) -> Decision:
    """决定某次工具调用该 放行 / 拒绝 / 问用户。"""
    d = _check(tool_name, args)
    allow = _headless_allow.get()
    if d.action == "ask" and allow is not None and (d.force_ask or tool_name not in allow):
        # D3 P2-5：无头模式没有用户可问——白名单外的 ask 注定被恒拒，如实落成 deny 并把话说清
        # （审批策略拒绝 + 指向 --allow），别让 agent 层谎称「用户拒绝了」误导模型归因。
        # 白名单内工具的**普通** ask 保留：agent._approved 的会话白名单捷径还要靠它放行（污点闸也挂在那条路上）。
        if tool_name in allow:
            reason = (f"无头模式无用户在场，本次调用被标记必须逐次确认（{d.reason}）——"
                      "审批策略拒绝，--allow 白名单放不过必须逐次确认的调用")
        else:
            reason = (f"无头模式无用户在场，{tool_name} 不在本次 --allow 白名单——"
                      f"审批策略拒绝（确需放行请用 --allow {tool_name} 重跑）")
        return Decision("deny", reason)
    return d


def _check(tool_name: str, args: dict) -> Decision:
    """check 的决策主体（无头话术装裱在 check 里）。"""
    # 1) 硬护栏：带 path 的工具先查越界/敏感
    path = args.get("path") if isinstance(args, dict) else None
    if isinstance(path, str) and path:
        try:
            p = resolve(path)
        except (OSError, ValueError):   # F28：畸形路径（null 字节等）别崩掉权限闸门，一律 deny
            return Decision("deny", f"路径非法，已拒绝：{path[:80]}")
        if not _within_root(p):
            return Decision("deny", f"路径越出工作区：{p}")
        if _is_sensitive(p):
            return Decision("deny", f"敏感文件禁止访问：{p.name}")
    # 1.1) 别名/嵌套路径参数也过同一道硬护栏（#7）——只对文件类工具(read/write/MCP)，
    #      run_command 的 command 不当路径扫（否则带 ../ 的正常命令会从 ask 静默退化成 deny）。
    if tool_name in ("read_file", "write_file") or tool_name.startswith("mcp__"):
        for cand in _iter_pathlike(args):
            try:
                p = resolve(cand)
            except (OSError, ValueError):
                return Decision("deny", f"路径非法，已拒绝：{str(cand)[:80]}")
            if not _within_root(p):                      # 越界优先于敏感，reason 可复现
                return Decision("deny", f"路径越出工作区：{p}")
            if _is_sensitive(p):
                return Decision("deny", f"敏感文件禁止访问：{p.name}")
    # 1.5) run_command：扫命令文本，命中密钥类敏感片段 → 硬拒（shell 命令绕不过这道）
    if tool_name in ("run_command", "run_in_background"):
        cmd = str(args.get("command", "")).lower() if isinstance(args, dict) else ""
        if _cmd_hits_folded(cmd):                                 # H2：去引号折叠后再扫（.e''nv→.env）
            return Decision("deny", "命令疑似访问密钥/敏感文件，已拒绝")
        if _obfuscated_exec(cmd):                                 # H2：解码-执行混淆管道 → 强制问（不硬拒，防误伤合法安装脚本）
            return Decision("ask", "命令含解码后执行的混淆管道，需你逐次确认", force_ask=True)
        if _touches_state_dir(cmd):                               # #1：触达 .state 内部状态目录 → force_ask（无人值守=拒），堵拼路径植入注册表
            return Decision("ask", "命令触达 .state 内部状态目录（含工具注册表等），需你逐次确认", force_ask=True)
    # 1.6) press_keys：键盘可往终端敲命令，是 run_command 的超集能力面——同样扫按键文本里的密钥/敏感特征硬拒
    #      （对抗审查确认：否则 focus_window(终端)+press_keys('Get-Content .env{ENTER}') 可绕过 run_command 这道硬护栏）。
    if tool_name == "press_keys":
        keys = str(args.get("keys", "")).lower() if isinstance(args, dict) else ""
        flat = _flatten_sendkeys(keys)
        # 扫原串 + 扫剥掉 SendKeys 特殊键后的"实际敲出串"：防 .e{LEFT}{RIGHT}nv 这种插入净零光标键拆分敏感 token 绕过
        # H2：再叠去引号折叠（.e''nv），SendKeys 展开串同样去折叠
        if _cmd_hits_folded(keys) or _cmd_hits_folded(flat):
            return Decision("deny", "按键内容疑似敲入访问密钥/敏感文件的命令，已拒绝")
        if _obfuscated_exec(keys) or _obfuscated_exec(flat):     # H2 复审：注文本是 run_command 旁路，解码执行管道同样 force_ask
            return Decision("ask", "按键内容含解码后执行的混淆管道，需你逐次确认", force_ask=True)
        if _touches_state_dir(keys) or _touches_state_dir(flat):  # #1：注 .state 命令是 run_command 旁路，同样 force_ask
            return Decision("ask", "按键内容触达 .state 内部状态目录，需你逐次确认", force_ask=True)
    # 1.6b) type_text：与 press_keys 同为「往最前窗口注文本」通道 → 同样硬扫，堵
    #       type_text('Get-Content .env')+press_keys('{ENTER}') 拆两步绕过 run_command 硬护栏（{ENTER} 单独不含敏感 token）。
    if tool_name == "type_text":
        text = str(args.get("text", "")).lower() if isinstance(args, dict) else ""
        if _cmd_hits_folded(text):                               # H2：去引号折叠后再扫
            return Decision("deny", "输入文本疑似访问密钥/敏感文件的命令，已拒绝")
        if _obfuscated_exec(text):                               # H2 复审：注文本旁路，解码执行管道同样 force_ask
            return Decision("ask", "输入文本含解码后执行的混淆管道，需你逐次确认", force_ask=True)
        if _touches_state_dir(text):                             # #1：注 .state 命令是 run_command 旁路，同样 force_ask
            return Decision("ask", "输入文本触达 .state 内部状态目录，需你逐次确认", force_ask=True)
    # 1.7) web_fetch：SSRF 硬护栏——只放行公网 http(s)，拒 file:///localhost/内网/云元数据 IP（决策层硬拒，'a' 后也不放）
    if tool_name == "web_fetch":
        from . import web
        if not web.is_safe_url(str(args.get("url", "")) if isinstance(args, dict) else ""):
            return Decision("deny", "URL 不安全（内网/环回/云元数据/非 http），已拒绝")
    # 1.8) screenshot：读屏+写盘——审批文案说清隐私面（主屏所有可见窗口都会进图），别只给裸工具名让用户盲批
    if tool_name == "screenshot":
        return Decision("ask", "要把主显示器整屏截图存盘（屏幕上所有可见窗口的内容都会进图）")
    # 1.9) look：读屏（整屏截图+AX+OCR，内存中打框编号）——说清整屏隐私面 + 编号图真落盘会话视觉缓存
    #      （put_image 落 .state/vision/<sid>/，purge_session 才删；红队实测 874KB 整屏图真在盘上，不许谎称不落盘）
    if tool_name == "look":
        return Decision("ask", "要读取整屏画面并打框编号（屏幕上所有可见窗口的内容都会进图；"
                               "编号图存进本会话视觉缓存 .state/vision，会话清理时删除，不另存工作区文件）")
    # 1.10) zoom：读屏（局部区域重新截屏+放大+AX/OCR 重打框）——授权面对齐 look，说清隐私面与视觉缓存落盘
    if tool_name == "zoom":
        return Decision("ask", "要读取屏幕局部区域并放大打框编号（区域内可见窗口的内容都会进图；"
                               "编号图存进本会话视觉缓存 .state/vision，会话清理时删除，不另存工作区文件）")
    # 1.11) pick：状态改变（按视口编号点击屏幕坐标）——授权面对齐 click_at（ask + 指纹绑坐标不跨会话持久），
    #       文案说清驱动的是真鼠标
    if tool_name == "pick":
        return Decision("ask", "要按视口编号点击屏幕（发真鼠标左键单击，状态改变动作）")
    # 2) 安全白名单：放行（含本会话装载的自定义工具——人审门批准+哈希校验=已授权，且执行档位是沙箱硬隔离）
    if tool_name in SAFE_TOOLS or tool_name in _USER_TOOL_SAFE:
        return Decision("approve")
    # 3) 兜底：默认不信任，先问用户
    return Decision("ask", f"要执行 {tool_name}")


def taint_gate(tool_name: str, args, tainted_spans) -> bool:
    """高危工具的参数若原样含来自不可信源(MCP/网页/OCR)的够长文本 → 返回 True（该升级为 ask）。

    穷人版污点追踪（CaMeL 原则轻量版）：不可信内容不能直接当危险动作的参数。
    只挡"把不可信输出整段抄进危险参数"这类；改写/重构的绕过挡不住（需 CaMeL 级，属深水）。
    """
    if not tainted_spans:
        return False
    if tool_name not in _TAINT_HIGH_RISK and not tool_name.startswith("mcp__"):
        return False
    # 拿"参数里的字符串原值"逐个比，而不是比 json.dumps 后的文本——后者会把 " \ tab 换行等
    # 转义（ensure_ascii=False 只关掉非 ASCII 的 \uXXXX），令含这些字符的污点整段抄进来也匹配不上而漏防。
    # F67：大小写无关比对。用 casefold 而非 lower——lower 对希腊词尾 Σ 是上下文相关（Σ→ς/σ），
    # 破坏子串单调性反而让某些污点漏拦（批2审查 MED）；casefold 上下文无关、只增不减地拦。
    leaves = [leaf.casefold() for leaf in (list(_str_values(args)) or [str(args)])]
    for span in tainted_spans:
        s = str(span).strip()
        if len(s) < _MIN_TAINT_SPAN:
            continue
        s = s.casefold()
        if any(s in leaf for leaf in leaves):
            return True
    return False
