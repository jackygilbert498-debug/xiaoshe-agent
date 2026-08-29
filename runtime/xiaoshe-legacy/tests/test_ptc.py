"""基M2 骨架 · PTC 受限解释器 [CaMeL 底座]。TDD 红→绿。

PTC = 模型写一段脚本、本地跑完多工具只回 stdout（把 N 步管线=N 次计费压成 1 轮，最大省钱杠杆）。
安全第一：受限解释器绝不 exec/eval 真 Python——树遍历 + 节点白名单默认拒 + 禁 import/属性访问/dunder +
命名空间隔离（无真 builtins/globals）+ 工具调用经注入 dispatch 走完整权限管道。
本骨架只做「AST 安全门 + 最小求值 + dispatch 桩」，不接真工具执行。
运行：仓库根 `python -m unittest tests.test_ptc -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import permission, ptc, tools


class 安全门_逃逸必拒(unittest.TestCase):
    """受限解释器的命根子：任何沙箱逃逸/越权原语必须在 validate 阶段就被拒。"""

    def _reject(self, src):
        with self.assertRaises(ptc.PTCError):
            ptc.run(src, dispatch=lambda n, a: "x", tool_names=("read_file",))

    def test_禁import(self):
        self._reject("import os")
        self._reject("from os import system")
        self._reject("from subprocess import Popen as p")

    def test_禁属性访问_防class_globals逃逸(self):
        self._reject("x = ().__class__")
        self._reject("read_file(path='a').strip()")
        self._reject("y = (1).__class__.__bases__")

    def test_禁dunder标识符(self):
        self._reject("x = __import__")
        self._reject("y = __builtins__")
        self._reject("z = __class__")

    def test_禁未知函数_open_eval_exec(self):
        self._reject("open('/etc/passwd')")
        self._reject("eval('1+1')")
        self._reject("exec('x=1')")
        self._reject("compile('x','y','z')")
        self._reject("__import__('os')")

    def test_禁lambda与推导式与函数类定义(self):
        self._reject("f = lambda x: x")
        self._reject("xs = [i for i in range(3)]")
        self._reject("def f():\n    return 1")
        self._reject("class C:\n    pass")

    def test_禁with_try_global(self):
        self._reject("with open('a') as f:\n    pass")
        self._reject("global x")

    def test_死循环被步数上限截断(self):
        with self.assertRaises(ptc.PTCError):
            ptc.run("while True:\n    x = 1", dispatch=lambda n, a: "x",
                    tool_names=(), max_steps=500)

    def test_语法错误友好报错不崩(self):
        with self.assertRaises(ptc.PTCError):
            ptc.run("x = (", dispatch=lambda n, a: "x", tool_names=())


class 功能_工具管线(unittest.TestCase):
    def test_工具调用经dispatch而非直接执行(self):
        calls = []
        def disp(name, kwargs):
            calls.append((name, kwargs))
            return f"<{name}结果>"
        out = ptc.run("r = read_file(path='a.txt')\nprint(r)",
                      dispatch=disp, tool_names=("read_file",))
        self.assertEqual(calls, [("read_file", {"path": "a.txt"})])   # 经注入 dispatch，参数正确
        self.assertIn("<read_file结果>", out)

    def test_多工具一轮跑完_按序dispatch(self):
        calls = []
        def disp(name, kwargs):
            calls.append(name)
            return "内容" if name == "read_file" else "ok"
        src = ("data = read_file(path='in.txt')\n"
               "write_file(path='out.txt', content=data)\n"
               "print('done')")
        out = ptc.run(src, dispatch=disp, tool_names=("read_file", "write_file"))
        self.assertEqual(calls, ["read_file", "write_file"])   # 两步一轮跑完、按序
        self.assertIn("done", out)

    def test_工具只收命名参数_位置参数报错(self):
        with self.assertRaises(ptc.PTCError):
            ptc.run("read_file('a.txt')", dispatch=lambda n, a: "x", tool_names=("read_file",))

    def test_受限内置len_range_str可用(self):
        out = ptc.run("print(len('abc'))\nprint(str(42))", dispatch=lambda n, a: "x", tool_names=())
        self.assertIn("3", out)
        self.assertIn("42", out)

    def test_if与for做胶水逻辑(self):
        calls = []
        def disp(name, kwargs):
            calls.append(kwargs.get("path"))
            return "ok"
        src = ("for p in ['a', 'b', 'c']:\n"
               "    if p != 'b':\n"
               "        read_file(path=p)")
        ptc.run(src, dispatch=disp, tool_names=("read_file",))
        self.assertEqual(calls, ["a", "c"])   # 跳过 b

    def test_未定义变量报错不静默(self):
        with self.assertRaises(ptc.PTCError):
            ptc.run("print(undefined_var)", dispatch=lambda n, a: "x", tool_names=())


class 红队修复_资源与契约(unittest.TestCase):
    def _reject(self, src, **kw):
        with self.assertRaises(ptc.PTCError):
            ptc.run(src, dispatch=lambda n, a: "x", tool_names=("read_file",), **kw)

    def test_内存炸弹_字符串乘法被拒(self):
        self._reject("x = 'a' * 1000000000")
        self._reject("y = [0] * 20000000")

    def test_内存炸弹_range过大被拒(self):
        self._reject("z = list(range(1000000000))")

    def test_内存炸弹_整数平方翻倍被拒(self):
        self._reject("a = 10 ** 1000\nfor i in range(100):\n    a = a * a")

    def test_内存炸弹_移位被拒(self):
        self._reject("y = 1 << 800000000")

    def test_内存炸弹_字符串翻倍循环被拒(self):
        self._reject("s = 'a'\nfor i in range(40):\n    s = s * 2")

    def test_循环外break转PTCError而非裸异常(self):
        self._reject("break")
        self._reject("if 1:\n    break")
        self._reject("continue")

    def test_间接调用被拒_非具名函数(self):
        self._reject("print(len()())")

    def test_双星解包被拒(self):
        self._reject("print(len(**{'x': 1}))")

    def test_正常小规模乘法与range仍可用(self):
        out = ptc.run("print('ab' * 3)\nprint(len(list(range(10))))",
                      dispatch=lambda n, a: "x", tool_names=())
        self.assertIn("ababab", out)
        self.assertIn("10", out)


class 字符串助手(unittest.TestCase):
    def test_lines_count_split_加工文本(self):
        # 集成验证发现的缺口：脚本没法用 .splitlines() 数行——函数式助手补上。
        out = ptc.run("t = 'a\\nb\\nc'\nprint(len(lines(t)))\nprint(count(t, 'b'))",
                      dispatch=lambda n, a: "x", tool_names=())
        self.assertIn("3", out)   # 3 行
        self.assertIn("1", out)   # 'b' 出现 1 次

    def test_join_strip_replace_contains(self):
        out = ptc.run("print(join('-', ['x','y','z']))\nprint(strip('  hi  '))\n"
                      "print(replace('a.b', '.', '/'))\nprint(contains('hello', 'ell'))",
                      dispatch=lambda n, a: "x", tool_names=())
        self.assertIn("x-y-z", out)
        self.assertIn("hi", out)
        self.assertIn("a/b", out)
        self.assertIn("True", out)

    def test_助手不开反射逃逸_属性仍禁(self):
        # 助手是函数、返回普通值——lines(...) 的结果仍不能属性访问（沙箱脊梁不破）
        with self.assertRaises(ptc.PTCError):
            ptc.run("x = lines('a').__class__", dispatch=lambda n, a: "x", tool_names=())

    def test_模型式统计_glob输出数文件(self):
        # 复现集成场景：dispatch 回一段"文件列表"文本，脚本用 lines 正确数出文件数。
        listing = "harness/a.py\nharness/b.py\nharness/c.py"
        out = ptc.run("f = glob(pattern='harness/*.py')\nprint(len(lines(f)))",
                      dispatch=lambda n, a: listing, tool_names=("glob",))
        self.assertIn("3", out)


class 接真执行管道(unittest.TestCase):
    def test_run_script经真管道跑安全工具_一轮多调用(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(permission, "ROOT", Path(d)):
                (Path(d) / "a.txt").write_text("内容A", encoding="utf-8")
                (Path(d) / "b.txt").write_text("内容B", encoding="utf-8")
                ctx = {"_approver": lambda *a: True}
                script = ("a = read_file(path='a.txt')\n"
                          "b = read_file(path='b.txt')\n"
                          "print(a)\nprint(b)")
                out = tools.execute("run_script", {"script": script}, ctx).content
        self.assertIn("内容A", out)     # 两个工具一轮内跑完
        self.assertIn("内容B", out)

    def test_run_script里越界工具被拒不执行(self):
        ctx = {"_approver": lambda *a: True}
        out = tools.execute("run_script", {"script": "print(read_file(path='/etc/passwd'))"}, ctx).content
        self.assertIn("拒绝", out)       # 绝对路径越界 → deny → 错误串进 stdout（工具没执行）

    def test_run_script里危险工具默认拒时不执行(self):
        ctx = {"_approver": lambda *a: False}   # 非交互默认拒
        out = tools.execute("run_script", {"script": "r = run_command(command='echo hi')\nprint(r)"}, ctx).content
        self.assertIn("拒绝", out)

    def test_run_script被拒工具计入denied_calls_证明走真管道(self):
        ctx = {"_approver": lambda *a: False}
        tools.execute("run_script", {"script": "run_command(command='echo hi')"}, ctx)
        self.assertGreaterEqual(ctx.get("_denied_calls", 0), 1)   # 走了 _run_tool 的 deny 计数

    def test_run_script已注册需批准且在specs(self):
        self.assertIn("run_script", tools.REGISTRY)
        self.assertEqual(permission.check("run_script", {"script": "x=1"}).action, "ask")   # 非 SAFE，需批准
        self.assertTrue(any(s["function"]["name"] == "run_script" for s in tools.all_specs()))

    def test_run_script指纹绑脚本正文_always不放行别的脚本(self):
        from harness import agent
        # 纵深：run_script 按脚本正文分指纹——一次 always 不等于放行任意后续脚本（红队建议）
        k1 = agent._approval_key("run_script", {"script": "print(1)"})
        k2 = agent._approval_key("run_script", {"script": "run_command(command='rm -rf /')"})
        self.assertNotEqual(k1, k2)
        self.assertTrue(k1.startswith("run_script:"))

    def test_基M2收尾_系统提示引导多步用run_script与新工具(self):
        from harness import memory
        base = memory.BASE_SYSTEM
        self.assertIn("run_script", base)   # 教模型多步依赖/批量时用 run_script 省钱
        self.assertIn("edit", base)         # 引导用 edit 改一段
        self.assertIn("grep", base)         # 引导用 grep 搜内容
        self.assertIn("glob", base)         # 引导用 glob 找文件

    def test_基M2收尾_脚本超长输出被截断(self):
        # 脚本 print 很多不该灌爆 history——出口截断。
        ctx = {"_approver": lambda *a: True}
        out = tools.execute("run_script", {"script": "for i in range(500):\n    print('x' * 200)"}, ctx).content
        self.assertLess(len(out), 30000)    # 明显小于 500*200=10万，被截断到上限
        self.assertIn("截断", out)

    def test_run_script里dunder的mcp工具名调不到(self):
        # 受限解释器禁 dunder → mcp__server__tool 天然调不到（最大不可信面天然排除）
        ctx = {"_approver": lambda *a: True}
        out = tools.execute("run_script", {"script": "mcp__x__y(a=1)"}, ctx).content
        self.assertIn("失败", out)   # validate 拒 dunder 标识符


if __name__ == "__main__":
    unittest.main(verbosity=2)
