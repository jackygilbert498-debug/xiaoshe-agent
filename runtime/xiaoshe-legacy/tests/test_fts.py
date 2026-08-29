"""FTS5 统一检索层（harness/fts.py）：统一索引 + 统一查询 + 统一降级 + 写路径同步钩子。

纪律：TDD（本测试先于实现写）；运行 `py -3 -m unittest tests.test_fts -v`。
隔离：monkeypatch 各源模块的文件常量到 tmp；fts 进程内可用性缓存每个用例重置。
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import cheatsheet, episodic, fts, memory, session


class _Base(unittest.TestCase):
    """把四类源 + fts db 全部指到 tmp 目录，重置 fts 进程内缓存。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.mem_file = root / "memory.json"
        self.cheat_file = root / "cheatsheet.json"
        self.ep_file = root / "episodic.jsonl"
        self.sess_dir = root / "sessions"
        self.db_file = root / "fts.db"
        patchers = [
            mock.patch.object(memory, "MEMORY_FILE", self.mem_file),
            mock.patch.object(cheatsheet, "CHEATSHEET_FILE", self.cheat_file),
            mock.patch.object(episodic, "EPISODIC_FILE", self.ep_file),
            mock.patch.object(session, "SESSIONS_DIR", self.sess_dir),
            mock.patch.object(fts, "DB_FILE", self.db_file),
        ]
        for p in patchers:
            p.start()
            self.addCleanup(p.stop)
        fts.reset_cache()
        self.addCleanup(fts.reset_cache)


class 分词(_Base):
    def test_bigramize中文重叠bigram加unigram(self):
        toks = fts._tokens("中文测试")
        for t in ("中", "文", "测", "试", "中文", "文测", "测试"):
            self.assertIn(t, toks)

    def test_bigramize混合ascii(self):
        toks = fts._tokens("用 sqlite3 做检索层")
        self.assertIn("sqlite3", toks)
        self.assertIn("检索", toks)
        self.assertIn("索层", toks)

    def test_空查询无token(self):
        self.assertEqual(fts._tokens("  "), [])
        self.assertEqual(fts._tokens("，。！"), [])


class 索引与查询(_Base):
    def _seed_memory(self):
        memory.remember("部署方案定在周五，用 sqlite3 做统一检索层")
        memory.remember("小抄写路径只留最新四十条")

    def test_写路径顺带更新索引_两字中文查询命中(self):
        self._seed_memory()  # 不经手工 sync——钩子应已顺带索引
        r = fts.search("部署")
        self.assertFalse(r["degraded"])
        self.assertEqual(r["engine"], "fts5")
        self.assertEqual(len(r["results"]), 1)
        self.assertEqual(r["results"][0]["kind"], "memory")
        self.assertIn("部署方案", r["results"][0]["text"])

    def test_单字与ascii查询(self):
        self._seed_memory()
        self.assertTrue(fts.search("署")["results"])
        self.assertEqual(len(fts.search("sqlite3")["results"]), 1)
        self.assertEqual(len(fts.search("SQLITE3")["results"]), 1)  # ASCII 大小写折叠

    def test_未命中返回空不崩(self):
        self._seed_memory()
        r = fts.search("绝不存在的词组搭配甲乙丙")
        self.assertEqual(r["results"], [])

    def test_kinds过滤(self):
        self._seed_memory()
        cheatsheet.add_tip("部署前先跑全量测试")
        r_all = fts.search("部署")
        self.assertEqual({x["kind"] for x in r_all["results"]}, {"memory", "cheatsheet"})
        r_mem = fts.search("部署", kinds=["memory"])
        self.assertEqual({x["kind"] for x in r_all["results"]} - {"cheatsheet"},
                         {x["kind"] for x in r_mem["results"]})

    def test_limit生效(self):
        for i in range(6):
            memory.remember(f"检索第{i}条互不相同的记忆事实")
        r = fts.search("检索", limit=3)
        self.assertLessEqual(len(r["results"]), 3)

    def test_滤superseded与软删(self):
        memory.remember("旧结论：检索层用 whoosh")
        old = memory.live_records()[0]["id"]
        memory.supersede(old, "新结论：检索层用 fts5")
        r = fts.search("whoosh")
        self.assertEqual(r["results"], [])           # 被取代的不进索引
        self.assertTrue(fts.search("fts5")["results"])
        new_id = next(r["id"] for r in memory.live_records() if "fts5" in r["text"])
        memory.forget_by_id(new_id)
        self.assertEqual(fts.search("fts5")["results"], [])  # 软删同步出索引

    def test_episodic与会话存档进索引(self):
        episodic.append_episode({"task": "修检索层分词", "lesson": "trigram 两字查询不命中", "kind": "subagent"})
        self.sess_dir.mkdir(parents=True, exist_ok=True)
        session.save_session("t20260724-120000-1-1",
                             [{"role": "user", "content": "讨论统一检索层怎么落地"},
                              {"role": "assistant", "content": "好"}], [])
        self.assertTrue(any(x["kind"] == "episodic" for x in fts.search("trigram")["results"]))
        hits = fts.search("落地", kinds=["session"])
        self.assertEqual(len(hits["results"]), 1)
        self.assertEqual(hits["results"][0]["ref"], "t20260724-120000-1-1")

    def test_空查询安全返回空(self):
        self._seed_memory()
        r = fts.search("  ，。！")
        self.assertEqual(r["results"], [])


