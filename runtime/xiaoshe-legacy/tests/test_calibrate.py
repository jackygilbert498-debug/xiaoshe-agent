"""窗口自校准 · compaction 75% 触发点的地基。TDD 红→绿。

真 Kimi 超限报错形状（探针实测，流式/非流式同形，HTTP 400）：
  {"error":{"message":"Invalid request: Your request exceeded model token limit: 262144 (requested: 367360)",
            "type":"invalid_request_error"}}
provider 明说真窗口(262144)与本次请求量(367360)——窗口当权威落盘，请求量供应急截断算真密度。
运行：仓库根 `python -m unittest tests.test_calibrate -v`
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import calibrate, config

# 真探针抓到的原样报错体（逐字）
REAL_ERR = {"error": {"message": "Invalid request: Your request exceeded model token limit: 262144 (requested: 367360)",
                      "type": "invalid_request_error"}}
REAL_MSG = REAL_ERR["error"]["message"]


class 解析超限报错(unittest.TestCase):
    def test_真形状_dict_带error外层(self):
        self.assertEqual(calibrate.parse_overflow(REAL_ERR), (262144, 367360))

    def test_真形状_message字符串直给(self):
        self.assertEqual(calibrate.parse_overflow(REAL_MSG), (262144, 367360))

    def test_KimiError化的字符串(self):
        # _post 抛的是 f"Kimi 返回错误：{raw['error']}"——dict 的 repr 里数字还在
        s = f"Kimi 返回错误：{REAL_ERR['error']}"
        self.assertEqual(calibrate.parse_overflow(s), (262144, 367360))

    def test_非超限错误_返None(self):
        self.assertIsNone(calibrate.parse_overflow(
            {"error": {"message": "Invalid API key", "type": "authentication_error"}}))

    def test_垃圾与空_返None(self):
        for x in ("", None, "网络断了", {}, {"error": {}}, 12345):
            self.assertIsNone(calibrate.parse_overflow(x))

    def test_红队_窗口过小判坏值返None(self):
        # 「token limit: 5」这种不合理小窗口不能信（会把预算压成 3 token 每轮空压死循环）
        self.assertIsNone(calibrate.parse_overflow("token limit: 5 (requested: 9)"))

    def test_红队_窗口天文数字判坏值返None(self):
        # 注入/坏值报一个巨大窗口 → 75% 闸永不触发 → 每次必溢；越上界即拒
        self.assertIsNone(calibrate.parse_overflow("token limit: 999999999999 (requested: 1000000000000)"))


class 窗口落盘(unittest.TestCase):
    def test_存读往返(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "w.json"
            self.assertTrue(calibrate.save_window(200000, requested=250000, path=p))
            self.assertEqual(calibrate.load_window(p), 200000)

    def test_缺档回退默认(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(calibrate.load_window(Path(d) / "nope.json"), config.CONTEXT_WINDOW_TOKENS)

    def test_坏档回退默认不崩(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "w.json"
            p.write_text("{坏 json", encoding="utf-8")
            self.assertEqual(calibrate.load_window(p), config.CONTEXT_WINDOW_TOKENS)

    def test_红队_落盘越界值读时不信_回退默认(self):
        # 带外篡改/手改把窗口写成 3 → 读路径必须校验越界、回退默认，绝不信坏值
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "w.json"
            p.write_text(json.dumps({"window": 3}), encoding="utf-8")
            self.assertEqual(calibrate.load_window(p), config.CONTEXT_WINDOW_TOKENS)

    def test_越界拒写(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "w.json"
            self.assertFalse(calibrate.save_window(3, path=p))
            self.assertFalse(p.exists())


class 生效窗口与预算(unittest.TestCase):
    def test_effective_ctx覆盖优先于档(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "w.json"
            calibrate.save_window(200000, path=p)
            ctx = {"_context_window": 131072}
            with mock.patch.object(calibrate, "_WINDOW_FILE", p):
                self.assertEqual(calibrate.effective_window(ctx), 131072)   # ctx 内已学到的胜出
                self.assertEqual(calibrate.effective_window(None), 200000)  # 无 ctx 落到档

    def test_learn_window写档且更新ctx(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "w.json"
            ctx = {}
            with mock.patch.object(calibrate, "_WINDOW_FILE", p):
                self.assertTrue(calibrate.learn_window(131072, requested=300000, ctx=ctx))
                self.assertEqual(ctx["_context_window"], 131072)
                self.assertEqual(calibrate.load_window(p), 131072)

    def test_trigger_budget是窗口乘触发比(self):
        ctx = {"_context_window": 262144}
        with mock.patch.object(config, "CONTEXT_BUDGET_OVERRIDE", None), \
             mock.patch.object(config, "COMPACT_TRIGGER_RATIO", 0.75):
            self.assertEqual(calibrate.trigger_budget(ctx), int(262144 * 0.75))

    def test_trigger_budget_显式env覆盖优先(self):
        ctx = {"_context_window": 262144}
        with mock.patch.object(config, "CONTEXT_BUDGET_OVERRIDE", 100000):
            self.assertEqual(calibrate.trigger_budget(ctx), 100000)   # 用户显式设了预算 → 尊重，不派生


class 红队修(unittest.TestCase):
    def test_MED_预算override零或负视为未设(self):
        # KIMI_CONTEXT_BUDGET_TOKENS=0/负 是「关掉/无限」的自然约定，绝不能当合法预算 0（→每轮必压白烧摘要）
        self.assertIsNone(config._parse_budget_override("0"))
        self.assertIsNone(config._parse_budget_override("-100"))
        self.assertIsNone(config._parse_budget_override(""))
        self.assertIsNone(config._parse_budget_override("abc"))
        self.assertEqual(config._parse_budget_override("100000"), 100000)

    def test_LOW_窗口越界一律夹取(self):
        self.assertEqual(config._clamp_window(100), config.WINDOW_MIN)
        self.assertEqual(config._clamp_window(10 ** 9), config.WINDOW_MAX)
        self.assertEqual(config._clamp_window(262144), 262144)

    def test_LOW_config回退窗口也被夹取(self):
        # load_window/effective_window 回退到 config 时也须落在 [MIN,MAX]，别破坏模块窗口界不变量
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(config, "CONTEXT_WINDOW_TOKENS", 100):     # 坏配置：远低于下界
            self.assertGreaterEqual(calibrate.load_window(Path(d) / "nope.json"), calibrate._MIN_WINDOW)
            self.assertGreaterEqual(calibrate.effective_window({}), calibrate._MIN_WINDOW)

    def test_MED_落盘失败不抛且ctx仍收紧(self):
        # .state 不可写时：save_window 返 False 不抛（别把「超限=缩了重试」退回「超限=硬失败」）；
        # 且 learn_window 先写 ctx 内存预算、不受落盘失败影响。
        with tempfile.TemporaryDirectory() as d:
            bad = Path(d) / "not_a_dir"
            bad.write_text("x", encoding="utf-8")            # 父路径是普通文件 → mkdir 抛 → 应被吞
            self.assertFalse(calibrate.save_window(200000, path=bad / "w.json"))
            ctx = {}
            with mock.patch.object(calibrate, "_WINDOW_FILE", bad / "w.json"):
                calibrate.learn_window(200000, requested=300000, ctx=ctx)
            self.assertEqual(ctx["_context_window"], 200000)  # 落盘挂了但 ctx 收紧仍生效

    def test_LOW_跨模型陈旧窗口不采用(self):
        # 落盘带模型标识；换模型后旧的小窗口记录不采用，回退默认，别永久拖累新模型压缩预算
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "w.json"
            with mock.patch.object(config, "MODEL", "old-model"):
                calibrate.save_window(50000, path=p)
            with mock.patch.object(config, "MODEL", "new-model"):
                self.assertEqual(calibrate.load_window(p), config.CONTEXT_WINDOW_TOKENS)  # 陈旧→回退默认
            with mock.patch.object(config, "MODEL", "old-model"):
                self.assertEqual(calibrate.load_window(p), 50000)                          # 同模型→采用


if __name__ == "__main__":
    unittest.main(verbosity=2)
