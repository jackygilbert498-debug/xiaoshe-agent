"""批 1 · 报告 P0 三连。TDD 红→绿。

- 1a 审批白名单按命令指纹分粒度（建议①）：批准一次 `ls` 不等于放行 `rm`；--allow 裸工具名仍全量放行。
- 1b Ctrl+C 打断不整轮回滚（建议③）：已完成的工具往返保留、悬空 tool_call 补配对、history 干净可 resume。
运行：仓库根 `python -m unittest tests.test_batch1 -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import agent, compaction


def _long_hist(first_user="最初的独特任务原话XYZ", n=24, tag="a"):
    return [{"role": "user", "content": first_user}] + \
           [{"role": "assistant" if i % 2 else "user", "content": f"{tag}{i}"} for i in range(n)]


def _approver(verdicts):
    """造一个 approver：按 verdicts 顺序返回，并记录每次被问的 (name, args)。"""
    calls = []
    it = iter(verdicts)
    def ap(name, args, reason):
        calls.append((name, args))
        return next(it, False)
    return ap, calls


class 审批指纹(unittest.TestCase):
    def test_批准一次ls不放行del(self):
        # 建议①：白名单 key 从裸工具名改成命令指纹——run_command:ls ≠ run_command:rm。
        ctx = {}
        ap, calls = _approver(["always", False])
        self.assertTrue(agent._approved("run_command", {"command": "ls -la"}, "", ap, ctx))
        self.assertFalse(agent._approved("run_command", {"command": "rm -rf x"}, "", ap, ctx))
        self.assertEqual(len(calls), 2)   # del 没被 ls 的白名单静默放行，两次都问了

    def test_同一命令逐字相同不再问_不同命令仍问(self):
        # 1a（批1二轮审查定论）：run_command 绑整条命令——shell 命令无法安全抽象成"类"
        # （bash -c/sudo/管道/赋值前缀都能换真实命令）。逐字相同复用批准，任何不同（含换参数）都重新问。
        ctx = {}
        ap, calls = _approver(["always"])
        self.assertTrue(agent._approved("run_command", {"command": "git status"}, "", ap, ctx))
        self.assertTrue(agent._approved("run_command", {"command": "git status"}, "", ap, ctx))  # 逐字相同→不再问
        self.assertEqual(len(calls), 1)
        ap2, calls2 = _approver([False])
        self.assertFalse(agent._approved("run_command", {"command": "git log"}, "", ap2, ctx))  # 不同命令→重新问
        self.assertEqual(len(calls2), 1)

    def test_解释器包装路径赋值前缀命令均绑整条不放行(self):
        # 1a 安全（批1二轮审查 HIGH/MED）：bash -c / python -c 解释器、/usr/bin/sudo 路径形式、VAR=val 赋值前缀、
        # 拼接/包装——都不能顶着"安全版"同前缀静默放行。绑整条命令一举全堵。
        pairs = [
            ("git status", "git status; rm -rf x"),                 # 拼接
            ("git log", "git log | sh"),                            # 管道
            ("sudo apt update", "sudo rm -rf /"),                   # 裸包装词
            ("bash -c 'echo hi'", "bash -c 'rm -rf /home/x'"),      # 解释器 -c
            ("python -c 'print(1)'", "python -c \"__import__('os').system('rm -rf x')\""),
            ("/usr/bin/sudo apt update", "/usr/bin/sudo rm -rf /etc"),   # 路径形式包装
            ("NODE_ENV=prod npm start", "NODE_ENV=prod rm -rf /home/x"),  # 赋值前缀
        ]
        for safe, evil in pairs:
            ctx = {}
            ap, calls = _approver(["always", False])
            self.assertTrue(agent._approved("run_command", {"command": safe}, "", ap, ctx))
            self.assertFalse(agent._approved("run_command", {"command": evil}, "", ap, ctx), f"不该放行：{evil!r}")
            self.assertEqual(len(calls), 2, f"应重新问：{evil!r}")

    def test_headless_allow裸工具名仍放行所有该工具调用(self):
        # --allow run_command 预填裸名进 _approved_tools——操作者显式全量授权，指纹检查须仍认裸名。
        ctx = {"_approved_tools": {"run_command"}}
        ap, calls = _approver([])
        self.assertTrue(agent._approved("run_command", {"command": "anything goes"}, "", ap, ctx))
        self.assertEqual(len(calls), 0)   # 裸名预授权 → 不问


class 打断保留进度(unittest.TestCase):
    def test_打断补齐部分执行轮的悬空toolcall(self):
        # _finalize_interrupt：末段 assistant 声明 a/b 两个 tool_call，只 a 有结果 → 给 b 补配对，a 不重复。
        with tempfile.TemporaryDirectory() as d:
            history = [
                {"role": "user", "content": "x"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "a", "type": "function", "function": {"name": "read_file"}},
                    {"id": "b", "type": "function", "function": {"name": "read_file"}}]},
                {"role": "tool", "tool_call_id": "a", "content": "done a"}]
            agent._finalize_interrupt(history, "被用户打断，勿自动重试", Path(d) / "l.jsonl", {})
            tool_ids = sorted(m["tool_call_id"] for m in history if m.get("role") == "tool")
            self.assertEqual(tool_ids, ["a", "b"])         # b 补上、a 不重复
            self.assertTrue(agent._ends_clean(history))    # 干净可 resume
            b_msg = [m for m in history if m.get("tool_call_id") == "b"][0]
            self.assertIn("重试", b_msg["content"])         # 文案含勿自动重试

    def test_打断保留已完成工具结果且历史干净收尾(self):
        # 第一轮工具往返完成后、下一次发模型时 Ctrl+C → 保留第一轮成果、不整轮回滚、history 干净。
        with tempfile.TemporaryDirectory() as d:
            calls = [0]
            def m(_messages, tools=None):
                calls[0] += 1
                if calls[0] == 1:
                    return {"content": "", "tool_calls": [{"id": "t1", "type": "function",
                            "function": {"name": "read_file", "arguments": '{"path": "nofile_xyz"}'}}]}
                raise KeyboardInterrupt()
            hist = []
            with self.assertRaises(KeyboardInterrupt):
                agent.run_once("读文件", hist, model_fn=m, log_file=Path(d) / "l.jsonl", ctx={"todos": []})
            self.assertTrue(any(mm.get("role") == "tool" and mm.get("tool_call_id") == "t1" for mm in hist))
            self.assertTrue(agent._ends_clean(hist))

    def test_打断保留同轮已完成工具_未执行的补配对(self):
        # 1b（批1二轮审查 MED）：一轮里 A 已执行(真副作用)、审批 B 时 Ctrl+C——须保留 A 的结果、给 B 补配对，不整表回滚。
        with tempfile.TemporaryDirectory() as d:
            def m(_messages, tools=None):
                return {"content": "", "tool_calls": [
                    {"id": "A", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "nofile"}'}},
                    {"id": "B", "type": "function", "function": {"name": "run_command", "arguments": '{"command": "echo hi"}'}}]}
            def appr(name, args, reason):
                raise KeyboardInterrupt()   # 审批 B 时用户 Ctrl+C
            hist = []
            with self.assertRaises(KeyboardInterrupt):
                agent.run_once("干活", hist, model_fn=m, approver=appr, log_file=Path(d) / "l.jsonl", ctx={"todos": []})
            tool_ids = sorted(mm.get("tool_call_id") for mm in hist if mm.get("role") == "tool")
            self.assertEqual(tool_ids, ["A", "B"])   # A 保留、B 补配对
            self.assertTrue(agent._ends_clean(hist))  # 干净可 resume

    def test_一轮都没完成的打断走整表回滚(self):
        # 首次发模型即 Ctrl+C（未完成任何工具往返）→ 整表回滚到进轮前（连本轮 user 也不留）。
        with tempfile.TemporaryDirectory() as d:
            def m0(_messages, tools=None):
                raise KeyboardInterrupt()
            hist = [{"role": "user", "content": "prev"}, {"role": "assistant", "content": "prev-ans"}]
            pre = list(hist)
            with self.assertRaises(KeyboardInterrupt):
                agent.run_once("新问题", hist, model_fn=m0, log_file=Path(d) / "l.jsonl", ctx={"todos": []})
            self.assertEqual(hist, pre)


class 压缩强化包(unittest.TestCase):
    def test_压缩保留最早用户原话逐字进系统区(self):
        # 建议⑥：cut 点前含最初任务陈述被整体摘要 → 长任务后段跑偏。抽第一条 user 原话逐字并入系统区。
        first = "请把项目X所有配置迁移到YAML并保留注释且兼容v1这是硬要求"
        history = _long_hist(first_user=first)
        r = compaction.maybe_compact(history, None, summarizer=lambda o, m: "摘要", budget_chars=1, keep_recent=2)
        self.assertTrue(r)
        sys_text = "".join(str(m.get("content", "")) for m in history if m.get("role") == "system")
        self.assertIn(first[:30], sys_text)   # 原话逐字在场

    def test_二次压缩最初原话不重复堆叠(self):
        first = "独特任务原话ABCDEFG必须逐字保留不许改写"
        history = _long_hist(first_user=first, tag="a")
        compaction.maybe_compact(history, None, summarizer=lambda o, m: "S1", budget_chars=1, keep_recent=2)
        history += [{"role": "assistant", "content": f"b{i}"} for i in range(24)]
        compaction.maybe_compact(history, None, summarizer=lambda o, m: "S2", budget_chars=1, keep_recent=2)
        markers = sum(str(m.get("content", "")).count(compaction._FIRST_USER_PREFIX) for m in history)
        self.assertEqual(markers, 1)   # 逐字原话消息恰一条，二次压缩不叠加

    def test_摘要语义框架含最新用户消息是唯一真相(self):
        history = _long_hist()
        compaction.maybe_compact(history, None, summarizer=lambda o, m: "x", budget_chars=1, keep_recent=2)
        summ = [m for m in history if str(m.get("content", "")).startswith(compaction.SUMMARY_PREFIX)][0]
        self.assertIn("最新用户消息", summ["content"])   # hermes 式语义防御措辞

    def test_压缩连续失败三次后熔断不再调摘要器(self):
        calls = [0]
        def failing(old, mf):
            calls[0] += 1
            raise RuntimeError("boom")
        state = {}
        def run():
            compaction.maybe_compact(_long_hist(), None, summarizer=failing,
                                     budget_chars=1, keep_recent=2, state=state)
        for _ in range(3):
            run()
        mid = calls[0]
        for _ in range(2):
            run()
        self.assertEqual(calls[0], mid)   # 熔断后不再调 summarizer（无人值守下不再空烧）

    def test_摘要失败截半重试一次后成功(self):
        calls = [0]
        def flaky(old, mf):
            calls[0] += 1
            if calls[0] == 1:
                raise RuntimeError("first too big")
            return "截半后成功的摘要"
        history = _long_hist()
        r = compaction.maybe_compact(history, None, summarizer=flaky, budget_chars=1, keep_recent=2, state={})
        self.assertTrue(r)              # 截半重试成功 → 压缩成功
        self.assertEqual(calls[0], 2)   # 原始失败 + 截半成功

    def test_熔断后冷却到期模型恢复则自愈继续压缩(self):
        # 批1审查 MED：熔断不能永久关闭压缩（唯一防溢出网）——冷却期跳过、到期放一次重试，模型恢复即自愈。
        calls = [0]
        healthy = [False]
        def summ(old, mf):
            calls[0] += 1
            if not healthy[0]:
                raise RuntimeError("down")
            return "恢复后的摘要"
        state = {}
        for _ in range(3):   # 连续失败触发熔断
            compaction.maybe_compact(_long_hist(), None, summarizer=summ, budget_chars=1, keep_recent=2, state=state)
        healthy[0] = True    # 模型恢复
        results = [compaction.maybe_compact(_long_hist(), None, summarizer=summ,
                                            budget_chars=1, keep_recent=2, state=state)
                   for _ in range(compaction._COMPACT_COOLDOWN + 1)]
        self.assertTrue(any(results))   # 冷却到期后自愈、至少压缩成功一次


class F24回合内压缩(unittest.TestCase):
    def test_回合内也调压缩不只回合开头(self):
        # F24：单回合长工具链膨胀可越 provider 上限硬失败——回合内累计新增够多也要压。
        with tempfile.TemporaryDirectory() as d:
            calls = [0]
            def m(_messages, tools=None):
                calls[0] += 1
                if calls[0] <= 4:
                    return {"content": "x" * 3000, "tool_calls": [{"id": f"t{calls[0]}", "type": "function",
                            "function": {"name": "update_todos", "arguments": '{"todos": []}'}}]}
                return {"content": "完成", "tool_calls": []}
            counter = [0]
            orig = agent.compaction.maybe_compact
            def spy(*a, **k):
                counter[0] += 1
                return orig(*a, **k)
            with mock.patch.object(agent.compaction, "maybe_compact", spy):
                agent.run_once("干长活", [], model_fn=m, log_file=Path(d) / "l.jsonl",
                               ctx={"todos": []}, summarizer=lambda o, mf: "回合内摘要")
            self.assertGreaterEqual(counter[0], 2)   # 回合开头 1 次 + 回合内累计新增够多 ≥1 次


if __name__ == "__main__":
    unittest.main(verbosity=2)