class 红队_查询注入(_Base):
    def test_MATCH元字符查询不炸(self):
        memory.remember("部署方案定在周五")
        for q in ('" OR *', 'NEAR(部署 方案)', '(', ')', '{body}: 部署', '部署:方案',
                  '*', '部署*', 'a" b', '部署 AND', 'OR', '部署"', '"', '\\', 'body: *'):
            r = fts.search(q)  # 不抛异常即防线成立
            self.assertIn(r["engine"], ("fts5", "scan"))
            self.assertIsInstance(r["results"], list)


class 降级(_Base):
    def test_坏档自动校验重建(self):
        memory.remember("坏档重建后仍能搜到这句话")
        fts.ensure()
        self.db_file.write_bytes(b"garbage-not-a-sqlite-db")  # 模拟 db 损坏
        fts.reset_cache()
        r = fts.search("坏档重建")
        self.assertFalse(r["degraded"])          # 重建成功，继续走 fts5
        self.assertEqual(len(r["results"]), 1)

    def test_FTS5不可用降级逐字扫描_口径一致(self):
        memory.remember("降级路径也要能搜到这条记忆")
        cheatsheet.add_tip("降级小抄：先重启再排查")
        with mock.patch.object(fts, "ensure", return_value=False):
            r = fts.search("降级")
        self.assertTrue(r["degraded"])
        self.assertEqual(r["engine"], "scan")
        self.assertEqual({x["kind"] for x in r["results"]}, {"memory", "cheatsheet"})

    def test_降级扫描同样滤superseded(self):
        memory.remember("被取代的旧事实含特有词甲乙丙")
        old = memory.live_records()[0]["id"]
        memory.supersede(old, "新事实不含那个词")
        with mock.patch.object(fts, "ensure", return_value=False):
            r = fts.search("甲乙丙")
        self.assertEqual(r["results"], [])


class 同步钩子(_Base):
    def test_钩子失败不拖垮主写路径(self):
        with mock.patch.object(fts, "sync_kind", side_effect=RuntimeError("索引炸了")):
            self.assertTrue(memory.remember("索引挂了记忆照记"))
            self.assertTrue(cheatsheet.add_tip("索引挂了小抄照记"))
        episodic.append_episode({"task": "t", "lesson": "索引挂了复盘照落"})  # 内部自带降级
        self.assertEqual(memory.load_records()[0]["text"], "索引挂了记忆照记")

    def test_显式path不写默认索引(self):
        other = Path(self._tmp.name) / "other_memory.json"
        memory.remember("显式路径的记忆不进检索索引", path=other)
        r = fts.search("显式路径")
        self.assertEqual(r["results"], [])

    def test_带外改源文件_启动校验追上(self):
        memory.remember("第一版事实带有关键词初版")
        fts.ensure()
        # 带外（绕过钩子）直接改源文件
        self.mem_file.write_text(json.dumps(
            [memory._new_record("带外写入的第二版关键词改版")], ensure_ascii=False), encoding="utf-8")
        fts.reset_cache()  # 模拟新进程启动：ensure 校验签名发现过期→重建
        r = fts.search("改版")
        self.assertEqual(len(r["results"]), 1)
        self.assertEqual(fts.search("初版")["results"], [])

    def test_删除记忆钩子同步(self):
        memory.remember("马上要被忘掉的事丁戊己")
        self.assertTrue(fts.search("丁戊己")["results"])
        memory.forget_by_index(1)
        self.assertEqual(fts.search("丁戊己")["results"], [])


class 消费点入口(_Base):
    def test_memory_search入口_带degraded标记且中和(self):
        memory.remember("正常一条关于部署的记忆")
        r = memory.search("部署")
        self.assertIn("degraded", r)
        self.assertTrue(r["results"])
        # 不可信内容防线：隐形字符/换行不得穿透到结果文本
        memory.remember("带​零宽​和\n换行的记忆事实")
        r2 = memory.search("零宽")
        for hit in r2["results"]:
            self.assertNotIn("​", hit["text"])
            self.assertNotIn("\n", hit["text"])

    def test_memory_search降级(self):
        memory.remember("降级也能搜的记忆")
        with mock.patch.object(fts, "ensure", return_value=False):
            r = memory.search("降级")
        self.assertTrue(r["degraded"])
        self.assertTrue(r["results"])

    def test_session_search_sessions入口(self):
        self.sess_dir.mkdir(parents=True, exist_ok=True)
        session.save_session("t20260724-130000-1-1",
                             [{"role": "user", "content": "帮我看看检索层方案"}], [])
        r = session.search_sessions("检索层")
        self.assertFalse(r["degraded"])
        self.assertEqual(r["results"][0]["ref"], "t20260724-130000-1-1")
        self.assertIn("检索层", r["results"][0]["text"])

    def test_结果文本按不可信中和(self):
        memory.remember("含\x00控制符的记忆庚辛壬")
        r = memory.search("庚辛壬")
        self.assertTrue(r["results"])
        self.assertNotIn("\x00", r["results"][0]["text"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
