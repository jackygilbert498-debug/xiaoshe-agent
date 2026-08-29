"""阶段1 冒烟测试：工具 + 权限闸门 + 多轮工具循环（测试名全中文，看名字 + 绿/红即可验收）。

离线用「脚本模型」（按预设逐次返回，不连网）驱动整条工具循环；
用 patch 把工作区 ROOT 换成临时目录，避免污染真仓库。
运行：在仓库根目录下 `python -m unittest discover -s tests -v`
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from harness import agent, config, kimi_client, permission
from harness import tools as tools_mod


def _tc(name, args_dict, tc_id="tool_1"):
    """造一个跟真机同格式的 tool_call。"""
    return {"index": 0, "id": tc_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(args_dict, ensure_ascii=False)}}


class 脚本模型:
    """按预设脚本逐次返回：每被调用一次就弹出下一个响应。"""

    def __init__(self, responses):
        self.responses = list(responses)

    def __call__(self, messages, tools=None):
        return self.responses.pop(0)


def _拒绝一切(*_a):
    raise AssertionError("此工具不该问用户（应被放行或被硬拒）")


class 工具与循环(unittest.TestCase):
    def test_模型要调read_file_能读到文件内容再接着回话(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "hello.txt").write_text("内容ABC", encoding="utf-8")
            with mock.patch.object(permission, "ROOT", root):
                model = 脚本模型([
                    {"content": "", "tool_calls": [_tc("read_file", {"path": "hello.txt"})]},
                    {"content": "文件里是内容ABC", "tool_calls": []},
                ])
                history: list[dict] = []
                reply = agent.run_once("读一下 hello.txt", history, model_fn=model,
                                       approver=_拒绝一切, log_file=root / "l.jsonl")
        self.assertEqual(reply, "文件里是内容ABC")
        tool_msgs = [m for m in history if m.get("role") == "tool"]
        self.assertTrue(tool_msgs and "内容ABC" in tool_msgs[0]["content"])

    def test_读文件是只读白名单_直接放行不打扰用户(self):
        # 上一条已用 approver=_拒绝一切 证明 read_file 未触发询问；这里再单独断言决议为 approve
        self.assertEqual(permission.check("read_file", {"path": "whatever.txt"}).action, "approve")

    def test_多轮工具循环_直到模型不再要工具才返回最终文本(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "a.txt").write_text("A", encoding="utf-8")
            (root / "b.txt").write_text("B", encoding="utf-8")
            with mock.patch.object(permission, "ROOT", root):
                model = 脚本模型([
                    {"content": "", "tool_calls": [_tc("read_file", {"path": "a.txt"}, "t1")]},
                    {"content": "", "tool_calls": [_tc("read_file", {"path": "b.txt"}, "t2")]},
                    {"content": "两个都读完了", "tool_calls": []},
                ])
                reply = agent.run_once("读 a 和 b", [], model_fn=model,
                                       approver=_拒绝一切, log_file=root / "l.jsonl")
        self.assertEqual(reply, "两个都读完了")


class 权限闸门(unittest.TestCase):
    def test_写文件_用户答y_才真的落盘(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with mock.patch.object(permission, "ROOT", root):
                model = 脚本模型([
                    {"content": "", "tool_calls": [_tc("write_file", {"path": "out.txt", "content": "写入内容X"})]},
                    {"content": "写好了", "tool_calls": []},
                ])
                reply = agent.run_once("写个文件", [], model_fn=model,
                                       approver=lambda *a: True, log_file=root / "l.jsonl")
                self.assertEqual(reply, "写好了")
                self.assertTrue((root / "out.txt").exists())
                self.assertEqual((root / "out.txt").read_text(encoding="utf-8"), "写入内容X")

    def test_写文件_用户答n_不落盘且把拒绝回给模型(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with mock.patch.object(permission, "ROOT", root):
                model = 脚本模型([
                    {"content": "", "tool_calls": [_tc("write_file", {"path": "out.txt", "content": "X"})]},
                    {"content": "好的没写", "tool_calls": []},
                ])
                history: list[dict] = []
                agent.run_once("写个文件", history, model_fn=model,
                               approver=lambda *a: False, log_file=root / "l.jsonl")
                self.assertFalse((root / "out.txt").exists())
                tool_msgs = [m for m in history if m.get("role") == "tool"]
                self.assertTrue(tool_msgs and "拒绝" in tool_msgs[0]["content"])

    def test_读越界路径_被硬护栏拒绝且不问用户(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with mock.patch.object(permission, "ROOT", root):
                model = 脚本模型([
                    {"content": "", "tool_calls": [_tc("read_file", {"path": "../../secret.txt"})]},
                    {"content": "读不了", "tool_calls": []},
                ])
                history: list[dict] = []
                agent.run_once("读越界文件", history, model_fn=model,
                               approver=_拒绝一切, log_file=root / "l.jsonl")
                tool_msgs = [m for m in history if m.get("role") == "tool"]
                self.assertTrue(tool_msgs)
                self.assertIn("越出", tool_msgs[0]["content"])

    def test_读敏感文件dotenv_硬护栏拒绝且不泄漏内容(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / ".env").write_text("KIMI_API_KEY=SECRETVALUE", encoding="utf-8")
            with mock.patch.object(permission, "ROOT", root):
                model = 脚本模型([
                    {"content": "", "tool_calls": [_tc("read_file", {"path": ".env"})]},
                    {"content": "读不了", "tool_calls": []},
                ])
                history: list[dict] = []
                # 即便 approver 一律放行，硬护栏也应在询问之前直接拒
                agent.run_once("读 .env", history, model_fn=model,
                               approver=lambda *a: True, log_file=root / "l.jsonl")
                tool_msgs = [m for m in history if m.get("role") == "tool"]
                self.assertTrue(tool_msgs and "敏感" in tool_msgs[0]["content"])
                self.assertNotIn("SECRETVALUE", tool_msgs[0]["content"])


class 工具健壮性(unittest.TestCase):
    def test_工具参数是坏JSON_不崩而是合成错误结果(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with mock.patch.object(permission, "ROOT", root):
                bad = {"index": 0, "id": "t1", "type": "function",
                       "function": {"name": "read_file", "arguments": "{bad json"}}
                model = 脚本模型([
                    {"content": "", "tool_calls": [bad]},
                    {"content": "知道了", "tool_calls": []},
                ])
                history: list[dict] = []
                reply = agent.run_once("读", history, model_fn=model,
                                       approver=lambda *a: True, log_file=root / "l.jsonl")
                self.assertEqual(reply, "知道了")
                tool_msgs = [m for m in history if m.get("role") == "tool"]
                self.assertTrue(tool_msgs and "JSON" in tool_msgs[0]["content"])

    def test_工具调用也会逐条记进日志(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "a.txt").write_text("hi", encoding="utf-8")
            log = root / "l.jsonl"
            with mock.patch.object(permission, "ROOT", root):
                model = 脚本模型([
                    {"content": "", "tool_calls": [_tc("read_file", {"path": "a.txt"})]},
                    {"content": "done", "tool_calls": []},
                ])
                agent.run_once("读 a", [], model_fn=model, approver=lambda *a: True, log_file=log)
            roles = [json.loads(l)["role"] for l in log.read_text(encoding="utf-8").strip().splitlines()]
            self.assertEqual(roles[0], "user")
            self.assertIn("tool", roles)


class 命令工具(unittest.TestCase):
    def test_跑命令_是危险操作_默认要问用户(self):
        self.assertEqual(permission.check("run_command", {"command": "dir"}).action, "ask")

    def test_跑命令_用户答y_能拿到stdout和exitcode(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with mock.patch.object(permission, "ROOT", root):
                model = 脚本模型([
                    {"content": "", "tool_calls": [_tc("run_command", {"command": "echo hello_kimi"})]},
                    {"content": "命令跑完了", "tool_calls": []},
                ])
                history: list[dict] = []
                reply = agent.run_once("跑个 echo", history, model_fn=model,
                                       approver=lambda *a: True, log_file=root / "l.jsonl")
                self.assertEqual(reply, "命令跑完了")
                tool_msgs = [m for m in history if m.get("role") == "tool"]
                self.assertTrue(tool_msgs)
                self.assertIn("hello_kimi", tool_msgs[0]["content"])
                self.assertIn("exit code: 0", tool_msgs[0]["content"])

    def test_跑命令_用户答n_命令根本不执行(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with mock.patch.object(permission, "ROOT", root):
                model = 脚本模型([
                    {"content": "", "tool_calls": [_tc("run_command", {"command": "echo x > marker.txt"})]},
                    {"content": "没跑", "tool_calls": []},
                ])
                history: list[dict] = []
                agent.run_once("建个文件", history, model_fn=model,
                               approver=lambda *a: False, log_file=root / "l.jsonl")
                self.assertFalse((root / "marker.txt").exists())  # 命令没执行，文件没生成
                tool_msgs = [m for m in history if m.get("role") == "tool"]
                self.assertTrue(tool_msgs and "拒绝" in tool_msgs[0]["content"])

    def test_跑命令超时_grace兜底不卡死而是给错误结果(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with mock.patch.object(permission, "ROOT", root):
                slow = f'"{sys.executable}" -c "import time; time.sleep(5)"'  # sys.executable：避开 Windows Store python 占位 stub
                model = 脚本模型([
                    {"content": "", "tool_calls": [_tc("run_command", {"command": slow, "timeout": 1})]},
                    {"content": "超时了", "tool_calls": []},
                ])
                history: list[dict] = []
                agent.run_once("跑个慢命令", history, model_fn=model,
                               approver=lambda *a: True, log_file=root / "l.jsonl")
                tool_msgs = [m for m in history if m.get("role") == "tool"]
                self.assertTrue(tool_msgs and "超时" in tool_msgs[0]["content"])


class 复盘安全修复(unittest.TestCase):
    def test_跑命令读env或私钥_被硬护栏拒绝(self):
        self.assertEqual(permission.check("run_command", {"command": "type .env"}).action, "deny")
        self.assertEqual(permission.check("run_command", {"command": "cat ~/.ssh/id_rsa"}).action, "deny")
        self.assertEqual(permission.check("run_command", {"command": "echo hi"}).action, "ask")  # 普通命令仍先问

    def test_敏感文件ADS数据流_也被拒(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(permission, "ROOT", Path(d)):
                self.assertEqual(permission.check("read_file", {"path": ".env:evil"}).action, "deny")
                self.assertEqual(permission.check("write_file", {"path": ".env:evil"}).action, "deny")

    def test_envexample仍放行_不被误当敏感(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(permission, "ROOT", Path(d)):
                self.assertEqual(permission.check("read_file", {"path": ".env.example"}).action, "approve")

    def test_工具调用超过上限_有兜底不无限循环(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "README.md").write_text("hi", encoding="utf-8")

            class _无限:
                def __call__(self, messages, tools=None):
                    return {"content": "", "tool_calls": [_tc("read_file", {"path": "README.md"})]}

            with mock.patch.object(permission, "ROOT", root):
                reply = agent.run_once("死循环", [], model_fn=_无限(), approver=lambda *a: True,
                                       log_file=root / "l.jsonl")
            self.assertIn("轮数过多", reply)

    def test_assistant日志含reasoning字段(self):
        def _带思考(_m, tools=None):
            return {"content": "答", "reasoning": "我想了想", "model": "f", "usage": {}}

        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "l.jsonl"
            agent.run_once("在吗", [], model_fn=_带思考, log_file=log)
            lines = [json.loads(x) for x in log.read_text(encoding="utf-8").strip().splitlines()]
            asst = [x for x in lines if x["role"] == "assistant"][0]
            self.assertEqual(asst["reasoning"], "我想了想")


class 实链工具(unittest.TestCase):
    def test_实链read_file调用只传唯一目标工具(self):
        response = {
            "content": "",
            "tool_calls": [_tc("read_file", {"path": "README.md"})],
        }
        with mock.patch.object(config, "API_KEY", "test-key"), \
             mock.patch.object(kimi_client, "chat", return_value=response) as chat:
            self.test_给模型read_file工具_它返回tool_calls且格式对得上()

        offered_tools = chat.call_args.kwargs["tools"]
        offered_names = [spec["function"]["name"] for spec in offered_tools]
        self.assertEqual(
            offered_names,
            ["read_file"],
            f"tools 应恰为 read_file 单项，实际 {len(offered_names)} 项：{offered_names}",
        )

    def test_给模型read_file工具_它返回tool_calls且格式对得上(self):
        if not config.API_KEY:
            self.skipTest(
                f"没有 {config.API_KEY_ENV}，跳过 {config.PROVIDER_LABEL} 实链测试")
        read_file_specs = [
            spec for spec in tools_mod.SPECS
            if spec["function"]["name"] == "read_file"
        ]
        self.assertEqual(len(read_file_specs), 1)
        res = kimi_client.chat(
            [{"role": "user", "content": "请用 read_file 工具读取 README.md 文件。"}],
            tools=read_file_specs, timeout=90,
        )
        self.assertTrue(res["tool_calls"], "模型应返回 tool_calls")
        self.assertEqual(res["tool_calls"][0]["function"]["name"], "read_file")


if __name__ == "__main__":
    unittest.main(verbosity=2)
