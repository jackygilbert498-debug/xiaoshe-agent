"""A6 · Hooks 生命周期自动化：在特定时机跑用户**预先配置**的命令，不靠模型自觉。

配置在 `.state/hooks.json`（**设为敏感文件——模型读写不了**，只有人手动配；否则注入=任意命令执行，这是命根子）。
跨语言：hook 是任意 shell 命令，收工具调用 JSON(stdin) → 输出决议 JSON(stdout)。空输出/非 JSON 一律放行。

- **PreToolUse**（闸）：工具执行前跑，可 `{"decision":"deny|ask|allow"}`——**只能收紧**（deny/ask），不能放松（allow 不越过正常权限闸）。
  收口进唯一派发入口 `agent._run_tool`。**fail-closed**：hook 报错/超时/坏输出 → 判 deny（闸评不了就挡）。
- **PostToolUse**（fire-and-forget）：工具执行后跑，忽略输出/错误（如「edit 后自动 gofmt」「会话里改了文档就同步」）。
- **SessionStart / SessionEnd**（fire-and-forget，生命周期）：REPL 起/止各跑一次（如「开工先 git pull」「收工把文档同步」）。
  无工具名 → 不看 matcher，event 下 command 全跑；payload 带 event + session_id。

配置格式：{"PreToolUse":[{"matcher":"run_command,write_file","command":"..."}], "PostToolUse":[{"matcher":"*","command":"..."}],
          "SessionStart":[{"command":"..."}], "SessionEnd":[{"command":"..."}]}
matcher：工具名 / 逗号分隔多个 / "*" 全部（仅 Pre/PostToolUse 用；生命周期事件忽略）。
"""
from __future__ import annotations

import json
import subprocess

from . import _io, config

HOOKS_FILE = config.STATE_DIR / "hooks.json"
_TIMEOUT = 10   # hook 子进程超时（秒），防挂死


def load_config(path=None) -> dict:
    """读 hooks 配置（坏档/缺档返 {}，绝不崩）。"""
    p = path if path is not None else HOOKS_FILE
    try:
        with open(p, encoding="utf-8") as f:   # with 关句柄，别泄漏 fd
            data = json.loads(f.read())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _matches(matcher: str, tool_name: str) -> bool:
    m = str(matcher or "").strip()
    if m == "*" or m == "":
        return True
    return tool_name in [x.strip() for x in m.split(",")]


def _default_runner(command: str, input_text: str):
    """跑一个 hook 命令：命令走 shell（用户配的、可信），工具调用 JSON 从 stdin 喂。返回 (rc, stdout, stderr)。

    诚实边界：timeout 只回收**直接 shell**——hook 若用 `&` 后台化或 fork 出子孙进程，超时后那些孤儿仍会存活跑完
    （跨平台，未做进程组收尸：killpg/setsid 仅 POSIX，且 hook 是用户预配可信、非注入面，故不值得为此引入 Windows 分支）。
    """
    r = subprocess.run(command, shell=True, input=input_text, capture_output=True, text=True, timeout=_TIMEOUT)
    return (r.returncode, r.stdout, r.stderr)


def has_hooks(event: str, path=None) -> bool:
    """该事件是否配了**至少一条可跑的 command**（供 UX 提示：有配才打「正在跑 hook…」，消除同步阻塞期的疑似卡死观感）。"""
    cfg = load_config(path)
    lst = cfg.get(event) if isinstance(cfg, dict) else None
    if not isinstance(lst, list):
        return False
    return any(isinstance(h, dict) and isinstance(h.get("command"), str) and h["command"].strip() for h in lst)


