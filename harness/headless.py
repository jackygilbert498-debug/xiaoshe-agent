"""无头模式（M2）：一条命令进、结果出，免值守。

安全语义：
- 无人值守，approver 恒拒——危险工具默认全拒（继承「无 TTY 默认 deny」拍板）。
- --allow 显式放行 = 敲命令的人在那一刻完成的审批（创建时刻=审批时刻），
  预填进会话白名单 ctx["_approved_tools"]，与交互模式答 'a' 是同一机制，粒度到工具名。
- 硬护栏（路径越界 / 敏感文件 / 命令密钥扫描）任何模式下不可放行。
- 拒绝话术如实：白名单外的 ask 在 permission 层落成 deny，说明「无头模式无用户在场 + 指向 --allow」，
  不谎称「用户拒绝了」（D3 P2-5）；force_ask（混淆管道等）连白名单内也照拒。
- --workdir 把本次运行的工作区 ROOT 切到指定目录（敲命令的人自选；用完恢复）。
- 全程留痕：会话档案 headless-<id>.json + 独立日志 .state/logs/headless-<id>.jsonl。

注意：run_headless 假定独占进程——结束时会做进程级清理（jobs/MCP 全部关停）。
非 KimiError 的异常会原样冒泡（traceback + 非零退出码），便于排障；KimiError 收敛为退出码 1；
Ctrl+C（KeyboardInterrupt）例外：温和收尾不甩 traceback，退出码 130（128+SIGINT 惯例）。
"""
from __future__ import annotations

import contextlib
import os
import sys
from pathlib import Path

from . import _io, agent, jobs, mcp_client, memory, netguard, notes, permission, session
from . import tools as tools_mod
from .kimi_client import KimiError
from .kimi_client import chat as kimi_chat


def _deny_all(tool_name, args, reason):
    return False  # 无头模式没有人可问：白名单外一律拒


def _print_reply(text: str) -> None:
    try:
        print(text)
    except UnicodeEncodeError:  # GBK 等窄编码终端：宁可替换字符也不崩
        enc = sys.stdout.encoding or "utf-8"
        print(text.encode(enc, errors="replace").decode(enc, errors="replace"))


def _write_run_summary(ctx: dict, sid: str) -> None:
    """把本次运行摘要写到 HARNESS_RUN_SUMMARY 指定的文件（调度监工用；没设该环境变量就什么都不做）。

    denied_calls 是无人值守下的越权信号灯：被安全策略/白名单拒绝的调用次数。
    """
    path = os.environ.get("HARNESS_RUN_SUMMARY")
    if not path:
        return
    try:
        _io.atomic_write_json(path, {"denied_calls": ctx.get("_denied_calls", 0), "session_id": sid,
                                     # D1-1b 审计可见：工具子进程出网被白名单拒掉的次数与目的地
                                     "net_denied": netguard.denied_count(),
                                     "net_denied_hosts": sorted({r["host"] for r in netguard.audit_denied()})})
    except OSError as e:
        _io.warn(f"[!] 运行摘要写入失败（任务本身不受影响）：{e}")


