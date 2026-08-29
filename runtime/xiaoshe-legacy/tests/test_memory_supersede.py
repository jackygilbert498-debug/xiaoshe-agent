"""§3.1 记忆第四操作 superseded 软失效：新条目声明取代旧条目，旧条目不删、不进注入/速览、:memory 可见可复活。

红队重点：superseded 链防环 / 链长上限（批量软失效 DoS 注入区）/ 复活不洗信任 / 注入区默认滤掉。
运行：仓库根 `py -3 -m unittest tests.test_memory_supersede -v`
"""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from harness import memory


class _MemCase(unittest.TestCase):
    def setUp(self):
        self._d = TemporaryDirectory()
        self.p = Path(self._d.name) / "memory.json"
        self.addCleanup(self._d.cleanup)


class 软失效基本(_MemCase):
    def test_supersede标旧增新(self):
        memory.remember("部署目标是 v1", path=self.p, zone="决策")
        old_id = memory.live_records(self.p)[0]["id"]
        new_id = memory.supersede(old_id, "部署目标是 v2", path=self.p, zone="决策")
        self.assertTrue(new_id)
        recs = {r["id"]: r for r in memory.load_records(self.p)}
        self.assertEqual(recs[old_id]["superseded_by"], new_id)   # 旧条目指到新条目
        self.assertTrue(recs[old_id]["superseded_at"])            # 双时间戳：失效时间落上了
        self.assertIsNone(recs[old_id]["invalid_at"])             # 不删（审计链保留）
        self.assertEqual(recs[new_id]["text"], "部署目标是 v2")

    def test_superseded不进注入与速览(self):
        memory.remember("旧事实", path=self.p, zone="现状")
        old_id = memory.live_records(self.p)[0]["id"]
        memory.supersede(old_id, "新事实", path=self.p, zone="现状")
        sysmsg = memory.system_message(self.p)["content"]
        self.assertNotIn("旧事实", sysmsg)                        # 注入区滤掉
        self.assertIn("新事实", sysmsg)
        glance = memory.brain_summary(self.p)
        self.assertIn("记忆 1 条", glance)                        # 速览只数有效（未被取代）的

    def test_superseded仍可被人审视图看到(self):
        memory.remember("旧事实", path=self.p)
        old_id = memory.live_records(self.p)[0]["id"]
        memory.supersede(old_id, "新事实", path=self.p)
        texts = [r["text"] for r in memory.live_records(self.p)]  # live_records 含被取代的（可见可复活）
        self.assertIn("旧事实", texts)
        sup = memory.superseded_records(self.p)
        self.assertEqual([r["text"] for r in sup], ["旧事实"])

    def test_revive复活后重新进注入(self):
        memory.remember("旧事实", path=self.p)
        old_id = memory.live_records(self.p)[0]["id"]
        memory.supersede(old_id, "新事实", path=self.p)
        self.assertTrue(memory.revive_by_id(old_id, path=self.p))
        rec = {r["id"]: r for r in memory.load_records(self.p)}[old_id]
        self.assertIsNone(rec["superseded_by"])
        self.assertIsNone(rec["superseded_at"])
        self.assertIn("旧事实", memory.system_message(self.p)["content"])

    def test_revive非superseded返回False(self):
        memory.remember("正常事实", path=self.p)
        rid = memory.live_records(self.p)[0]["id"]
        self.assertFalse(memory.revive_by_id(rid, path=self.p))
        self.assertFalse(memory.revive_by_id("deadbeef0000", path=self.p))


class 防滥用(_MemCase):
    def test_目标已被取代则拒绝_防环(self):
        # A→B 合法；再 supersede A（已被取代）必须拒——否则 A→C 与 B 的链分叉/成环无从判活
        memory.remember("A", path=self.p)
        a = memory.live_records(self.p)[0]["id"]
        b = memory.supersede(a, "B", path=self.p)
        self.assertIsNone(memory.supersede(a, "C", path=self.p))
        # 链头 B 仍可被 C 取代（链式演进 A→B→C 合法）
        c = memory.supersede(b, "C", path=self.p)
        self.assertTrue(c)
        # 再让 C 取代回 A 的内容也不行——A 已被取代（闭环的最后一条路也堵死）
        self.assertIsNone(memory.supersede(a, "A", path=self.p))

    def test_新旧同内容不是更新(self):
        memory.remember("同一条", path=self.p)
        rid = memory.live_records(self.p)[0]["id"]
        self.assertIsNone(memory.supersede(rid, "同一条", path=self.p))   # 同内容 id 相同，非更新
        rec = memory.load_records(self.p)[0]
        self.assertIsNone(rec["superseded_by"])

    def test_不存在的目标返回None(self):
        memory.remember("x", path=self.p)
        self.assertIsNone(memory.supersede("deadbeef0000", "新", path=self.p))

    def test_软删的目标不能supersede(self):
        memory.remember("已忘", path=self.p)
        memory.forget_by_index(1, path=self.p)
        rid = memory.load_records(self.p)[0]["id"]
        self.assertIsNone(memory.supersede(rid, "新", path=self.p))

    def test_空新文本拒绝(self):
        memory.remember("x", path=self.p)
        rid = memory.live_records(self.p)[0]["id"]
        self.assertIsNone(memory.supersede(rid, "   ", path=self.p))

    def test_链长上限防批量软失效DoS(self):
        # 链式取代无限延长会把历史全堆成 superseded——超 _MAX_SUPERSEDE_CHAIN 拒绝（限额校准口）
        memory.remember("v0", path=self.p)
        head = memory.live_records(self.p)[0]["id"]
        with mock.patch.object(memory, "_MAX_SUPERSEDE_CHAIN", 3):
            for i in range(1, 3):
                head = memory.supersede(head, f"v{i}", path=self.p)
                self.assertTrue(head)
            self.assertIsNone(memory.supersede(head, "v3", path=self.p))   # 第 4 节超上限

    def test_记忆满了supersede不硬塞(self):
        with mock.patch.object(memory, "_MAX_FACTS", 1):
            memory.remember("唯一一条", path=self.p)
            rid = memory.live_records(self.p)[0]["id"]
            self.assertIsNone(memory.supersede(rid, "想塞进来的", path=self.p))
            rec = memory.load_records(self.p)[0]
            self.assertIsNone(rec["superseded_by"])   # 没加成也没把旧条目标死


