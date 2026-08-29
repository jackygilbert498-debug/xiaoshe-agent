"""基线夯实：体检查出的健壮性 bug 回归测试（编码免疫 / 坏档案 / 优雅退出）。

背景：M3 定时调度会让无头模式定时、无人在场地反复跑，任何「一启动就崩」的缝隙
都会被放大成「每次定时都失败且没人发现」。这批测试锁住那些启动/运行期健壮性。

运行：仓库根目录 `python -m unittest discover -s tests -v`
"""
import io
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from harness import _io, config, headless, memory, session


class 记忆文件编码免疫(unittest.TestCase):
    def test_记忆文件是坏编码_备份后以空记忆继续不崩(self):
        # 现实场景：memory.json 进 git 双机同步，冲突后在 Windows 编辑器里存成了 GBK。
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "memory.json"
            p.write_bytes('["旧记忆"]'.encode("gbk"))  # 非 UTF-8：一启动 read_text 就会炸
            facts = memory.load_or_quarantine(p)             # 写入路径：坏档隔离（#37 后隔离挪到这）
            self.assertEqual(facts, [])                       # 以空记忆继续，不抛
            self.assertFalse(p.exists())                      # 原文件已被移走
            backups = list(Path(d).glob("memory.json.corrupt*"))
            self.assertEqual(len(backups), 1)                 # 备份生成，可人工抢救（对齐自家纪律）


class 会话档案坏档案免疫(unittest.TestCase):
    def _tmp(self, d):
        return mock.patch.object(session, "SESSIONS_DIR", Path(d) / "sessions")

    def test_会话档案坏编码_列表跳过不炸启动(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            session.save_session("good", [{"role": "user", "content": "正常会话"}], [])
            bad = session.SESSIONS_DIR / "zbad.json"
            bad.write_bytes(b'\xff\xfe{"history": []}')       # 非 UTF-8：list_sessions 现状会崩
            lst = session.list_sessions(limit=5)
            self.assertEqual([s["id"] for s in lst], ["good"])  # 坏档案被跳过，好档案照列

    def test_会话档案history元素非对象_列表跳过不炸(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            session.save_session("good", [{"role": "user", "content": "正常会话"}], [])
            bad = session.SESSIONS_DIR / "zbad.json"
            bad.write_text('{"history": ["hi"]}', encoding="utf-8")  # 合法 JSON 但元素是字符串
            lst = session.list_sessions(limit=5)
            self.assertEqual([s["id"] for s in lst], ["good"])
            self.assertIsNone(session.load_session("zbad"))  # 恢复路径也判其不可读


class 环境文件编码免疫(unittest.TestCase):
    def test_env文件是坏编码_不崩且告警指路(self):
        # 现实场景：.env 走私密渠道人工拷贝，被中文 Windows 编辑器以 ANSI(GBK) 存盘。
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / ".env"
            p.write_bytes("# 我的密钥配置\nKIMI_API_KEY=abc\n".encode("gbk"))
            buf = io.StringIO()
            with redirect_stderr(buf):
                vals = config._load_env_file(p)   # 现状：import 时刻就在这里崩
            self.assertEqual(vals, {})            # 按未配置处理，绝不崩
            err = buf.getvalue()
            self.assertIn("UTF-8", err)           # 告警说清是编码问题
            self.assertIn(".env", err)            # 并指到具体文件


class 升级迁移健壮性(unittest.TestCase):
    def test_迁移落档失败_不崩且旧档保留下次再试(self):
        # 现实场景：升级后两个终端同刻首启，抢写同一个迁移临时文件（Windows 共享冲突）。
        with tempfile.TemporaryDirectory() as d:
            legacy = Path(d) / ".session" / "last.json"
            legacy.parent.mkdir(parents=True)
            legacy.write_text('{"history": [{"role": "user", "content": "老会话"}], "todos": []}',
                              encoding="utf-8")
            with mock.patch.object(session, "SESSIONS_DIR", Path(d) / "sessions"), \
                 mock.patch.object(session, "LEGACY_FILE", legacy), \
                 mock.patch.object(_io, "atomic_write_json",
                                   side_effect=OSError("模拟双开抢同一临时文件")):
                buf = io.StringIO()
                with redirect_stderr(buf):
                    ok = session.migrate_legacy()  # 现状：OSError 直接炸穿启动
            self.assertFalse(ok)
            self.assertTrue(legacy.exists())       # 旧档没被改名——下次启动还会再试，不丢数据


class 无头模式中断(unittest.TestCase):
    def test_无头任务被CtrlC中断_温和收尾退出码130不甩traceback(self):
        # 现实场景：无头任务等模型回复时用户按 Ctrl+C。现状甩 traceback；应像交互模式一样温和。
        with tempfile.TemporaryDirectory() as d:
            def 模拟按下CtrlC(history, tools=None):
                raise KeyboardInterrupt
            with mock.patch.object(session, "SESSIONS_DIR", Path(d) / "sessions"), \
                 mock.patch.object(session, "LOGS_DIR", Path(d) / "logs"):
                buf = io.StringIO()
                with redirect_stderr(buf):
                    code = headless.run_headless("干个活", model_fn=模拟按下CtrlC)
            self.assertEqual(code, 130)            # 128+SIGINT 惯例：脚本能认出「被中断」≠「失败」
            self.assertIn("中断", buf.getvalue())  # 温和告知，而不是 traceback
