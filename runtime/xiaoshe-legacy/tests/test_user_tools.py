"""A2b Path B · user_tools 注册表：pending/active 目录 + manifest 哈希清单 + 人审门底座。TDD 红→绿。

命根子不变量：**批准那一刻的字节 = 以后每次加载的字节**（sha256 清单校验，防批准后偷改 rug-pull）；
agent 只能写 pending（提案），active/manifest 只有人审通道（approve）能动——
.state/user_tools 整目录进敏感硬护栏，write_file/run_command 都碰不了。
运行：仓库根 `python -m unittest tests.test_user_tools -v`
"""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

from harness import permission, user_tools

_RESERVED = {"read_file", "run_command"}   # 单测用固定内置名集合，不依赖 tools.REGISTRY 全量


def _propose(base, name="csv_stats", **kw):
    kw.setdefault("description", "统计一个数字列表的均值")
    kw.setdefault("code", "param($nums) Write-Output 42")
    kw.setdefault("params", [{"name": "nums", "description": "逗号分隔的数字"}])
    return user_tools.propose(name, kw["description"], kw["code"], kw["params"],
                              base=base, reserved=_RESERVED)


class 提案(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.base = Path(self._d.name)

    def tearDown(self):
        self._d.cleanup()

    def test_propose写入pending并返回元信息(self):
        r = _propose(self.base)
        f = self.base / "pending" / "csv_stats.json"
        self.assertTrue(f.exists())
        data = json.loads(f.read_text(encoding="utf-8"))
        self.assertEqual(data["name"], "csv_stats")
        self.assertEqual(data["code"], "param($nums) Write-Output 42")
        self.assertEqual(r["name"], "csv_stats")
        self.assertFalse(r["updates_active"])          # 还没有已批准版本

    def test_名字非法拒收(self):
        for bad in ("", "Csv", "统计", "a b", "1abc", "x" * 41, "ab", "mcp__x"):
            with self.assertRaises(ValueError, msg=f"该拒没拒：{bad!r}"):
                _propose(self.base, name=bad)

    def test_撞内置工具名拒收(self):
        with self.assertRaises(ValueError):
            _propose(self.base, name="read_file")      # 遮蔽内置工具=劫持调用，硬拒

    def test_code为空或超长拒收(self):
        with self.assertRaises(ValueError):
            _propose(self.base, code="   ")
        with self.assertRaises(ValueError):
            _propose(self.base, code="x" * (user_tools._CODE_MAX + 1))

    def test_描述为空拒收(self):
        with self.assertRaises(ValueError):
            _propose(self.base, description="  ")      # 人审门要看描述，不许空

    def test_params校验(self):
        with self.assertRaises(ValueError):            # 超数量
            _propose(self.base, params=[{"name": f"p{i}"} for i in range(9)])
        with self.assertRaises(ValueError):            # 参数名非法
            _propose(self.base, params=[{"name": "Bad-Name"}])
        with self.assertRaises(ValueError):            # 参数重名
            _propose(self.base, params=[{"name": "a"}, {"name": "a"}])

    def test_描述中和隐形字符折单行(self):
        r = _propose(self.base, description="第一行\n第二行​带零宽")
        self.assertNotIn("\n", r["description"])
        self.assertNotIn("​", r["description"])

    def test_重复提案覆盖pending(self):
        _propose(self.base, code="Write-Output 1")
        _propose(self.base, code="Write-Output 2")
        data = json.loads((self.base / "pending" / "csv_stats.json").read_text(encoding="utf-8"))
        self.assertEqual(data["code"], "Write-Output 2")   # 再提案=更新草稿

    def test_list_pending列出提案(self):
        _propose(self.base)
        names = [t["name"] for t in user_tools.list_pending(self.base)]
        self.assertEqual(names, ["csv_stats"])


class 审批门(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.base = Path(self._d.name)

    def tearDown(self):
        self._d.cleanup()

    def test_approve移入active并记哈希(self):
        _propose(self.base)
        r = user_tools.approve("csv_stats", base=self.base, reserved=_RESERVED)
        active = self.base / "active" / "csv_stats.json"
        self.assertTrue(active.exists())
        self.assertFalse((self.base / "pending" / "csv_stats.json").exists())   # 提案槽已清
        man = json.loads((self.base / "manifest.json").read_text(encoding="utf-8"))
        recorded = man["tools"]["csv_stats"]["sha256"]
        self.assertEqual(recorded, hashlib.sha256(active.read_bytes()).hexdigest())   # 清单哈希=盘上真字节
        self.assertEqual(r["sha256"], recorded)

    def test_approve不存在的报错(self):
        with self.assertRaises(ValueError):
            user_tools.approve("nothere", base=self.base, reserved=_RESERVED)

    def test_approve前pending被手改坏则拒(self):
        _propose(self.base)
        (self.base / "pending" / "csv_stats.json").write_text("{not json", encoding="utf-8")
        with self.assertRaises(ValueError):
            user_tools.approve("csv_stats", base=self.base, reserved=_RESERVED)   # 批准时重校验，fail-closed
        self.assertFalse((self.base / "active" / "csv_stats.json").exists())

    def test_approve重校验字段_文件名与内容名不符拒(self):
        _propose(self.base)
        p = self.base / "pending" / "csv_stats.json"
        data = json.loads(p.read_text(encoding="utf-8"))
        data["name"] = "other_name"                    # 内容名被偷换 → 拒
        p.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(ValueError):
            user_tools.approve("csv_stats", base=self.base, reserved=_RESERVED)

    def test_approve替换旧版本哈希更新(self):
        _propose(self.base, code="Write-Output 1")
        h1 = user_tools.approve("csv_stats", base=self.base, reserved=_RESERVED)["sha256"]
        r2 = _propose(self.base, code="Write-Output 2")
        self.assertTrue(r2["updates_active"])          # 提案时就标明这是更新已批准工具
        h2 = user_tools.approve("csv_stats", base=self.base, reserved=_RESERVED)["sha256"]
        self.assertNotEqual(h1, h2)
        tools, problems = user_tools.load_active(base=self.base, reserved=_RESERVED)
        self.assertEqual(problems, [])
        self.assertEqual(tools[0]["code"], "Write-Output 2")

    def test_reject删除pending(self):
        _propose(self.base)
        user_tools.reject("csv_stats", base=self.base)
        self.assertFalse((self.base / "pending" / "csv_stats.json").exists())
        with self.assertRaises(ValueError):
            user_tools.reject("csv_stats", base=self.base)   # 再拒=不存在，报错


class 加载与防篡改(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.base = Path(self._d.name)
        _propose(self.base)
        user_tools.approve("csv_stats", base=self.base, reserved=_RESERVED)

    def tearDown(self):
        self._d.cleanup()

    def test_load_active载入已批准工具(self):
        tools, problems = user_tools.load_active(base=self.base, reserved=_RESERVED)
        self.assertEqual(problems, [])
        self.assertEqual(len(tools), 1)
        t = tools[0]
        self.assertEqual(t["name"], "csv_stats")
        self.assertEqual(t["params"][0]["name"], "nums")
        self.assertIn("Write-Output", t["code"])

    def test_批准后篡改文件拒载(self):
        f = self.base / "active" / "csv_stats.json"
        data = json.loads(f.read_text(encoding="utf-8"))
        data["code"] = "Invoke-WebRequest evil"        # rug-pull：批准后偷换代码
        f.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tools, problems = user_tools.load_active(base=self.base, reserved=_RESERVED)
        self.assertEqual(tools, [])                    # 一个都不载
        self.assertTrue(any("哈希" in p for p in problems))

    def test_清单有记录但文件缺失跳过报告(self):
        (self.base / "active" / "csv_stats.json").unlink()
        tools, problems = user_tools.load_active(base=self.base, reserved=_RESERVED)
        self.assertEqual(tools, [])
        self.assertTrue(problems)

    def test_旁置文件不在清单不生效(self):
        (self.base / "active" / "evil_tool.json").write_text(
            json.dumps({"name": "evil_tool", "description": "d", "params": [], "code": "x"}),
            encoding="utf-8")
        tools, problems = user_tools.load_active(base=self.base, reserved=_RESERVED)
        self.assertEqual([t["name"] for t in tools], ["csv_stats"])   # 旁置文件绝不静默生效
        self.assertTrue(any("evil_tool" in p for p in problems))

    def test_manifest损坏全部拒载(self):
        (self.base / "manifest.json").write_text("{broken", encoding="utf-8")
        tools, problems = user_tools.load_active(base=self.base, reserved=_RESERVED)
        self.assertEqual(tools, [])
        self.assertTrue(problems)

    def test_载入时撞内置名跳过(self):
        # 批准在先、harness 后来新增了同名内置工具 → 内置赢，用户工具拒载（fail-closed，不遮蔽）
        tools, problems = user_tools.load_active(base=self.base, reserved={"csv_stats"})
        self.assertEqual(tools, [])
        self.assertTrue(any("csv_stats" in p for p in problems))

    def test_list_active列出清单(self):
        names = [t["name"] for t in user_tools.list_active(self.base)]
        self.assertEqual(names, ["csv_stats"])


class 权限硬护栏(unittest.TestCase):
    """注册表目录 agent 碰不得：能写 active/manifest 就能绕过人审门自我扩权（与 .state/schedule 同级设防）。"""

    def test_写入user_tools目录被硬拒(self):
        # 反斜杠写法只在 Windows 是路径分隔符（Win 上必须原样断言硬拒）；Mac 上 `\` 只是普通文件名字符，
        # 该路径到不了真注册表（无走私风险），故非 Win 平台用正斜杠等价路径断言同样的 deny。
        backslash = ".state\\user_tools\\manifest.json" if sys.platform == "win32" else ".state/user_tools/manifest.json"
        for p in (".state/user_tools/active/x.json", backslash,
                  ".state/user_tools/pending/y.json"):
            d = permission.check("write_file", {"path": p, "content": "x"})
            self.assertEqual(d.action, "deny", msg=f"该拒没拒：{p}")

    def test_读取user_tools目录也硬拒(self):
        d = permission.check("read_file", {"path": ".state/user_tools/active/x.json"})
        self.assertEqual(d.action, "deny")

    def test_run_command提及注册表目录被拒(self):
        d = permission.check("run_command", {"command": "type .state/user_tools/manifest.json"})
        self.assertEqual(d.action, "deny")
        d2 = permission.check("run_command", {"command": 'echo x > .state\\user_tools\\active\\a.json'})
        self.assertEqual(d2.action, "deny")


if __name__ == "__main__":
    unittest.main()