class 信任与合并(_MemCase):
    def test_复活不洗信任(self):
        # 不可信来源的旧事实被取代后复活，source 仍取更不可信——复活不是洗白通道
        memory.remember("外部来的事实", path=self.p, source="untrusted")
        old_id = memory.live_records(self.p)[0]["id"]
        memory.supersede(old_id, "取代它", path=self.p, source="user")
        memory.revive_by_id(old_id, path=self.p)
        rec = {r["id"]: r for r in memory.load_records(self.p)}[old_id]
        self.assertEqual(rec["source"], "untrusted")

    def test_remember同一条复活时清superseded(self):
        # 显式再记同一条 = 用户声明它又是当前事实 → 复活得连 superseded 一起清
        memory.remember("反复横跳的事实", path=self.p)
        rid = memory.live_records(self.p)[0]["id"]
        memory.supersede(rid, "别的事实", path=self.p)
        memory.remember("反复横跳的事实", path=self.p)
        rec = {r["id"]: r for r in memory.load_records(self.p)}[rid]
        self.assertIsNone(rec["superseded_by"])
        self.assertIn("反复横跳的事实", memory.system_message(self.p)["content"])

    def test_merge保留superseded双字段(self):
        a = [{"id": "x", "text": "旧", "source": "user", "superseded_by": "y", "superseded_at": "2026-01-01"}]
        b = [{"id": "y", "text": "新", "source": "user"}]
        merged = {r["id"]: r for r in memory.merge_facts(a, b)}
        self.assertEqual(merged["x"]["superseded_by"], "y")
        self.assertEqual(merged["x"]["superseded_at"], "2026-01-01")

    def test_新条目继承目标分区(self):
        memory.remember("旧决策", path=self.p, zone="决策")
        rid = memory.live_records(self.p)[0]["id"]
        memory.supersede(rid, "新决策", path=self.p)   # 不显式给 zone → 跟旧条目分区走
        recs = {r["text"]: r for r in memory.load_records(self.p)}
        self.assertEqual(recs["新决策"]["zone"], "决策")


class 人审视图集成(unittest.TestCase):
    def setUp(self):
        self._d = TemporaryDirectory()
        self.p = Path(self._d.name) / "memory.json"
        self.addCleanup(self._d.cleanup)
        from harness import agent
        self.agent = agent
        self.out = []

    def test_memory视图标出被取代条目(self):
        memory.remember("旧事实", path=self.p)
        rid = memory.live_records(self.p)[0]["id"]
        memory.supersede(rid, "新事实", path=self.p)
        self.agent._handle_memory_command(":memory", confirm=lambda p: "y", out=self.out.append, path=self.p)
        txt = "\n".join(self.out)
        self.assertIn("旧事实", txt)
        self.assertIn("已被取代", txt)   # 人看得到它不再进注入

    def test_memory_revive命令复活(self):
        memory.remember("旧事实", path=self.p)
        rid = memory.live_records(self.p)[0]["id"]
        memory.supersede(rid, "新事实", path=self.p)
        n = next(i for i, r in enumerate(memory.live_records(self.p), 1) if r["id"] == rid)
        self.agent._handle_memory_command(f":memory revive {n}", confirm=lambda p: "y",
                                          out=self.out.append, path=self.p)
        rec = {r["id"]: r for r in memory.load_records(self.p)}[rid]
        self.assertIsNone(rec["superseded_by"])

    def test_memory_revive拒绝不动(self):
        memory.remember("旧事实", path=self.p)
        rid = memory.live_records(self.p)[0]["id"]
        memory.supersede(rid, "新事实", path=self.p)
        n = next(i for i, r in enumerate(memory.live_records(self.p), 1) if r["id"] == rid)
        self.agent._handle_memory_command(f":memory revive {n}", confirm=lambda p: "n",
                                          out=self.out.append, path=self.p)
        rec = {r["id"]: r for r in memory.load_records(self.p)}[rid]
        self.assertEqual(rec["superseded_by"], memory._gen_id("新事实"))


if __name__ == "__main__":
    unittest.main()
