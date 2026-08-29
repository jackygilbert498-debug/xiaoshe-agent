"""eval 核心：Task 定义 + run_once（真走 run_headless 端到端跑一次，据客观信号判过）。

三个免改 harness 的验收信号：① run_headless 退出码 ② HARNESS_RUN_SUMMARY 落盘的 denied_calls
（越权信号灯）③ workdir 终态（文件/内容）。默认「脚本模型」零网络确定性，--live 才切真 Kimi。
§4.6.1：Task 可带 checklist 有序子目标断言（按序逐条断、首挂记 failed_step 归因），不再只断言终态。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from harness import headless


@dataclass
class Task:
    name: str
    prompt: str
    make_model: object                  # 工厂 ()->model_fn：每跑一次取一个全新模型（脚本模型有状态，pass^k 必须每跑一新）
    allow: tuple = ()                   # 预放行的工具（= 无头下的审批）
    verify: object = None               # fn(ctx)->bool；ctx={workdir,rc,denied_calls,session_id}。缺省 = rc==0
    setup: object = None                # fn(workdir)：跑模型前预置 workdir（如放一张待读的文档图）
    checklist: tuple = ()               # §4.6.1 有序子目标断言：((label, fn(ctx)->bool), ...)；按序逐条断，首挂即 failed_step 归因


@dataclass
class Outcome:
    name: str
    passed: bool
    rc: int
    denied_calls: int
    steps: tuple = ()                   # 有序子目标逐步结果 ((label, ok), ...)，无 checklist 则空
    failed_step: str = None             # 首个未过子目标（失败归因显性化：哪步挂了直接看到）；None=非子目标挂


def run_once(task: Task, base: Path) -> Outcome:
    """跑一个 eval 任务：真走 run_headless（端到端），据三信号判过。每任务独立 workdir。"""
    workdir = base / task.name
    workdir.mkdir(parents=True, exist_ok=True)
    if task.setup:
        try:
            task.setup(workdir)         # 跑模型前预置（如渲一张待读的文档图）
        except Exception:
            return Outcome(task.name, False, rc=-1, denied_calls=0)  # 预置失败=该任务不过，别掀翻整套（与 verify 兜底对齐）
    summary_file = base / f"{task.name}.summary.json"
    old = os.environ.get("HARNESS_RUN_SUMMARY")
    os.environ["HARNESS_RUN_SUMMARY"] = str(summary_file)
    try:
        rc = headless.run_headless(task.prompt, allow=task.allow, workdir=str(workdir),
                                   model_fn=task.make_model(), no_mcp=True, session_prefix="headless-")
    finally:
        if old is None:
            os.environ.pop("HARNESS_RUN_SUMMARY", None)
        else:
            os.environ["HARNESS_RUN_SUMMARY"] = old
    denied, sid = 0, None
    try:
        s = json.loads(summary_file.read_text(encoding="utf-8"))
        denied = s.get("denied_calls") or 0
        sid = s.get("session_id")
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        pass
    ctx = {"workdir": workdir, "rc": rc, "denied_calls": denied, "session_id": sid}
    steps = []
    for label, fn in (task.checklist or ()):    # §4.6.1 按序断言子目标（全部评完留全量步骤，归因取首挂）
        try:
            steps.append((label, bool(fn(ctx))))
        except Exception:
            steps.append((label, False))        # 断言自己崩 = 该步未过，别把套件带崩（与 verify 兜底对齐）
    failed_step = next((label for label, ok in steps if not ok), None)
    try:
        passed = bool(task.verify(ctx)) if task.verify else (rc == 0)
    except Exception:
        passed = False  # verify 自己崩了 = 没通过，别把套件带崩
    return Outcome(task.name, passed and failed_step is None, rc, denied,
                   steps=tuple(steps), failed_step=failed_step)
