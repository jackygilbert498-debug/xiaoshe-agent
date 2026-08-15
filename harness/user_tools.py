"""A2b Path B · 自定义工具注册表：小蛇提案的工具经**人审门**批准后持久化，跨会话可用。

生命周期：propose（agent 写草稿进 pending/）→ 人审 approve（重校验+记 sha256 进 manifest.json+移 active/）
→ 下次会话初 load_active（逐个比对哈希，批准那一刻的字节=以后每次加载的字节）→ 调用时代码丢沙箱跑。

三条命根子不变量：
1. **agent 只能写 pending**——active/ 与 manifest.json 只有 approve()（人审通道）能动；
   .state/user_tools 整目录进 permission 敏感硬护栏，write_file/run_command 都碰不了（防绕过人审门自我扩权）。
2. **批准后偷改=拒载**（rug-pull 防护）：加载时 sha256 与清单不符、不在清单的旁置文件、损坏清单 → 一律不载、fail-closed。
3. **不遮蔽内置**：与内置工具/mcp__ 前缀重名，提案时拒收、加载时也再拒一道（后来新增的内置赢）。

工具文件 = 一个 JSON（name/description/params/code/created_at），参数一律字符串；代码是 PowerShell，
调用时在 AppContainer 沙箱执行（读不到密钥/断网/资源上限）——持久化不提权，执行档位与 run_sandboxed 相同。
（已知限制：冻结代码是 PowerShell，Mac seatbelt 沙箱跑的是 zsh——Mac 上调用自定义工具会在**沙箱内**以
语法错误失败（不越权、不泄密，只是跑不动）；Mac 持久化工具执行待 PowerShell→shell 参数协议另行立项。）
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

from . import _io, config, episodic

_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{2,39}$")     # 3-40 位小写标识符（进模型工具表的函数名，须 ASCII）
_PARAM_RE = re.compile(r"^[a-z][a-z0-9_]{0,29}$")
_DESC_MAX = 300
_PARAM_DESC_MAX = 200
_PARAMS_MAX = 8
_CODE_MAX = 20000
_PENDING_MAX = 50   # 待审提案数上限（对抗审查#6：防 agent 刷爆 pending，DoS 磁盘 + 拖慢人审热路径）
# 不可见危险字符（对抗审查#4）：双向控制 RLO/LRO/isolate、零宽、word-joiner、BOM。正常代码绝不含，
# 出现即 Trojan-Source 视觉欺骗人审门（sha 锁字节但锁不住渲染）——从源头拒收 code。
# ​-‏ 零宽/LRM/RLM · ‪-‮ LRE/RLE/PDF/LRO/RLO · ⁠ word-joiner · ⁦-⁩ isolate · ﻿ BOM
_INVISIBLE_RE = re.compile("[​-‏‪-‮⁠⁦-⁩﻿]")


def _base(base=None) -> Path:
    return Path(base) if base else (config.ROOT / ".state" / "user_tools")


def _reserved(reserved=None) -> set:
    if reserved is not None:
        return set(reserved)
    from . import tools   # 惰性导入避循环（tools 后续会反向惰性导入本模块做加载）
    return set(tools.REGISTRY)


def _clean1line(text, limit: int) -> str:
    """中和隐形字符 + 折单行 + 截断（同 skills 纪律）：描述会进人审门展示与模型工具表，不许藏东西。"""
    return " ".join(episodic._neutralize(str(text or "")).split())[:limit]


def _validate(name: str, description: str, code: str, params, reserved: set) -> dict:
    """全量校验（propose 与 approve 共用——approve 必须重校验，pending 文件可能被手改过）。
    返回清洗后的规范化字段 dict；任何不合规抛 ValueError。"""
    name = str(name or "").strip()
    if not _NAME_RE.match(name):
        raise ValueError("工具名须 3-40 位小写字母/数字/下划线、字母开头（会成为模型可调的函数名）")
    if name in reserved or name.startswith("mcp__"):
        raise ValueError(f"工具名「{name}」与内置/外部工具重名，拒收（不许遮蔽劫持现有工具）")
    desc = _clean1line(description, _DESC_MAX)
    if not desc:
        raise ValueError("description 不能为空——人审门与模型都要靠它判断这工具干嘛")
    code = str(code or "").replace("\r\n", "\n").replace("\r", "\n")  # 换行归一：杜绝孤立 CR 在终端覆写行伪装（对抗审查#5）
    if not code.strip():
        raise ValueError("code 不能为空（PowerShell，参数经 param(...) 接收，Write-Output 回结果）")
    if len(code) > _CODE_MAX:
        raise ValueError(f"code 超长（>{_CODE_MAX} 字符）——工具该小而专，太长拆成多个")
    if _INVISIBLE_RE.search(code):   # 对抗审查#4：bidi/零宽等不可见字符→Trojan-Source 视觉欺骗人审，源头拒收（正常代码不需要）
        raise ValueError("code 含双向控制/零宽等不可见字符，拒收——正常代码不需要，防审批时被视觉欺骗")
    clean_params = []
    seen = set()
    for p in (params or []):
        if not isinstance(p, dict):
            raise ValueError("params 每项须为对象：{name, description}")
        pn = str(p.get("name", "")).strip()
        if not _PARAM_RE.match(pn):
            raise ValueError(f"参数名「{pn}」非法：须 1-30 位小写字母/数字/下划线、字母开头")
        if pn in seen:
            raise ValueError(f"参数名「{pn}」重复")
        seen.add(pn)
        clean_params.append({"name": pn, "description": _clean1line(p.get("description", ""), _PARAM_DESC_MAX),
                             "required": bool(p.get("required", True))})
    if len(clean_params) > _PARAMS_MAX:
        raise ValueError(f"参数最多 {_PARAMS_MAX} 个")
    return {"name": name, "description": desc, "params": clean_params, "code": code}


def _load_manifest(base: Path) -> dict:
    """读清单；损坏/缺失时抛 ValueError 由调用方决定语义（load_active=全拒载，approve=当空新建）。"""
    p = base / "manifest.json"
    if not p.exists():
        return {"tools": {}}
    data = json.loads(p.read_bytes().decode("utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("tools"), dict):
        raise ValueError("manifest 结构不对")
    return data


def _stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def propose(name: str, description: str, code: str, params=None, base=None, reserved=None) -> dict:
    """agent 提案一个工具 → 写 pending/<name>.json 草稿（同名再提案=覆盖草稿）。只写 pending，绝不碰 active。"""
    b = _base(base)
    clean = _validate(name, description, code, params, _reserved(reserved))
    clean["created_at"] = _stamp()
    (b / "pending").mkdir(parents=True, exist_ok=True)
    path = b / "pending" / f"{clean['name']}.json"
    if not path.exists():   # 对抗审查#6：pending 数量上限（覆盖已存在的同名草稿不算新增，改草稿不被上限卡死）
        existing = len(list((b / "pending").glob("*.json")))
        if existing >= _PENDING_MAX:
            raise ValueError(f"待审提案已达上限（{_PENDING_MAX} 个）——请先用 :reject 清理已堆积的提案再提新的")
    _io.atomic_write_text(path, json.dumps(clean, ensure_ascii=False, indent=1))
    try:
        active_names = set(_load_manifest(b)["tools"])
    except (ValueError, OSError):
        active_names = set()
    return {"name": clean["name"], "description": clean["description"], "params": clean["params"],
            "path": str(path), "updates_active": clean["name"] in active_names}


def list_pending(base=None) -> list:
    """列出待审提案（供人审门展示）。坏文件也列出来（带 error），别静默藏——人得知道有垃圾在排队。"""
    b = _base(base)
    out = []
    d = b / "pending"
    if not d.exists():
        return out
    for p in sorted(d.glob("*.json")):
        try:
            data = json.loads(p.read_bytes().decode("utf-8"))
            out.append({"name": p.stem, "description": _clean1line(data.get("description", ""), _DESC_MAX),
                        "params": data.get("params") or [], "created_at": str(data.get("created_at", "")),
                        "code": str(data.get("code", "")), "path": str(p)})
        except (ValueError, OSError) as e:
            out.append({"name": p.stem, "error": f"提案文件损坏：{e}", "path": str(p)})
    return out


def list_active(base=None) -> list:
    """列出清单里已批准的工具（轻量：只读 manifest，不逐个开文件；完整校验在 load_active）。"""
    b = _base(base)
    try:
        man = _load_manifest(b)
    except (ValueError, OSError):
        return []
    return [{"name": n, "sha256": str(e.get("sha256", "")), "approved_at": str(e.get("approved_at", ""))}
            for n, e in sorted(man["tools"].items())]


def approve(name: str, base=None, reserved=None, expected_sha256=None) -> dict:
    """人审通过：重校验 pending 内容（fail-closed，文件可能被改过）→ 移入 active/ → sha256 记入清单。

    expected_sha256：审批门展示草稿时算好的哈希——不符=展示后草稿被改（TOCTOU），拒绝；
    锁死「用户看到的字节=批准的字节」。哈希对**落盘后的 active 真字节**算（读回再哈希），
    杜绝换行翻译/编码差把清单与盘上字节写岔。"""
    b = _base(base)
    name = str(name or "").strip()
    src = b / "pending" / f"{name}.json"
    if not src.exists():
        raise ValueError(f"pending 里没有「{name}」——先让小蛇 propose_tool 提案")
    raw = src.read_bytes()
    if expected_sha256 and hashlib.sha256(raw).hexdigest() != str(expected_sha256):
        raise ValueError(f"「{name}」草稿与你确认时的内容不一致（期间被改动），已拒绝——请重新 :tools 查看后再批准")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, OSError) as e:
        raise ValueError(f"提案文件损坏/被改，拒绝批准：{e}")
    clean = _validate(data.get("name"), data.get("description"), data.get("code"),
                      data.get("params"), _reserved(reserved))
    if clean["name"] != name:
        raise ValueError(f"提案内容名「{clean['name']}」与文件名「{name}」不符，拒绝批准（疑被改动）")
    clean["created_at"] = str(data.get("created_at", "")) or _stamp()
    (b / "active").mkdir(parents=True, exist_ok=True)
    dst = b / "active" / f"{name}.json"
    _io.atomic_write_text(dst, json.dumps(clean, ensure_ascii=False, indent=1))
    sha = hashlib.sha256(dst.read_bytes()).hexdigest()
    try:
        man = _load_manifest(b)
    except (ValueError, OSError):
        man = {"tools": {}}   # 清单坏了：批准动作以本次为准重建（旧条目本就已 fail-closed 拒载）
    man["tools"][name] = {"sha256": sha, "approved_at": _stamp()}
    _io.atomic_write_text(b / "manifest.json", json.dumps(man, ensure_ascii=False, indent=1))
    src.unlink()
    return {"name": name, "sha256": sha, "path": str(dst),
            "description": clean["description"], "params": clean["params"]}


def reject(name: str, base=None) -> dict:
    """人审否决：删 pending 草稿。"""
    b = _base(base)
    name = str(name or "").strip()
    src = b / "pending" / f"{name}.json"
    if not src.exists():
        raise ValueError(f"pending 里没有「{name}」")
    src.unlink()
    return {"name": name}


def load_active(base=None, reserved=None) -> tuple:
    """会话初加载全部已批准工具 → (tools, problems)。逐项 fail-closed：
    哈希不符（批准后被改）/文件缺失/内容坏/名字不符/撞内置名 → 该项不载、进 problems；
    清单损坏 → 全部不载。旁置文件（active/ 里有、清单没记）绝不静默生效，进 problems 提醒人清理。"""
    b = _base(base)
    res = _reserved(reserved)
    tools, problems = [], []
    try:
        man = _load_manifest(b)
    except (ValueError, OSError) as e:
        return [], [f"user_tools 清单损坏，全部拒载：{e}"]
    for name, entry in sorted(man["tools"].items()):
        # 对抗审查#3：manifest 部分损坏优雅降级（entry 非 dict / key 非法名）→ 记 problem 跳过，
        # 别让 entry.get 抛 AttributeError 穿透到会话初始化崩掉 REPL；非法名也绝不用来拼 active/ 路径。
        if not isinstance(entry, dict):
            problems.append(f"「{name}」清单条目结构损坏（非对象），跳过")
            continue
        if not _NAME_RE.match(str(name)):
            problems.append(f"「{name}」清单名非法，跳过（不用于拼路径）")
            continue
        f = b / "active" / f"{name}.json"
        if not f.exists():
            problems.append(f"「{name}」清单有记录但文件缺失，跳过")
            continue
        raw = f.read_bytes()
        if hashlib.sha256(raw).hexdigest() != str(entry.get("sha256", "")):
            problems.append(f"「{name}」内容与批准时哈希不符（疑批准后被改动），拒载")
            continue
        try:
            data = json.loads(raw.decode("utf-8"))
            clean = _validate(data.get("name"), data.get("description"), data.get("code"),
                              data.get("params"), reserved=set())   # 撞名单独查，给出更准的话
        except ValueError as e:
            problems.append(f"「{name}」内容不合规，拒载：{e}")
            continue
        if clean["name"] != name:
            problems.append(f"「{name}」内容名与清单名不符，拒载")
            continue
        if name in res or name.startswith("mcp__"):
            problems.append(f"「{name}」与内置/外部工具重名（内置优先），拒载")
            continue
        clean["sha256"] = str(entry.get("sha256", ""))
        tools.append(clean)
    if (b / "active").exists():
        for f in sorted((b / "active").glob("*.json")):
            if f.stem not in man["tools"]:
                problems.append(f"「{f.stem}」在 active/ 但不在清单（未经批准），忽略——请人工清理")
    return tools, problems