def run_headless(prompt: str, allow: tuple[str, ...] = (), workdir: str | None = None,
                 model_fn=kimi_chat, no_mcp: bool = False,
                 session_prefix: str = "headless-") -> int:
    """免值守跑完一条任务：结果打到 stdout，返回进程退出码（0=完成，1=出错/参数非法）。"""
    root_cm = contextlib.nullcontext()
    if workdir:
        wd = Path(workdir).expanduser().resolve()
        if not wd.is_dir():
            _io.warn(f"[!] --workdir 不是一个目录：{wd}")
            return 1
        if ".state" in (part.lower() for part in wd.parts):
            # D3 P0-2：.state 整树硬拒是铁律（不动）——workdir 放它下面 = 文件类工具静默全灭（污染跑 T1 实锤），
            # 启动时说破，省得挖会话转录才知道根因。只告警不拒启动（workdir 是敲命令的人自选的）。
            _io.warn("[!] --workdir 落在 .state 内部状态树里：敏感文件硬护栏（铁律）会把 read/write/edit 等"
                     "文件类工具全拒，任务大概率全灭——请把 workdir 挪出 .state（评测沙盒用 .d3/）。")
        root_cm = permission.use_root(wd)  # 上下文覆盖，不改全局 ROOT（#33）
    unknown = [t for t in allow if t not in tools_mod.REGISTRY and not t.startswith("mcp__")]
    if unknown:
        _io.warn(f"[!] --allow 里有不认识的工具名（不会生效）：{', '.join(unknown)}")
    if "run_command" in allow or "run_in_background" in allow:
        _io.warn("[i] 已放行命令执行工具——命令文本的密钥扫描硬护栏仍然生效。")
        # D1-1b：把出网管控口径说破——open 是显式降级（子进程继承全量环境、出网不受控），红字级告警
        if netguard._TOOL_NET_MODE == "open":
            _io.warn("[!] TOOL_NET_MODE=open：工具子进程出网**不受管控**（继承全量环境、可直连外网）——"
                     "「放行命令执行」等于同时打开联网出口，注入成功即可外带数据。仅本地信任场景使用。")
        else:
            allow_desc = netguard._TOOL_NET_ALLOW or "（空=全拒）"
            _io.warn(f"[i] 工具子进程出网管控：TOOL_NET_MODE={netguard._TOOL_NET_MODE}，白名单 {allow_desc}"
                     "（出网经受控代理 + 环境擦除；off=零出网）。")
    sid = session.new_session_id(session_prefix)
    log_file = session.session_log_file(sid)
    ctx = {"todos": [], "memory_file": memory.MEMORY_FILE,
           "session_id": sid,  # 与交互 repl 对齐：后续 notes/episodic 等按 session_id 落盘的特性无头也要能用
           "_approved_tools": set(allow)}
    msg = memory.system_message()
    history = [msg] if msg else []
    if model_fn is kimi_chat:            # 只对真 Kimi 布线 cache_key（无头也走 prompt 缓存，与 repl 对齐）
        def _model(messages, tools=None, **kw):
            kw.setdefault("cache_key", sid)
            return kimi_chat(messages, tools=tools, **kw)
    else:
        _model = model_fn                # 自定义/脚本模型：原样调用，别强塞 cache_key
    try:
        with root_cm, permission.headless_mode(allow):  # workdir 覆盖只在本上下文生效，退出即复位（不动全局 ROOT，#33）
                                                          # headless_mode：白名单外的 ask 如实落成 deny（D3 P2-5）
            if not no_mcp:
                mcp_client.connect_configured()  # 有 mcp.json 就接上（工具仍受白名单管）；定时任务默认 --no-mcp
            n_ut, ut_problems = tools_mod.load_user_tools()  # A2b：装载已批准自定义工具（哈希校验），无头/定时任务也能用
            for p in ut_problems:
                _io.warn(f"[!] 自定义工具：{p}")
            reply = agent.run_once(prompt, history, model_fn=_model,
                                   approver=_deny_all, log_file=log_file, ctx=ctx)
            _print_reply(reply)
            if agent._ends_clean(history):
                try:
                    session.save_session(sid, history, ctx.get("todos", []), notes.current(ctx))
                except OSError as e:
                    _io.warn(f"[!] 会话存档失败（结果已输出，不影响本次）：{e}")
            return 0
    except KimiError as e:
        _io.warn(f"[!] 无头任务失败：{e}")
        return 1
    except KeyboardInterrupt:
        # 与交互模式的「再见。」同一调性：温和收尾不甩 traceback；130=128+SIGINT 惯例，
        # 让调度器/脚本能区分「被人中断」和「自己失败」（finally 清理照常执行）
        _io.warn("[i] 已中断无头任务，正在清理收尾。")
        return 130
    finally:
        _write_run_summary(ctx, sid)  # 成功/失败/被中断都写：监工要的就是真相
        netguard.stop()  # D1-1b：过滤代理随会话收尾（proxy 档才起过 server，off/open 是 no-op）
        tools_mod.unload_user_tools()  # 独占进程收尾：清掉自定义工具免问集，别泄给进程内后续调用
        jobs.shutdown()
        mcp_client.shutdown()
