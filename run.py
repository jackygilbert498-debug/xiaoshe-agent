"""入口：默认交互对话；-p 进无头模式；schedule 子命令管定时任务。

用法：
  python run.py                                交互对话（一切如旧）
  python run.py -p "看看 README 讲了啥"          无头跑一条任务后退出
  python run.py -p "整理下载目录" --allow write_file --workdir ~/Downloads
  python run.py --task-id tsk_x --policy-id policy_x --request-id req_x
  python run.py schedule add --name 报时 --prompt "记一行时间戳" --every 1h --allow write_file
  python run.py schedule list / history 报时 / pause 报时 / stop 报时 / remove 报时
  python run.py cost [会话id]                    看每会话的请求/token/缓存命中统计（按请求计费）
  python run.py backup [输出文件]                 把运行态(.state)打成 .tar.gz 备份（默认带时间戳）
  python run.py backup restore <备份> [--force]  从备份还原运行态（非空目标须 --force）
  python run.py skills [approve|discard <编号>]    看技能库（正式+待审）；批准/丢弃后台自学的待审技能
"""
import argparse
import sys
from datetime import UTC, datetime

from harness.agent import repl
from harness.headless import run_headless


def main() -> int:
    # Windows：输出被管道/重定向捕获时，Python 默认用本地 ANSI 码页（中文机=GBK）编码中文，
    # 上游按 UTF-8 读我们的输出会解码炸裂（调度器/测试捕获无头子进程 stdout 即此场景）。
    # 交互真控制台走 UTF-16、isatty 为真，保持不动（尊重仓库「GBK 终端也不崩」的取向）；
    # 仅当被管道/重定向时把 stdout/stderr 钉成 UTF-8，让上游拿到确定性字节。
    if sys.platform == "win32":
        for _stream in (sys.stdout, sys.stderr):
            try:
                if not _stream.isatty():
                    _stream.reconfigure(encoding="utf-8")
            except (AttributeError, ValueError, OSError):
                pass
    if len(sys.argv) >= 2 and sys.argv[1] == "schedule":
        from harness.schedule_cli import main as schedule_main
        return schedule_main(sys.argv[2:])
    if len(sys.argv) >= 2 and sys.argv[1] == "cost":
        from harness import usage_report
        print(usage_report.report(sys.argv[2] if len(sys.argv) >= 3 else None))
        return 0
    if len(sys.argv) >= 2 and sys.argv[1] == "backup":
        import time as _t

        from harness import backup
        rest = sys.argv[2:]
        if rest and rest[0] == "restore":                # 恢复
            if len(rest) < 2:
                print("用法：python run.py backup restore <备份文件.tar.gz> [--force]")
                return 2
            ok, msg = backup.restore_backup(rest[1], force=("--force" in rest))
            print(msg)
            return 0 if ok else 1
        dest = rest[0] if rest else f"小蛇备份-{_t.strftime('%Y%m%d-%H%M%S')}.tar.gz"   # 备份
        p = backup.create_backup(dest)
        print(f"已备份运行态(.state)到 {p}\n换机/误删后用 `python run.py backup restore {p} --force` 还原")
        return 0
    if len(sys.argv) >= 2 and sys.argv[1] == "skills":
        from harness import selflearn   # A2a 后台自学人审门：看技能库 / 批准 / 丢弃待审技能
        return selflearn.cli(sys.argv[2:])
    if len(sys.argv) >= 2 and sys.argv[1] == "serve":
        from harness import ui_server   # 小蛇界面桥接服务（仅本机回环 + 配对 token，SPEC §7/§9）
        return ui_server.serve_main(sys.argv[2:])   # --port 7788 / --no-browser / --no-mcp
    parser = argparse.ArgumentParser(
        prog="run.py", description="小蛇：你自己的 agent（无参数=交互对话）")
    parser.add_argument("-p", "--prompt",
                        help="无头模式：免值守跑完这一条任务后退出")
    parser.add_argument("--allow", default="",
                        help="无头模式放行的工具名，逗号分隔（如 write_file,run_command）；敲下即视为审批")
    parser.add_argument("--workdir",
                        help="无头模式的工作区目录（默认=仓库根；敏感文件硬护栏仍生效）")
    parser.add_argument("--no-mcp", action="store_true",
                        help="无头模式不连 mcp.json 里的 server（定时任务默认带上）")
    parser.add_argument("--session-prefix", default="headless-",
                        help="无头会话档案的 id 前缀（调度器内部使用，勿含路径分隔符）")
    parser.add_argument("--task-id", help="显式把一次无头触发写入现有 TaskQueue（不直接执行）")
    parser.add_argument("--policy-id", help="TaskQueue 无人执行策略 ID；与 --task-id 同时提供")
    parser.add_argument("--request-id", help="调用方提供的稳定请求 ID；与 --task-id 同时提供")
    args = parser.parse_args()
    bound = (args.task_id, args.policy_id, args.request_id)
    if any(value is not None for value in bound):
        if not all(isinstance(value, str) and value.strip() for value in bound):
            parser.error("--task-id、--policy-id、--request-id 必须同时提供")
        if args.prompt is not None or args.allow or args.workdir or args.no_mcp or args.session_prefix != "headless-":
            parser.error("TaskQueue 触发不接受 -p/--allow/--workdir/--no-mcp/--session-prefix；任务定义和批准计划是唯一执行来源")
        from harness import config
        if config.tasking_mode() != "on":
            parser.error("TaskQueue 触发需要 XIAOSHE_TASKING_V2=on")
        from harness.task_store import TaskStore
        from harness.task_triggers import TaskingTriggerBridge
        store = TaskStore(config.ROOT / ".state" / "tasking" / "tasks.db")
        result = TaskingTriggerBridge(store).headless_enqueue(args.task_id, args.request_id, args.policy_id, datetime.now(UTC))
        print(f"已进入 TaskQueue：{result.queue_item_id}（保持小蛇运行以领取执行）")
        return 0
    if args.prompt is not None:
        if not args.prompt.strip():
            parser.error("-p 任务不能为空")
        if any(c in args.session_prefix for c in "/\\") or ".." in args.session_prefix:
            parser.error("--session-prefix 不能包含路径分隔符")
        allow = tuple(t.strip() for t in args.allow.split(",") if t.strip())
        return run_headless(args.prompt, allow=allow, workdir=args.workdir,
                            no_mcp=args.no_mcp, session_prefix=args.session_prefix)
    if args.allow or args.workdir or args.no_mcp or args.session_prefix != "headless-":
        parser.error("--allow/--workdir/--no-mcp/--session-prefix 只在 -p 无头模式下有效")
    repl()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
