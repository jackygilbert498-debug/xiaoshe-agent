"""严格解析 `git status --porcelain=v2 -z`，保留路径字节而不依赖人类可读输出。"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field


class StatusParseError(ValueError):
    def __init__(self, code: str, detail: str = ""):
        self.code = code
        super().__init__(f"{code}: {detail}")


def _path(raw: bytes) -> str:
    value = os.fsdecode(raw)
    if not value or value.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", value) or any(part == ".." for part in value.replace("\\", "/").split("/")):
        raise StatusParseError("PATH_OUTSIDE_PROJECT", repr(value[:160]))
    return value.replace("\\", "/")


@dataclass(frozen=True)
class ChangedPath:
    path: str
    xy: str
    submodule: str
    mode_head: str
    mode_index: str
    mode_worktree: str
    oid_head: str
    oid_index: str


@dataclass(frozen=True)
class RenamedPath(ChangedPath):
    original_path: str
    score: str


@dataclass(frozen=True)
class WorkspaceStatus:
    branch: str | None = None
    changed: tuple[ChangedPath, ...] = ()
    renamed: tuple[RenamedPath, ...] = ()
    unmerged: tuple[ChangedPath, ...] = ()
    untracked: tuple[str, ...] = ()
    ignored: tuple[str, ...] = ()


def _ordinary(record: bytes) -> ChangedPath:
    parts = record.split(b" ", 8)
    if len(parts) != 9:
        raise StatusParseError("STATUS_RECORD_INVALID", "ordinary")
    _tag, xy, sub, mhead, midx, mwork, hhead, hidx, path = parts
    return ChangedPath(_path(path), os.fsdecode(xy), os.fsdecode(sub), os.fsdecode(mhead), os.fsdecode(midx), os.fsdecode(mwork), os.fsdecode(hhead), os.fsdecode(hidx))


def _renamed(record: bytes, original: bytes) -> RenamedPath:
    parts = record.split(b" ", 9)
    if len(parts) != 10:
        raise StatusParseError("STATUS_RECORD_INVALID", "rename")
    _tag, xy, sub, mhead, midx, mwork, hhead, hidx, score, path = parts
    return RenamedPath(_path(path), os.fsdecode(xy), os.fsdecode(sub), os.fsdecode(mhead), os.fsdecode(midx), os.fsdecode(mwork), os.fsdecode(hhead), os.fsdecode(hidx), _path(original), os.fsdecode(score))


def _unmerged(record: bytes) -> ChangedPath:
    # u XY SUB m1 m2 m3 mW h1 h2 h3 path；保留 ours/theirs 的前两 OID 供风险显示。
    parts = record.split(b" ", 10)
    if len(parts) != 11:
        raise StatusParseError("STATUS_RECORD_INVALID", "unmerged")
    _tag, xy, sub, m1, m2, _m3, mwork, h1, h2, _h3, path = parts
    return ChangedPath(_path(path), os.fsdecode(xy), os.fsdecode(sub), os.fsdecode(m1), os.fsdecode(m2), os.fsdecode(mwork), os.fsdecode(h1), os.fsdecode(h2))


def parse_porcelain_v2(data: bytes) -> WorkspaceStatus:
    tokens = data.split(b"\0")
    changed: list[ChangedPath] = []; renamed: list[RenamedPath] = []; unmerged: list[ChangedPath] = []
    untracked: list[str] = []; ignored: list[str] = []; branch = None; index = 0
    while index < len(tokens) and tokens[index]:
        record = tokens[index]; tag = record[:1]
        if tag == b"#":
            text = os.fsdecode(record)
            if text.startswith("# branch.head "): branch = text[len("# branch.head "):]
        elif tag == b"1": changed.append(_ordinary(record))
        elif tag == b"2":
            if index + 1 >= len(tokens) or not tokens[index + 1]: raise StatusParseError("STATUS_RECORD_TRUNCATED", "rename")
            renamed.append(_renamed(record, tokens[index + 1])); index += 1
        elif tag == b"u": unmerged.append(_unmerged(record))
        elif tag == b"?": untracked.append(_path(record[2:]))
        elif tag == b"!": ignored.append(_path(record[2:]))
        else: raise StatusParseError("STATUS_RECORD_UNKNOWN", tag.hex())
        index += 1
    return WorkspaceStatus(branch, tuple(changed), tuple(renamed), tuple(unmerged), tuple(untracked), tuple(ignored))
