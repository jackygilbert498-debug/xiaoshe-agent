"""D3 真实任务 eval runner：真 Kimi 全跑一遍，结果+摩擦落 .state/d3/<时间戳>/（gitignore 已挡）。

跑法：
  cd /c/Users/example/Desktop/ke && PYTHONIOENCODING=utf-8 py -3 -m evals.real_tasks.run_d3
  py -3 -m evals.real_tasks.run_d3 --tasks T3按主题收集媒体   # 只跑指定任务（名字前缀匹配）
  py -3 -m evals.real_tasks.run_d3 --base .d3                 # 换沙盒落盘根（默认 .d3，gitignore）

每任务独立沙盒 workdir（.d3/<ts>/<任务名>；**不能放 .state 下**，permission 对 .state 整树硬拒），
产出 results.json 并备份到 .state/d3/results-<ts>.json；会话转录在 .state/logs/headless-*.jsonl。
docs/验收/D3真实任务-问题清单.md 由人据 results.json 汇总撰写（runner 不代笔结论）。
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from ..core import run_once
from . import friction
from .tasks import D3_TASKS


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="evals.real_tasks.run_d3",
                                 description="D3 真实任务 eval（真 Kimi × 5 类日常任务）")
    ap.add_argument("--tasks", default=None, help="只跑名字含这些关键词的任务（逗号分隔）")
    ap.add_argument("--base", default=".d3",
                    help="沙盒落盘根（默认 .d3，已 gitignore；**不能放 .state 下**——permission 对 .state 整树硬拒，"
                         "文件类工具全挂，D3 首批实测踩过）")
    args = ap.parse_args(argv)

    tasks = D3_TASKS
    if args.tasks:
        keys = [k.strip() for k in args.tasks.split(",") if k.strip()]
        tasks = [t for t in D3_TASKS if any(k in t.name for k in keys)]
        if not tasks:
            print(f"[!] 没有匹配的任务：{keys}")
            return 1
    base = Path(args.base) / time.strftime("%Y%m%d-%H%M%S")
    base.mkdir(parents=True, exist_ok=True)
    print(f"[d3] {len(tasks)} 个任务，真 Kimi 端到端；落盘 {base}\n")

    results = []
    for task in tasks:
        t0 = time.time()
        print(f"── {task.name} …", flush=True)
        out = run_once(task, base)
        rep = friction.collect(base, task.name, out)
        rep["elapsed_s"] = round(time.time() - t0, 1)
        results.append(rep)
        verdict = "✅ 过" if rep["passed"] else f"❌ 挂（首挂子目标：{rep['failed_step'] or '—'}）"
        print(f"   {verdict}｜rc={rep['rc']} 轮数={rep.get('rounds')} 工具错={rep.get('tool_errors')} "
              f"拒={rep['denied_calls']} 耗时={rep['elapsed_s']}s", flush=True)

    text = json.dumps(results, ensure_ascii=False, indent=1)
    (base / "results.json").write_text(text, encoding="utf-8")
    # 备份一份到 .state/d3/（规格指定的留痕处；会话转录本身在 .state/logs/headless-*.jsonl）。
    # 注意：workdir 不能放 .state 下——permission._is_sensitive 对 .state 整树硬拒，文件类工具全会挂（D3 发现）。
    state_dir = Path(".state/d3")
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / f"results-{base.name}.json").write_text(text, encoding="utf-8")
    n_pass = sum(1 for r in results if r["passed"])
    print(f"\n{n_pass}/{len(results)} 过；明细 {base / 'results.json'}")
    return 0 if n_pass == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
