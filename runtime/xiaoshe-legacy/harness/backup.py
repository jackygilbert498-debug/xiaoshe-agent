"""P6 · 运行态备份/恢复：把 `.state`（会话/定时/后台/日志/视觉 blob）打成 .tar.gz，换机或误删可一键还原。

安全：恢复时**跳过路径穿越成员（tarbomb）与软/硬链**（防写到目标目录外）；非空目标须 force（防误覆盖当前运行态）。
`.env`/密钥在仓库根、不在 `.state` 里，故备份不含敏感密钥。
"""
from __future__ import annotations

import os
import tarfile
from pathlib import Path

from . import config

STATE_DIR = config.ROOT / ".state"


def create_backup(archive_path, src_dir=None) -> Path:
    """把运行态目录打成 .tar.gz（归档内根为 `.state`）。src_dir 默认 config.ROOT/.state。"""
    src = Path(src_dir) if src_dir else STATE_DIR
    archive_path = Path(archive_path)
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "w:gz") as tar:
        if src.exists():
            tar.add(src, arcname=".state")
    return archive_path


def _is_within(base: Path, dest: Path) -> bool:
    """dest 解析后是否仍落在 base 内（防 ../ 穿越、绝对路径逃逸）。"""
    b = base.resolve()
    d = dest.resolve()
    return d == b or str(d).startswith(str(b) + os.sep)


def _safe_member(target: Path, state: Path, m) -> bool:
    """成员是否可安全解压：只收普通文件/目录（软硬链/设备/FIFO 挡，#13）、必须落在 .state/ 内。

    H1：围栏钉在 .state 而非 target(=ROOT)——否则 `.state/../.env` 解析到 ROOT/.env 仍算「在 target 内」
    而被放行，可覆盖 .env/harness 源码（潜在 RCE/密钥劫持）。两道：① 归档内根必须是 .state
    ② 解析后仍在 .state 内（挡 .state/../ 逃逸）。extractall 再叠 filter='data' 兜底。
    """
    if not (m.isfile() or m.isdir()):
        return False
    parts = Path(m.name).parts
    if not parts or parts[0] != ".state":   # 归档内根必须是 .state（裸成员/绝对路径/../ 开头一律拒）
        return False
    return _is_within(state, target / m.name)   # 解析后仍须落在 .state 内（挡 .state/../evil）


def restore_backup(archive_path, target_dir=None, force: bool = False):
    """从 .tar.gz 恢复运行态到 target/.state。返回 (ok, 说明)。

    防护：只解落在 .state/ 内的普通文件/目录，跳过软/硬链与路径穿越成员（H1：围栏钉 .state 不钉 ROOT）；
    目标 .state 非空且未 force → 拒绝（不误覆盖当前运行态）。
    """
    target = Path(target_dir) if target_dir else config.ROOT
    state = target / ".state"
    if state.exists() and any(state.iterdir()) and not force:
        return (False, "目标 .state 非空——加 force 才覆盖恢复（防误删当前运行态；先 backup 再 restore --force）")
    try:
        with tarfile.open(archive_path, "r:gz") as tar:
            safe = [m for m in tar.getmembers() if _safe_member(target, state, m)]
            tar.extractall(target, members=safe, filter="data")   # filter='data' 兜底防穿越/链，并消 Py3.14 弃用告警
    except (OSError, tarfile.TarError) as e:
        return (False, f"恢复失败：{e}")
    return (True, f"已恢复 {len(safe)} 项到 {state}")
