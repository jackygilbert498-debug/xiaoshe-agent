"""A7 · 持久放行清单：把用户「永久放行」的命令指纹跨会话记住（`.state/approvals.json`），下次同一命令不再问。

- 只由用户在审批时答 `p` 主动创建（人在环——绝非模型/自动能写）。
- 绑 `_approval_key` 整条命令指纹（run_command 绑整条命令、write_file/edit 绑路径），**不绑裸工具名**。
- **taint / force_ask 仍拦**——持久放行不越过污点/混淆闸（与会话白名单同纪律）。
- **只交互态生效**：headless/无人值守不自动应用（只认显式 `--allow`，安全优先）。
- 文件人可读可编辑，删条目即撤销。`.state/` 已 gitignore，不进 git、不泄漏。
"""
from __future__ import annotations

import json
from pathlib import Path

from . import _io, config

APPROVALS_FILE = config.STATE_DIR / "approvals.json"
_MAX = 500   # 条数上限，防无界增长


def load(path=None) -> set:
    """读持久放行指纹集（坏档/缺档返空集，绝不崩）。"""
    p = Path(path) if path else APPROVALS_FILE
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    return {x for x in data if isinstance(x, str)} if isinstance(data, list) else set()


def add(key: str, path=None) -> bool:
    """把一条指纹加入持久放行（原子写、持锁）。返回是否真的新增。已满/已有/写失败都不新增。"""
    if not key or not isinstance(key, str):
        return False
    p = Path(path) if path else APPROVALS_FILE
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with _io.file_lock(p, timeout=5):
            cur = load(p)
            if key in cur or len(cur) >= _MAX:
                return False
            cur.add(key)
            _io.atomic_write_json(p, sorted(cur), indent=2)
            return True
    except (OSError, TimeoutError):
        return False
