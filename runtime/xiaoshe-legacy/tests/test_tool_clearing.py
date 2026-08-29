"""上下文省钱工程 · tool result clearing：旧的大工具结果提早换成占位符省 token。TDD 红→绿。

与 compaction 互补：compaction 到 75% 才把整段旧对话**摘要成一条**（毁结构、丢细节）；
tool clearing 是**常态**（每轮）把较旧的大工具结果**内容**换成占位符——留住对话结构与 tool_call 配对，
只缩内容，在压缩触发前就持续省 token。只清「旧 + 大 + 非已 spill(有 recall 指针) + 非已清」的 tool 结果，
最近若干条保持全文（正在用）。绝不删消息/不动配对，故不会造孤儿 tool_result。
运行：仓库根 `python -m unittest tests.test_tool_clearing -v`
"""
import unittest

from harness import compaction


def _tool(tcid, content):
    return {"role": "tool", "tool_call_id": tcid, "content": content}


def _asst(tcid, name="read_file"):
    return {"role": "assistant", "content": "",
            "tool_calls": [{"id": tcid, "function": {"name": name, "arguments": "{}"}}]}


class 清理旧工具结果(unittest.TestCase):
    def _chain(self, n, size):
        """造 n 组 (assistant tool_call, tool result[size 字符]) + 一条收尾 assistant。"""
        h = [{"role": "system", "content": "纪律"}, {"role": "user", "content": "干活"}]
        for i in range(n):
            h.append(_asst(f"c{i}"))
            h.append(_tool(f"c{i}", "X" * size))
        h.append({"role": "assistant", "content": "完成"})
        return h

    def test_旧的大结果被换成占位符(self):
        h = self._chain(10, 2000)
        cleared = compaction.clear_stale_tool_results(h)
        self.assertGreater(cleared, 0)
        # 最旧那条 tool 结果应已被清（内容变短、带占位标记）
        first_tool = next(m for m in h if m.get("role") == "tool")
        self.assertIn(compaction._CLEARED_MARK, first_tool["content"])
        self.assertLess(len(first_tool["content"]), 200)

    def test_最近keep条保持全文(self):
        h = self._chain(10, 2000)
        compaction.clear_stale_tool_results(h, keep_tools=3)
        tools = [m for m in h if m.get("role") == "tool"]
        for m in tools[-3:]:
            self.assertEqual(len(m["content"]), 2000)   # 最近 3 条不动
        self.assertIn(compaction._CLEARED_MARK, tools[0]["content"])  # 旧的被清

    def test_保留tool_call_id配对不成孤儿(self):
        h = self._chain(10, 2000)
        compaction.clear_stale_tool_results(h)
        for m in h:
            if m.get("role") == "tool":
                self.assertTrue(m.get("tool_call_id"))   # 配对键必须原样保留
                self.assertEqual(m["role"], "tool")

    def test_小结果不清(self):
        h = self._chain(10, 100)   # 每条 100 字，低于下限
        cleared = compaction.clear_stale_tool_results(h)
        self.assertEqual(cleared, 0)

    def test_已spill的有recall指针跳过(self):
        h = [{"role": "user", "content": "x"}]
        for i in range(8):
            h.append(_asst(f"c{i}"))
            # 模拟 spill 后的预览（含 recall 指针）：即便长也别清，它已是预览+有回捞路径
            h.append(_tool(f"c{i}", "预览内容" * 100 + '…〔完整 99999 字已存 blob_1｜recall("blob_1", page=2) 看后续〕'))
        n0 = compaction.clear_stale_tool_results(h)
        self.assertEqual(n0, 0)

    def test_幂等_已清不再清(self):
        h = self._chain(10, 2000)
        compaction.clear_stale_tool_results(h)
        again = compaction.clear_stale_tool_results(h)
        self.assertEqual(again, 0)   # 第二遍无新可清

    def test_不动非tool消息(self):
        h = self._chain(10, 2000)
        asst_before = [m["content"] for m in h if m.get("role") == "assistant"]
        compaction.clear_stale_tool_results(h)
        asst_after = [m["content"] for m in h if m.get("role") == "assistant"]
        self.assertEqual(asst_before, asst_after)   # assistant/user/system 一律不碰

    def test_真省字符(self):
        h = self._chain(12, 3000)
        before = compaction.total_chars(h)
        compaction.clear_stale_tool_results(h, keep_tools=3)  # 保护最近 3，清掉旧 9
        after = compaction.total_chars(h)
        self.assertLess(after, before * 0.4)   # 旧的一大批被清，显著变小


class 对抗审查修复(unittest.TestCase):
    def _chain(self, n, size):
        h = [{"role": "user", "content": "干活"}]
        for i in range(n):
            h.append(_asst(f"c{i}"))
            h.append(_tool(f"c{i}", "X" * size))
        return h

    def test_保护当前轮_宽并行不误清(self):
        # 红队 MED：一轮 8 个并行 tool_call，结果都刚产出、模型还没看过——keep_tools=6 盖不住整轮，
        # 但「最后一条带 tool_calls 的 assistant 之后」的结果一律不清，故 8 条全保留
        h = [{"role": "user", "content": "x"},
             {"role": "assistant", "content": "",
              "tool_calls": [{"id": f"p{i}", "function": {"name": "read_file", "arguments": "{}"}} for i in range(8)]}]
        for i in range(8):
            h.append(_tool(f"p{i}", "Y" * 2000))
        cleared = compaction.clear_stale_tool_results(h, keep_tools=6)
        self.assertEqual(cleared, 0)   # 本轮 8 条结果全保护，一条都不清

    def test_专属spill标记_裸recall字面不误跳过(self):
        # 红队 LOW：正文含裸 recall(" 字面量（如源码/文档）应被清；只有 spill 尾注 ｜recall(" 才跳过
        h = self._chain(10, 2000)
        # 把最旧一条 tool 结果内容改成含裸 recall(" 的正文（非 spill 尾注）
        first_i = next(i for i, m in enumerate(h) if m.get("role") == "tool")
        h[first_i]["content"] = "源码片段：调用 recall(\"img-1\") 可回捞。" + "Z" * 2000
        compaction.clear_stale_tool_results(h)
        self.assertIn(compaction._CLEARED_MARK, h[first_i]["content"])   # 裸 recall(" 不再豁免，照清（clear 换新 dict，重取）

    def test_真spill尾注仍跳过(self):
        h = self._chain(10, 200)
        first_asst = h[1]  # 造一条旧的大 spill 预览
        h.insert(2, None); h[2] = _tool("c0",
            "预览" * 300 + '…〔完整 99999 字已存 blob_1｜共 5 页｜recall("blob_1", page=2) 看后续〕')
        # 让它变旧：追加足够多新组
        for i in range(8):
            h.append(_asst(f"d{i}")); h.append(_tool(f"d{i}", "N" * 100))
        spill_msg = h[2]
        compaction.clear_stale_tool_results(h)
        self.assertNotIn(compaction._CLEARED_MARK, spill_msg["content"])   # 真 spill 尾注（｜recall(）跳过

    def test_should_clear缓存意识门(self):
        h = self._chain(4, 500)
        self.assertFalse(compaction.should_clear(h, used_tokens=1000, budget_tokens=100000))   # 离预算远→不清
        self.assertTrue(compaction.should_clear(h, used_tokens=70000, budget_tokens=100000))   # 近预算→清


if __name__ == "__main__":
    unittest.main()
