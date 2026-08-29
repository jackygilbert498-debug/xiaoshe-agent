"""批 3 · 3a 架构守卫（建议⑪）：把核心纪律做成会跑的 CI 断言，防随代码增长静默腐化。

- harness/*.py 只依赖标准库（`tokens.py` 明文『不引 tiktoken』等纪律，此前只是注释里的君子协定）。
- 权限决策路径（permission.py）不实时读 os.environ——安全开关须导入时冻结，别在审批路径上被注入的 env 改动绕过
  （批 2「安全开关冻结」降级为此守卫）。
运行：仓库根 `python -m unittest tests.test_arch_guard -v`
"""
import ast
import sys
import unittest
from pathlib import Path

_HARNESS = Path(__file__).resolve().parent.parent / "harness"
_ALLOWED = set(sys.stdlib_module_names) | {"harness", "__future__"}


def _top_level_imports(tree):
    """yield (模块顶层名, 原始文本) —— 只看绝对 import；相对 import(level>0)是 harness 内部、跳过。"""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name.split(".")[0], f"import {alias.name}"
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            yield node.module.split(".")[0], f"from {node.module}"


class 架构守卫(unittest.TestCase):
    def test_harness只依赖标准库(self):
        offenders = []
        for py in sorted(_HARNESS.glob("*.py")):
            tree = ast.parse(py.read_text(encoding="utf-8"))
            for top, raw in _top_level_imports(tree):
                if top not in _ALLOWED:
                    offenders.append(f"{py.name}: {raw}")
        self.assertEqual(offenders, [], f"harness 引入了非标准库依赖（违反零依赖纪律）：{offenders}")

    def test_权限决策路径不读os_environ(self):
        # permission.py 是纯策略层——任何 os.environ/os.getenv 都意味着审批路径可被运行时 env 改动影响。
        src = (_HARNESS / "permission.py").read_text(encoding="utf-8")
        for bad in ("os.environ", "os.getenv", "getenv("):
            self.assertNotIn(bad, src, f"permission.py 决策路径不该读 env：命中 {bad}")

    def test_agent不直探permission私有无头var(self):
        # 卫生项：无头上下文判定走 permission.is_headless() 公开访问器；
        # agent.py 直探 _headless_allow 私有 var 是封装泄漏，防回退。
        src = (_HARNESS / "agent.py").read_text(encoding="utf-8")
        self.assertNotIn("_headless_allow", src,
                         "agent.py 应走 permission.is_headless() 公开访问器，别直探 _headless_allow 私有 var")

    def test_守卫逻辑本身能抓到违规(self):
        # 自检：确保上面的扫描不是恒真——喂一段含第三方 import 的代码，必须被逮到。
        tree = ast.parse("import requests\nfrom numpy import array\nfrom . import x\nimport os")
        bad = [raw for top, raw in _top_level_imports(tree) if top not in _ALLOWED]
        self.assertIn("import requests", bad)
        self.assertIn("from numpy", bad)
        self.assertNotIn("import os", bad)            # 标准库不算
        self.assertTrue(all("from x" not in b for b in bad))  # 相对 import 跳过


if __name__ == "__main__":
    unittest.main(verbosity=2)
