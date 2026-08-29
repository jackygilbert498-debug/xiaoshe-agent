"""P3 v2.2 · AX 树 → 结构化元素表：解析 AX dump 成带 ref/uid/坐标的元素。TDD 红→绿。

用真机探针（v2_ax_probe.scpt）的真实输出当 fixture。归一 dump 格式 `role | name | pos=x,y | size=WxH`
（Mac AX / Win UIA 脚本都吐这格式）→ 单一解析器。ref=本次快照短号（即用）；uid=role+name 内容哈希
（跨快照尽力稳，供模型回指）。运行：仓库根 `python -m unittest discover -s tests -v`
"""
import unittest

from harness import observe

# 真机 AX 探针实际输出（Microsoft Edge 前窗）
_REAL_DUMP = """APP: Microsoft Edge
WIN: 视频鼠标截图工具（回车保存版） - Microsoft Edge
AXGroup | 视频鼠标截图工具（回车保存版） - Microsoft Edge | pos=0,30 | size=2560x1325
AXButton | 关闭按钮 | pos=12,42 | size=16x16
AXButton | 全屏幕按钮 | pos=58,42 | size=16x16
AXButton | 最小化按钮 | pos=35,42 | size=16x16
(窗口直属元素数=4)"""


class 解析AX_dump(unittest.TestCase):
    def test_跳过头尾_解析出四个元素(self):
        els = observe.parse_elements(_REAL_DUMP)
        self.assertEqual(len(els), 4)                       # 跳过 APP/WIN/(计数) 行
        roles = [e["role"] for e in els]
        self.assertEqual(roles.count("AXButton"), 3)

    def test_按钮的角色名称坐标尺寸都对(self):
        els = observe.parse_elements(_REAL_DUMP)
        close = next(e for e in els if e["name"] == "关闭按钮")
        self.assertEqual(close["role"], "AXButton")
        self.assertEqual((close["x"], close["y"]), (12, 42))
        self.assertEqual((close["w"], close["h"]), (16, 16))

    def test_名称含分隔符也不被截断(self):
        # AXGroup 的 name 是窗口标题，含 " - "；解析从右侧锚 pos/size，name 完整保留
        els = observe.parse_elements(_REAL_DUMP)
        grp = next(e for e in els if e["role"] == "AXGroup")
        self.assertIn("视频鼠标截图工具", grp["name"])
        self.assertEqual((grp["w"], grp["h"]), (2560, 1325))

    def test_坏行跳过不炸(self):
        els = observe.parse_elements("垃圾行没有格式\nAXButton | 确定 | pos=10,20 | size=80x30\n又一行乱码")
        self.assertEqual(len(els), 1)
        self.assertEqual(els[0]["name"], "确定")

    def test_name里塞假坐标不劫持真坐标(self):
        # 恶意/巧合的 name 含 "pos=999,999 size=1x1"；真坐标是行尾那对，必须锚右侧、别被 name 里的假值劫持
        line = "AXButton | 点我 pos=999,999 size=1x1 | pos=10,20 | size=80x30"
        els = observe.parse_elements(line)
        self.assertEqual(len(els), 1)
        self.assertEqual((els[0]["x"], els[0]["y"]), (10, 20))   # 真坐标，不是 999,999
        self.assertEqual((els[0]["w"], els[0]["h"]), (80, 30))
        self.assertIn("pos=999,999", els[0]["name"])             # 假坐标留在 name 文本里


class 表文本有界(unittest.TestCase):
    def test_超长name在显示时限长_表不会溢出到blob(self):
        # 恶意 app 给超长 name；format_table 里限长，整表远小于 MAX_TOOL_CHARS，observe 输出永不 spill
        dump = "\n".join(f"AXButton | {'长'*3000} | pos={i},0 | size=10x10" for i in range(40))
        table = observe.format_table(observe.element_table(dump))
        self.assertLess(len(table), 20000)         # 40 元素 × 限长 name，远低于溢出阈值
        self.assertIn("…", table)                  # 超长 name 被截断标记


class 元素表带ref与uid(unittest.TestCase):
    def test_每个元素有ref和uid_ref唯一(self):
        els = observe.element_table(_REAL_DUMP)
        refs = [e["ref"] for e in els]
        self.assertEqual(refs, ["e0", "e1", "e2", "e3"])     # 本次快照短号
        self.assertTrue(all(e.get("uid") for e in els))
        self.assertEqual(len(set(e["uid"] for e in els)), 4)  # uid 互不相同

    def test_同role_name的uid稳定可复现(self):
        a = observe.element_table(_REAL_DUMP)
        b = observe.element_table(_REAL_DUMP)               # 再解析一次
        ua = {e["name"]: e["uid"] for e in a}
        ub = {e["name"]: e["uid"] for e in b}
        self.assertEqual(ua, ub)                            # 同输入→同 uid（跨快照可回指）


if __name__ == "__main__":
    unittest.main(verbosity=2)
