"""定时调度命令行：`python run.py schedule <子命令>`。

把「任务档案」（schedule.py）与「系统调度器安装」（scheduler_install.py）粘起来，
对用户呈现一组好懂的中文子命令。敲 `add` 那一刻 = 审批那一刻（M2 拍板的延伸）。

子命令：add / list / run / history / pause / resume / stop / remove。
"""
from __future__ import annotations

import argparse

from . import schedule, scheduler_install


def _cmd_add(args) -> int:
    allow = tuple(t.strip() for t in (args.allow or "").split(",") if t.strip())
    try:
        task = schedule.add_task(args.name, args.prompt, every=args.every, daily=args.daily,
                                 allow=allow, workdir=args.workdir,
                                 max_minutes=args.max_minutes, mcp=args.mcp,
                                 task_id=args.task_id, policy_id=args.policy_id)
    except ValueError as e:
        print(f"[×] 建任务失败：{e}")
        return 2
    try:
        scheduler_install.install(task)
    except scheduler_install.InstallError as e:
        # 装进系统调度器失败：回滚档案，不留「档案在、系统里没有」的半拉子任务
        schedule._task_path(args.name).unlink(missing_ok=True)
        print(f"[×] 装入系统调度器失败，已回滚：{e}")
        return 1
    节奏 = f"每 {task['every_minutes']} 分钟" if task["every_minutes"] else f"每天 {task['daily']}"
    print(f"[√] 已建定时任务「{args.name}」：{节奏}，最长跑 {int(task['max_minutes'])} 分钟。")
    if allow:
        print(f"    已放行工具：{', '.join(allow)}（敲这条命令 = 你已审批）")
    print("    电脑重启并登录后照跑；查看：schedule list / schedule history " + args.name)
    return 0


def _outcome_cn(o: str) -> str:
    return {"done": "成功", "failed": "失败", "timeout": "超时被停", "interrupted": "被中断",
            "local_error": "启动失败(本地)",
            "skipped_overlap": "跳过(上次未完)", "skipped_disabled": "跳过(已暂停)",
            "skipped_killswitch": "跳过(总开关关)"}.get(o, o)


def _cmd_list(args) -> int:
    tasks = schedule.list_tasks()
    if not tasks:
        print("（还没有定时任务。用 schedule add 建一个。）")
        return 0
    print(f"共 {len(tasks)} 个定时任务：")
    for t in tasks:
        节奏 = f"每{t['every_minutes']}分钟" if t["every_minutes"] else f"每天{t['daily']}"
        状态 = "启用" if t.get("enabled", True) else "已暂停"
        hist = schedule.read_history(t["name"], n=1)
        上次 = (_outcome_cn(hist[-1]["outcome"]) + " @ " + hist[-1]["start"]) if hist else "还没跑过"
        print(f"  · {t['name']}　[{节奏} · {状态}]　上次：{上次}")
    return 0


def _cmd_run(args) -> int:
    return schedule.run_task(args.name)


def _cmd_history(args) -> int:
    recs = schedule.read_history(args.name, n=args.n)
    if not recs:
        print(f"「{args.name}」还没有执行记录。")
        return 0
    print(f"「{args.name}」最近 {len(recs)} 次执行：")
    for r in recs:
        denied = r.get("denied_calls")
        越权 = f"　越权尝试 {denied}" if denied else ""
        print(f"  {r['start']}　{_outcome_cn(r['outcome'])}　退出码 {r['exit_code']}　"
              f"{r.get('duration_s', 0)}s{越权}")
    return 0


def _cmd_pause(args) -> int:
    if not schedule.set_enabled(args.name, False):
        print(f"[×] 没有名为「{args.name}」的任务。")
        return 2
    try:
        scheduler_install.set_enabled_os(args.name, False)
    except Exception as e:  # 系统层禁用失败不致命：档案层已暂停，run 入口会双保险拦住
        print(f"[!] 系统调度器禁用未成（档案层已暂停，仍会被拦）：{e}")
    print(f"[√] 已暂停「{args.name}」。（暂停的是计划；要停正在跑的那次用 schedule stop）")
    return 0


def _cmd_resume(args) -> int:
    if not schedule.set_enabled(args.name, True):
        print(f"[×] 没有名为「{args.name}」的任务。")
        return 2
    try:
        scheduler_install.set_enabled_os(args.name, True)
    except Exception as e:
        print(f"[!] 系统调度器启用未成：{e}")
    print(f"[√] 已恢复「{args.name}」。")
    return 0


def _cmd_stop(args) -> int:
    return 0 if schedule.stop_task(args.name) else 1


def _cmd_remove(args) -> int:
    try:
        scheduler_install.uninstall(args.name)
    except Exception as e:
        print(f"[!] 从系统调度器卸载未成（继续归档档案）：{e}")
    if schedule.remove_task(args.name):
        print(f"[√] 已删除任务「{args.name}」（历史记录保留，可追溯）。")
        return 0
    print(f"[×] 没有名为「{args.name}」的任务。")
    return 2


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="run.py schedule", description="定时任务管理")
    sub = parser.add_subparsers(dest="cmd", required=True)

    padd = sub.add_parser("add", help="建一个定时任务（敲下即审批）")
    padd.add_argument("--name", required=True, help="任务名（中文/字母数字，≤40）")
    padd.add_argument("--prompt", required=True, help="任务内容（交给 agent 干的活）")
    padd.add_argument("--every", help="间隔节奏：30m / 1h（与 --daily 二选一）")
    padd.add_argument("--daily", help="每天定点：08:30（与 --every 二选一）")
    padd.add_argument("--allow", default="", help="放行的工具名，逗号分隔（如 write_file）")
    padd.add_argument("--workdir", help="工作区目录（默认=仓库根）")
    padd.add_argument("--max-minutes", dest="max_minutes", type=float, default=30,
                      help="墙钟总超时（分钟，默认 30；到点两阶段杀）")
    padd.add_argument("--mcp", action="store_true", help="允许连 mcp.json（默认定时任务不连）")
    padd.add_argument("--task-id", help="显式绑定现有 Task；触发时仅写入 TaskQueue")
    padd.add_argument("--policy-id", help="绑定 Task 时必填的无人执行策略 ID")
    padd.set_defaults(func=_cmd_add)

    for name, fn, helptext in [("run", _cmd_run, "立刻跑一次（也是系统调度器唤起的入口）"),
                               ("pause", _cmd_pause, "暂停（计划层，不杀正在跑的）"),
                               ("resume", _cmd_resume, "恢复暂停的任务"),
                               ("stop", _cmd_stop, "急停正在跑的那一次"),
                               ("remove", _cmd_remove, "删除任务（历史保留）")]:
        p = sub.add_parser(name, help=helptext)
        p.add_argument("name", help="任务名")
        p.set_defaults(func=fn)

    plist = sub.add_parser("list", help="列出所有定时任务")
    plist.set_defaults(func=_cmd_list)

    ph = sub.add_parser("history", help="看某任务的执行历史")
    ph.add_argument("name", help="任务名")
    ph.add_argument("-n", type=int, default=10, help="看最近几条（默认 10）")
    ph.set_defaults(func=_cmd_history)

    args = parser.parse_args(argv)
    return args.func(args)
