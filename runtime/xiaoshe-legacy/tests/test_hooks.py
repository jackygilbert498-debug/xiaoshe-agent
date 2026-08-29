"""A6 · Hooks 生命周期自动化。TDD 红→绿。

PreToolUse 闸（只收紧、fail-closed）+ PostToolUse fire-and-forget，跨子进程 stdout JSON 协议。
安全命根：hooks 配置模型读写不了。
运行：仓库根 `python -m unittest tests.test_hooks -v`
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import hooks, permission


def _cfg(d, data):
    p = Path(d) / "hooks.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


class PreToolUse闸(unittest.TestCase):
    def test_deny拦截(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"PreToolUse": [{"matcher": "run_command", "command": "x"}]})
            r = lambda cmd, inp: (0, '{"decision":"deny"}', "")
            self.assertEqual(hooks.eval_pretool("run_command", {"command": "rm"}, path=p, runner=r), "deny")

    def test_ask升级(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"PreToolUse": [{"matcher": "*", "command": "x"}]})
            r = lambda cmd, inp: (0, '{"decision":"ask"}', "")
            self.assertEqual(hooks.eval_pretool("read_file", {"path": "a"}, path=p, runner=r), "ask")

    def test_allow或空输出放行(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"PreToolUse": [{"matcher": "*", "command": "x"}]})
            self.assertIsNone(hooks.eval_pretool("read_file", {}, path=p, runner=lambda c, i: (0, '{"decision":"allow"}', "")))
            self.assertIsNone(hooks.eval_pretool("read_file", {}, path=p, runner=lambda c, i: (0, "", "")))          # 空输出
            self.assertIsNone(hooks.eval_pretool("read_file", {}, path=p, runner=lambda c, i: (0, "随便打印的", "")))  # 非 JSON 宽容放行

    def test_matcher不匹配不跑hook(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"PreToolUse": [{"matcher": "write_file", "command": "x"}]})
            called = []
            hooks.eval_pretool("run_command", {"command": "x"}, path=p, runner=lambda c, i: called.append(1) or (0, "", ""))
            self.assertEqual(called, [])   # 工具不匹配 matcher → hook 不跑

    def test_hook报错fail_closed判deny(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"PreToolUse": [{"matcher": "*", "command": "x"}]})
            def boom(cmd, inp):
                raise RuntimeError("hook 挂了")
            self.assertEqual(hooks.eval_pretool("run_command", {}, path=p, runner=boom), "deny")   # 闸评不了→挡

    def test_坏decision值fail_closed判deny(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"PreToolUse": [{"matcher": "*", "command": "x"}]})
            r = lambda cmd, inp: (0, '{"decision":"whatever"}', "")   # 认得 JSON 但值异常
            self.assertEqual(hooks.eval_pretool("run_command", {}, path=p, runner=r), "deny")

    def test_无配置无hook放行(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(hooks.eval_pretool("run_command", {}, path=Path(d) / "nope.json"))

    def test_payload把工具与参数喂给hook(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"PreToolUse": [{"matcher": "*", "command": "x"}]})
            seen = {}
            def cap(cmd, inp):
                seen["inp"] = inp
                return (0, "", "")
            hooks.eval_pretool("run_command", {"command": "ls"}, path=p, runner=cap)
            obj = json.loads(seen["inp"])
            self.assertEqual(obj["tool"], "run_command")
            self.assertEqual(obj["args"]["command"], "ls")


class PostToolUse(unittest.TestCase):
    def test_fire_and_forget_报错不冒泡(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"PostToolUse": [{"matcher": "edit", "command": "gofmt"}]})
            called = []
            def r(cmd, inp):
                called.append(cmd)
                raise RuntimeError("hook 挂")   # 错误应被吞
            hooks.run_posttool("edit", {"path": "a.go"}, path=p, runner=r)   # 不抛即通过
            self.assertEqual(called, ["gofmt"])


class Session生命周期(unittest.TestCase):
    def test_SessionStart跑配置命令且payload带event(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"SessionStart": [{"command": "prep"}]})
            seen = {}
            def cap(cmd, inp):
                seen["cmd"] = cmd
                seen["inp"] = inp
                return (0, "", "")
            hooks.run_session("SessionStart", path=p, runner=cap)
            self.assertEqual(seen["cmd"], "prep")
            self.assertEqual(json.loads(seen["inp"])["event"], "SessionStart")

    def test_SessionEnd跑配置命令(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"SessionEnd": [{"command": "sync-docs"}]})
            called = []
            hooks.run_session("SessionEnd", path=p, runner=lambda c, i: called.append(c) or (0, "", ""))
            self.assertEqual(called, ["sync-docs"])

    def test_extra并入payload(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"SessionEnd": [{"command": "x"}]})
            seen = {}
            hooks.run_session("SessionEnd", extra={"session_id": "s-123"}, path=p,
                              runner=lambda c, i: seen.update(json.loads(i)) or (0, "", ""))
            self.assertEqual(seen["event"], "SessionEnd")
            self.assertEqual(seen["session_id"], "s-123")

    def test_fire_and_forget_报错不冒泡(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"SessionStart": [{"command": "x"}]})
            def boom(c, i):
                raise RuntimeError("hook 挂了")
            hooks.run_session("SessionStart", path=p, runner=boom)   # 不抛即通过

    def test_无配置不跑(self):
        with tempfile.TemporaryDirectory() as d:
            called = []
            hooks.run_session("SessionStart", path=Path(d) / "nope.json",
                              runner=lambda c, i: called.append(1) or (0, "", ""))
            self.assertEqual(called, [])

    def test_多命令全跑(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"SessionEnd": [{"command": "a"}, {"command": "b"}]})
            called = []
            hooks.run_session("SessionEnd", path=p, runner=lambda c, i: called.append(c) or (0, "", ""))
            self.assertEqual(called, ["a", "b"])

    def test_别的事件不误触(self):
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"SessionStart": [{"command": "x"}]})   # 只配了 SessionStart
            called = []
            hooks.run_session("SessionEnd", path=p, runner=lambda c, i: called.append(1) or (0, "", ""))
            self.assertEqual(called, [])   # 跑 SessionEnd 不该触发 SessionStart 的命令

    def test_has_hooks判断事件是否配了(self):
        # UX 提示用：有配才打「正在跑 hook…」，消除同步阻塞期的"疑似卡死"观感。
        with tempfile.TemporaryDirectory() as d:
            p = _cfg(d, {"SessionEnd": [{"command": "x"}], "SessionStart": [], "PostToolUse": [{"matcher": "*"}]})
            self.assertTrue(hooks.has_hooks("SessionEnd", path=p))
            self.assertFalse(hooks.has_hooks("SessionStart", path=p))   # 空 list = 没有可跑的
            self.assertFalse(hooks.has_hooks("PreToolUse", path=p))     # 没配这个 key
            self.assertFalse(hooks.has_hooks("PostToolUse", path=p))    # 有 entry 但无 command → 不算
            self.assertFalse(hooks.has_hooks("SessionEnd", path=Path(d) / "nope.json"))  # 无档


class Session_hook接线(unittest.TestCase):
    def test_helper把session_id并入并调run_session(self):
        from harness import agent
        seen = {}
        with mock.patch.object(hooks, "run_session",
                               lambda event, extra=None, **k: seen.update({"event": event, "extra": extra})):
            agent._fire_session_hook("SessionStart", {"session_id": "sid-1"})
        self.assertEqual(seen["event"], "SessionStart")
        self.assertEqual(seen["extra"], {"session_id": "sid-1"})

    def test_helper吞异常不冒泡(self):
        from harness import agent
        with mock.patch.object(hooks, "run_session", side_effect=RuntimeError("挂")):
            agent._fire_session_hook("SessionEnd", {"session_id": "s"})   # 不抛即通过

    def test_repl起止各触发一次且顺序对(self):
        from harness import agent
        events = []
        with mock.patch.object(agent, "_fire_session_hook", lambda ev, ctx: events.append(ev)), \
             mock.patch.object(agent.config, "API_KEY", "k"), \
             mock.patch.object(agent, "print_welcome", lambda: None), \
             mock.patch.object(agent.session, "migrate_legacy", lambda: None), \
             mock.patch.object(agent.session, "list_sessions", lambda: []), \
             mock.patch.object(agent.session, "new_session_id", lambda: "sid-x"), \
             mock.patch.object(agent.session, "session_log_file", lambda sid: Path(tempfile.gettempdir()) / "l"), \
             mock.patch.object(agent.jobs, "reconcile", lambda: None), \
             mock.patch.object(agent.jobs, "shutdown", lambda: None), \
             mock.patch.object(agent.mcp_client, "connect_configured", lambda: 0), \
             mock.patch.object(agent.mcp_client, "shutdown", lambda: None), \
             mock.patch("builtins.input", side_effect=["exit"]):
            agent.repl()
        self.assertEqual(events, ["SessionStart", "SessionEnd"])   # 起→止，且 End 经 finally 必达

    def test_SessionEnd在jobs和mcp收尾之后触发(self):
        # 红队 MED：SessionEnd 若在 jobs.shutdown/mcp shutdown 之前跑，「退出时同步文档」的 hook 会看到
        # 后台任务还 running、产物文件写了一半的撕裂状态。须**最后**触发——让后台 settle、进程收尸后再同步。
        from harness import agent
        order = []
        def fire(ev, ctx):
            if ev == "SessionEnd":
                order.append("SessionEnd")
        with mock.patch.object(agent, "_fire_session_hook", fire), \
             mock.patch.object(agent.config, "API_KEY", "k"), \
             mock.patch.object(agent, "print_welcome", lambda: None), \
             mock.patch.object(agent.session, "migrate_legacy", lambda: None), \
             mock.patch.object(agent.session, "list_sessions", lambda: []), \
             mock.patch.object(agent.session, "new_session_id", lambda: "sid-x"), \
             mock.patch.object(agent.session, "session_log_file", lambda sid: Path(tempfile.gettempdir()) / "l"), \
             mock.patch.object(agent.jobs, "reconcile", lambda: None), \
             mock.patch.object(agent.jobs, "shutdown", lambda: order.append("jobs.shutdown")), \
             mock.patch.object(agent.mcp_client, "connect_configured", lambda: 0), \
             mock.patch.object(agent.mcp_client, "shutdown", lambda: order.append("mcp.shutdown")), \
             mock.patch("builtins.input", side_effect=["exit"]):
            agent.repl()
        self.assertEqual(order[-1], "SessionEnd")   # SessionEnd 最后一个
        self.assertLess(order.index("jobs.shutdown"), order.index("SessionEnd"))
        self.assertLess(order.index("mcp.shutdown"), order.index("SessionEnd"))


class Hooks配置安全(unittest.TestCase):
    def test_hooks配置模型写不了_命根子(self):
        # 模型能写 hooks.json = 注入即任意命令执行——必须硬拒。
        self.assertEqual(permission.check("write_file", {"path": ".state/hooks.json", "content": "x"}).action, "deny")
        self.assertEqual(permission.check("edit", {"path": ".state/hooks.json"}).action, "deny")
        self.assertEqual(permission.check("read_file", {"path": "hooks.json"}).action, "deny")

    def test_红队HIGH_shell重定向写hooks配置被硬拒(self):
        # 命令文本扫描是 shell 绕不过的后backstop——hooks.json 须与 mcp.json 同级 deny（否则 echo > 绕过 path 闸）。
        self.assertEqual(permission.check("run_command", {"command": "echo x > .state/hooks.json"}).action, "deny")
        self.assertEqual(permission.check("run_command", {"command": "cat > hooks.json"}).action, "deny")
        self.assertEqual(permission.check("press_keys", {"keys": "echo x > .state/hooks.json{ENTER}"}).action, "deny")

    def test_红队HIGH_通配符绕过命根子硬拒(self):
        # A6增量2 红队 HIGH：shell 先做通配展开，令 `hooks.json` 字面被 `hooks.js*` 代替躲过字面扫描——
        # 命根子/凭据类 token 之前不在通配检测里（只覆盖 dotfile/id_），deny 被降级 ask，headless --allow run_command 下静默改写/读泄漏。
        for cmd in ("cat hooks.js*", "echo x > mcp.js*", "cat secrets.js*", "cat credential*",
                    "cat .state/hooks.js*", "cat .state/schedul*"):
            self.assertEqual(permission.check("run_command", {"command": cmd}).action, "deny", cmd)

    def test_通配检测不误伤良性glob且保住dotfile底2(self):
        # 修法须用「按 token 类型分档」的前缀下限（dotfile/id_ 仍用 2，长词 token 用 4），不能一刀切 range(4,)——
        # 否则 `.env`(长4) 的 `.e*` 检测会被抹掉（范围空）。这里锁死两端：底 2 保住 + 长词不误伤短前缀。
        self.assertEqual(permission.check("run_command", {"command": "cat .e*"}).action, "deny")        # dotfile 底2 仍在
        # 良性 glob 不能被误判 deny——尤其 `state` 是常见词/目录名，公共词干不得单独触发（分隔符感知下限）。
        for benign in ("ls *.py", "git status", "ls src/*", "cat state/foo*", "chmod cr*", "ls mc*",
                       "cat docs/state*", "cat mystate*", "ls state*", "cat src/config*"):
            self.assertNotEqual(permission.check("run_command", {"command": benign}).action, "deny", benign)


class Hook收紧强度(unittest.TestCase):
    def test_红队MED_hook_ask对已白名单工具仍强制复问(self):
        from harness import agent
        with tempfile.TemporaryDirectory() as d:
            cfg = _cfg(d, {"PreToolUse": [{"matcher": "run_command", "command": "x"}]})
            with mock.patch.object(hooks, "HOOKS_FILE", cfg), \
                 mock.patch.object(hooks, "_default_runner", lambda c, i: (0, '{"decision":"ask"}', "")):
                called = []
                ctx = {"_approved_tools": {"run_command:echo hi"}}   # 已被 'a' 白名单化
                _c, _e, executed = agent._run_tool("run_command", {"command": "echo hi"}, ctx,
                                                    lambda *a: called.append(1) or False, Path(d) / "l")
                self.assertEqual(len(called), 1)   # hook 的 ask 升 force_ask → 绕过白名单、重新问
                self.assertFalse(executed)

    def test_红队LOW_hooks异常fail_closed强制复问(self):
        from harness import agent
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(permission, "ROOT", Path(d)), \
                 mock.patch.object(hooks, "eval_pretool", side_effect=RuntimeError("坏")):
                (Path(d) / "a.txt").write_text("x", encoding="utf-8")
                called = []
                _c, _e, executed = agent._run_tool("read_file", {"path": "a.txt"}, {},
                                                    lambda *a: called.append(1) or False, Path(d) / "l")
                self.assertEqual(len(called), 1)   # hooks 系统异常 → read_file(本SAFE)升 force_ask→问（非静默放行）
                self.assertFalse(executed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
