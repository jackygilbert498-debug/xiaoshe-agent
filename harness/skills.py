"""A2a · 技能库（SKILL.md）：把可复用的做法固化成一份带元信息的流程，下次同类任务先看技能再动手（自我扩展第一步）。

存 `.state/skills/<slug>.md`（frontmatter: name/description/when + 正文步骤）。索引(name+when)进开场 system 让模型
知道有哪些技能，用 read_skill(name) 取全文照做。技能正文注入前中和隐形字符（比照 episodic）；照技能做时每个工具调用
照常过安全审批——**技能不提权**（技能里写「跑 rm」也得过 run_command 的闸）。

交互态 save_skill 由用户审批即激活；后台自学的技能只产 pending、人审硬门（见 selflearn：pending 落 `pending/` 子目录，
list_skills/system_message 物理上看不见，approve 重走 save_skill 净化挪正区、下次会话进索引）。`.state/` 已 gitignore，不泄漏。
"""
from __future__ import annotations

import re
from pathlib import Path

from . import _io, config, episodic

SKILLS_DIR = config.STATE_DIR / "skills"
_NAME_MAX = 60
_DESC_MAX = 200
_WHEN_MAX = 200
_BODY_MAX = 4000


def _slug(name: str) -> str:
    """名字 → 安全文件名：只留字母数字/下划线/连字符，防路径穿越（../、绝对路径都被剥）。"""
    s = re.sub(r"[^A-Za-z0-9_一-鿿-]", "-", str(name or "").strip())[:_NAME_MAX].strip("-")
    return s or "skill"


def _clean(text: str, limit: int) -> str:
    return episodic._neutralize(str(text or "")).strip()[:limit]


def _clean1line(text: str, limit: int) -> str:
    """折成单行（换行/连续空白→单空格）——进单行 frontmatter 槽的字段用，防换行破坏解析/跨字段伪造（审查 MED）。"""
    return " ".join(episodic._neutralize(str(text or "")).split())[:limit]


def save_skill(name: str, description: str, when: str, steps: str, path=None) -> str:
    """保存一份技能（原子写）。返回 slug。name slug 化防穿越；frontmatter 三字段折单行 + 中和 + 截断；steps 保多行。

    slug 碰撞：同 name → 覆盖(更新)；不同 name 撞到同 slug → 加数字后缀，不静默冲掉别人（审查 LOW）。"""
    base = Path(path) if path else SKILLS_DIR
    base.mkdir(parents=True, exist_ok=True)
    name = _clean1line(name, _NAME_MAX) or "skill"
    slug = _slug(name)
    final = slug
    n = 2
    while (base / f"{final}.md").exists():
        try:
            existing = _parse((base / f"{final}.md").read_text(encoding="utf-8", errors="replace"))
        except OSError:
            break
        if existing.get("name") == name:   # 同名 → 覆盖更新
            break
        final = f"{slug}-{n}"              # 异名撞 slug → 加后缀，别冲掉别人
        n += 1
    content = (f"---\nname: {name}\n"
               f"description: {_clean1line(description, _DESC_MAX)}\n"
               f"when: {_clean1line(when, _WHEN_MAX)}\n---\n"
               f"{_clean(steps, _BODY_MAX)}\n")
    _io.atomic_write_text(base / f"{final}.md", content)
    return final


def _parse(text: str) -> dict:
    """解析 SKILL.md：frontmatter(name/description/when) + 正文。容错——缺 frontmatter 时正文即全文。"""
    meta = {"name": "", "description": "", "when": "", "body": ""}
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.DOTALL)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                k = k.strip()
                if k in ("name", "description", "when"):
                    meta[k] = v.strip()
        meta["body"] = m.group(2).strip()
    else:
        meta["body"] = text.strip()
    return meta


def list_skills(path=None) -> list:
    """列出所有技能的元信息（name/description/when/slug），按 name 排序。坏文件跳过不崩。"""
    base = Path(path) if path else SKILLS_DIR
    out = []
    if not base.exists():
        return out
    for p in sorted(base.glob("*.md")):
        try:
            meta = _parse(p.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        out.append({"name": meta["name"] or p.stem, "description": meta["description"],
                    "when": meta["when"], "slug": p.stem})
    return sorted(out, key=lambda s: s["name"])


def read_skill(name: str, path=None) -> str | None:
    """取一份技能全文（中和后）。按 slug 或原名匹配；无则 None。"""
    base = Path(path) if path else SKILLS_DIR
    slug = _slug(_clean(name, _NAME_MAX))
    p = base / f"{slug}.md"
    if p.exists():
        return episodic._neutralize(p.read_text(encoding="utf-8", errors="replace"))
    for s in list_skills(base):   # 兜底：按 name 找
        if s["name"] == str(name).strip():
            return read_skill(s["slug"], base)
    return None


def system_message(path=None) -> dict | None:
    """技能索引进开场 system（**空库返 None**，保 _fresh_history 形状不变）：只列 name+when，引导 read_skill 取全文。

    只放小索引（元信息），全文经 read_skill 走工具结果注入——别把技能正文塞进置顶 system，为 prompt cache 让路（施工定稿约束）。
    """
    sk = list_skills(path)
    if not sk:
        return None
    body = "\n".join(f"- {s['name']}：{s['when']}" for s in sk if s["when"] or s["name"])
    if not body:
        return None
    return {"role": "system",
            "content": ("你有以下可复用技能，遇到匹配场景先用 read_skill(name) 取全文照做"
                        "（照做时其中任何危险动作仍照常过审批，技能不提权）：\n" + body)}