def eval_pretool(tool_name: str, args, path=None, runner=None) -> str | None:
    """跑匹配的 PreToolUse hook，返回收紧决议：'deny' / 'ask' / None(不干预)。

    多个 hook：任一 deny → deny；任一 ask → ask；否则 None。fail-closed：任一 hook 报错/超时/坏输出 → deny。
    """
    cfg = load_config(path)
    hooks = cfg.get("PreToolUse") if isinstance(cfg, dict) else None
    if not isinstance(hooks, list):
        return None
    runner = runner or _default_runner
    payload = _payload(tool_name, args)
    verdict = None
    for h in hooks:
        if not isinstance(h, dict) or not _matches(h.get("matcher", "*"), tool_name):
            continue
        cmd = h.get("command")
        if not isinstance(cmd, str) or not cmd.strip():
            continue
        try:
            rc, out, _err = runner(cmd, payload)
        except Exception:
            return "deny"   # fail-closed：闸评不了就挡（安全优先）
        d = _parse_decision(out)
        if d == "deny":
            return "deny"
        if d == "ask":
            verdict = "ask"
        elif d is None:   # 坏输出（非 allow 的无法解析）→ fail-closed
            return "deny"
    return verdict


def run_posttool(tool_name: str, args, path=None, runner=None) -> None:
    """跑匹配的 PostToolUse hook（fire-and-forget，忽略输出/错误——收尾自动化不该阻断主流程）。"""
    cfg = load_config(path)
    hooks = cfg.get("PostToolUse") if isinstance(cfg, dict) else None
    if not isinstance(hooks, list):
        return
    runner = runner or _default_runner
    payload = _payload(tool_name, args)
    for h in hooks:
        if not isinstance(h, dict) or not _matches(h.get("matcher", "*"), tool_name):
            continue
        cmd = h.get("command")
        if isinstance(cmd, str) and cmd.strip():
            try:
                runner(cmd, payload)
            except Exception:
                pass   # 忽略（fire-and-forget）


def run_session(event: str, extra=None, path=None, runner=None) -> None:
    """跑会话生命周期 hook（SessionStart/SessionEnd）：**同步**执行、忽略输出/错误、不冒泡异常。

    "fire-and-forget" 仅指「吞输出/异常」——不是异步：本函数会**阻塞调用者**，单 hook 上限 _TIMEOUT(10s)、
    多 hook 串行累加。这是刻意的：SessionEnd「退出前把文档同步完」必须同步跑完（异步会被进程退出切断），
    SessionStart「开工先 git pull」也通常想跑完再开工。UX 上由 repl 在跑前打一行提示，避免误认为卡死。
    生命周期事件无「工具名」，故不看 matcher：event 键下所有 command 全跑。extra(dict) 并入 payload（如 session_id）。
    """
    cfg = load_config(path)
    hooks = cfg.get(event) if isinstance(cfg, dict) else None
    if not isinstance(hooks, list):
        return
    runner = runner or _default_runner
    payload = _session_payload(event, extra)
    for h in hooks:
        if not isinstance(h, dict):
            continue
        cmd = h.get("command")
        if isinstance(cmd, str) and cmd.strip():
            try:
                runner(cmd, payload)
            except Exception:
                pass   # 忽略（fire-and-forget，收尾自动化不该冒泡）


def _session_payload(event, extra) -> str:
    obj = {"event": event}
    if isinstance(extra, dict):
        obj.update(extra)
    try:
        return json.dumps(obj, ensure_ascii=False)
    except (TypeError, ValueError):
        return json.dumps({"event": event}, ensure_ascii=False)


def _payload(tool_name, args) -> str:
    try:
        return json.dumps({"tool": tool_name, "args": args}, ensure_ascii=False)
    except (TypeError, ValueError):
        return json.dumps({"tool": tool_name, "args": str(args)}, ensure_ascii=False)


def _parse_decision(stdout: str):
    """从 hook stdout 解析决议：JSON {"decision":"deny|ask|allow"}。空/非JSON/allow → None(不干预)；deny/ask → 该值。"""
    s = str(stdout or "").strip()
    if not s:
        return "allow_empty"   # 空输出=放行（不干预），用哨兵区别「坏输出」
    try:
        obj = json.loads(s)
    except json.JSONDecodeError:
        return "allow_empty"   # 非 JSON 一律放行（跨语言宽容，别因输出格式挡活）
    d = obj.get("decision") if isinstance(obj, dict) else None
    if d in ("deny", "ask"):
        return d
    if d in ("allow", None):
        return "allow_empty"
    return None   # 认得是 JSON 但 decision 值异常 → 交给调用方 fail-closed
