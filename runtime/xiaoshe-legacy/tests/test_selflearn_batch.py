"""A2a 第二级 · 增量2 攒批触发：小会话不够料就不烧，摘要攒进批缓冲（.state，gitignored），
攒够 N 条或 M 字符烧一次学一批；与省钱闸/预算闸串联：省钱闸判够不够料 → 攒批缓冲 → 够批+预算够 → 烧。
运行：仓库根 `python -m unittest tests.test_selflearn_batch -v`
"""
import json
import tempfile
import unittest
from pathlib import Path

from harness import selflearn, skills


def _small(i):
    """过不了省钱闸（轮数<2）但有实质内容的小会话。"""
    return [{"role": "user", "content": f"小任务{i}：顺手改个错别字 " + "细" * 40}]


def _big():
    """过省钱闸的大会话（老路径：即时复盘）。"""
    return [{"role": "user", "content": "大任务 " + "问" * 200},
            {"role": "assistant", "content": "好的 " + "答" * 200},
            {"role": "user", "content": "继续 " + "问" * 200}]


def _good_reply():
    return json.dumps({"name": "批量改错别字", "when": "文档有错别字时",
                       "description": "批量修正文档错别字", "steps": "1. 搜常见错字\n2. 逐个替换\n3. 复查"},
                      ensure_ascii=False)


class 攒批(unittest.TestCase):
    def test_小会话攒起来不烧(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            called = []
            for i in range(selflearn._BATCH_MIN_ITEMS - 1):
                r = selflearn.learn_on_session_end({}, _small(i), spawn_fn=lambda t: called.append(t) or "NONE",
                                                   path=base)
                self.assertIsNone(r)
            self.assertEqual(called, [])                                    # 不够批：一次都不烧
            self.assertTrue(len(selflearn._batch_load(selflearn._batch_path(base))) >= 1)  # 但攒下来了

    def test_没实质内容的会话不攒(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.learn_on_session_end({}, [{"role": "user", "content": "hi"}],
                                           spawn_fn=lambda t: "NONE", path=base)
            self.assertEqual(selflearn._batch_load(selflearn._batch_path(base)), [])   # 太薄不攒

    def test_攒够条数烧一次学一批(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            seen = []
            slug = None
            for i in range(selflearn._BATCH_MIN_ITEMS):
                slug = selflearn.learn_on_session_end({}, _small(i),
                                                      spawn_fn=lambda t: seen.append(t) or _good_reply(), path=base)
            self.assertEqual(len(seen), 1)                                  # N 条只烧一次
            self.assertTrue(slug)
            self.assertIn("小任务0", seen[0])                               # 一批合并进 prompt
            self.assertIn(f"小任务{selflearn._BATCH_MIN_ITEMS - 1}", seen[0])
            self.assertEqual(len(selflearn.list_pending(base)), 1)          # 产出仍只进 pending（人审硬门）
            self.assertEqual(skills.list_skills(base), [])
            self.assertEqual(selflearn._batch_load(selflearn._batch_path(base)), [])   # 烧完清空

    def test_攒够字符也烧(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            seen = []
            # 单轮用户发言（过不了轮数闸）但摘要总量 ≥ M 字符
            h = [{"role": "user", "content": "大段独白 " + "字" * 120}]
            for _ in range(6):
                h.append({"role": "assistant", "content": "嗯 " + "字" * 280})
            selflearn.learn_on_session_end({}, h, spawn_fn=lambda t: seen.append(t) or "NONE", path=base)
            self.assertEqual(len(seen), 1)                                  # 字符量够批 → 烧

    def test_大会话走老路径即时复盘不攒(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            slug = selflearn.learn_on_session_end({}, _big(), spawn_fn=lambda t: _good_reply(), path=base)
            self.assertTrue(slug)                                           # 老行为不变：即时烧
            self.assertEqual(selflearn._batch_load(selflearn._batch_path(base)), [])   # 不进批缓冲

    def test_批里配对片段也进prompt(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            seen = []
            def small_recovery(i):
                return [{"role": "user", "content": f"小任务{i}：跑脚本报错了 " + "细" * 40},
                        {"role": "assistant", "content": "换个参数重试成功了 " + "做" * 40}]
            for i in range(selflearn._BATCH_MIN_ITEMS):
                selflearn.learn_on_session_end({}, small_recovery(i),
                                               spawn_fn=lambda t: seen.append(t) or "NONE", path=base)
            self.assertEqual(len(seen), 1)
            self.assertIn("优先", seen[0])                                  # 攒批的配对片段同样标优先

    def test_预算不够不清缓冲下回再试(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            bp = base / "bg_lm_budget.json"
            for i in range(selflearn._BG_DAILY_LM_BUDGET):                  # 先把每日预算烧光（每 sid 还有会话帽，换着 sid 烧）
                self.assertTrue(selflearn.bg_lm_try(f"别的会话{i}", budget_path=bp))
            called = []
            for i in range(selflearn._BATCH_MIN_ITEMS):
                r = selflearn.learn_on_session_end({}, _small(i), spawn_fn=lambda t: called.append(t) or "NONE",
                                                   path=base)
                self.assertIsNone(r)
            self.assertEqual(called, [])                                    # 预算挡下：没烧
            self.assertEqual(len(selflearn._batch_load(selflearn._batch_path(base))),
                             selflearn._BATCH_MIN_ITEMS)                    # 缓冲保留，下回再试

    def test_分身炸异常缓冲保留(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            def boom(task):
                raise RuntimeError("分身炸了")
            for i in range(selflearn._BATCH_MIN_ITEMS):
                self.assertIsNone(selflearn.learn_on_session_end({}, _small(i), spawn_fn=boom, path=base))
            self.assertEqual(len(selflearn._batch_load(selflearn._batch_path(base))),
                             selflearn._BATCH_MIN_ITEMS)                    # 没烧成就别丢料


class 批缓冲注入面(unittest.TestCase):
    def test_带外篡改批缓冲读时防御(self):
        # 红队：脏摘要直接写进批缓冲档（隐形字符/超长/奇形/超量）→ 读时中和截断限量，不原样进 prompt
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            bp = selflearn._batch_path(base)
            dirty = {"items": (
                [{"digest": "脏​摘要\x07 " + "长" * 9000, "pairs": ["​\x07" + "p" * 5000]}] * 50
                + ["不是字典", {"no_digest": 1}, {"digest": "正常小摘要 " + "字" * 60}])}
            bp.write_text(json.dumps(dirty, ensure_ascii=False), encoding="utf-8")
            seen = []
            selflearn.learn_on_session_end({}, _small(99), spawn_fn=lambda t: seen.append(t) or "NONE", path=base)
            self.assertTrue(seen)                                           # 量够烧了
            task = seen[0]
            self.assertNotIn("​", task)                                # 隐形字符没进 prompt
            self.assertNotIn("\x07", task)
            self.assertLessEqual(len(task), 40000)                          # 总量有顶
            self.assertIn("正常小摘要", task)

    def test_坏档不崩从头攒(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            bp = selflearn._batch_path(base)
            bp.write_text("不是 json", encoding="utf-8")
            called = []
            selflearn.learn_on_session_end({}, _small(0), spawn_fn=lambda t: called.append(t) or "NONE", path=base)
            self.assertEqual(called, [])                                    # 坏档当空缓冲，不崩不烧


if __name__ == "__main__":
    unittest.main(verbosity=2)
