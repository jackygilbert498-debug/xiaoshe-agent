"""eval runner：把每个种子任务跑 k 次，报 pass^k（k 次全过才绿）。

用法：python -m evals.run [--k 3]
pass^k 暴露「上次能过这次不能过」的假稳定——比 pass@1 严。零 Docker、零网络（脚本模型）。
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .core import run_once
from .tasks import SEEDS


def run_suite(tasks=None, k: int = 3):
    """每个任务独立跑 k 次（各自新临时 workdir），返回 [(name, passes, k, first_failed_step)]。
    first_failed_step = 首个失败跑的 failed_step（§4.6.1 子目标归因；非子目标挂/全过为 None）。"""
    tasks = SEEDS if tasks is None else tasks
    results = []
    for task in tasks:
        passes = 0
        first_failed_step = None
        for _ in range(k):
            with tempfile.TemporaryDirectory() as d:
                out = run_once(task, Path(d))
                if out.passed:
                    passes += 1
                elif first_failed_step is None:
                    first_failed_step = out.failed_step
        results.append((task.name, passes, k, first_failed_step))
    return results


def run_suite_report(tasks=None, k: int = 3) -> tuple[list[tuple], dict]:
    """Run the suite and retain per-attempt evidence for an auditable report.

    ``run_suite`` intentionally keeps its historical compact return contract.
    This parallel entry point records objective harness signals only, never the
    provider request/response, so a live run can be reviewed without exposing
    prompts, image data, or credentials.
    """
    tasks = SEEDS if tasks is None else tasks
    results, attempts = [], []
    for task in tasks:
        passes = 0
        first_failed_step = None
        for attempt in range(1, k + 1):
            with tempfile.TemporaryDirectory() as d:
                out = run_once(task, Path(d))
            if out.passed:
                passes += 1
            elif first_failed_step is None:
                first_failed_step = out.failed_step
            attempts.append({
                "task": out.name,
                "attempt": attempt,
                "passed": out.passed,
                "rc": out.rc,
                "denied_calls": out.denied_calls,
                "steps": [{"label": label, "passed": ok} for label, ok in out.steps],
                "failed_step": out.failed_step,
            })
        results.append((task.name, passes, k, first_failed_step))
    return results, {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "task_count": len(tasks),
        "repeat_count": k,
        "all_green": all(p == kk for _, p, kk, _ in results),
        "attempts": attempts,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="evals.run", description="小蛇最小 eval 套件（pass^k）")
    ap.add_argument("--k", type=int, default=3, help="每个任务重复次数（pass^k）")
    ap.add_argument("--live", action="store_true",
                    help="切真 Kimi 端到端跑（需 .env KIMI_API_KEY + 本地代理 + Chrome），兑现 P3 验收锚")
    ap.add_argument("--report", type=Path,
                    help="把每轮的客观验收信号写为 JSON（不含模型回复或凭据）")
    args = ap.parse_args(argv)
    tasks = None
    if args.live:
        from .live_tasks import LIVE_SEEDS
        tasks = LIVE_SEEDS
        print(f"[live] 真 Kimi 端到端，{len(tasks)} 个任务 × pass^{args.k}（会真调用 Kimi + 起浏览器，稍慢）\n")
    if args.report:
        results, report = run_suite_report(tasks, k=args.k)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                               encoding="utf-8")
        print(f"[report] 已落盘 {args.report}")
    else:
        results = run_suite(tasks, k=args.k)
    all_green = all(p == kk for _, p, kk, _ in results)
    for name, p, kk, fstep in results:
        line = f"{'✅' if p == kk else '❌'} {name}  pass^{kk}={p}/{kk}"
        if p < kk and fstep:
            line += f"（首挂子目标：{fstep}）"   # §4.6.1 失败归因显性化，不用从最终失败倒推
        print(line)
    print(f"\n{'全过' if all_green else '有失败'}：{sum(1 for _, p, kk, _ in results if p == kk)}/{len(results)} 任务 pass^{args.k}")
    return 0 if all_green else 1


if __name__ == "__main__":
    raise SystemExit(main())
