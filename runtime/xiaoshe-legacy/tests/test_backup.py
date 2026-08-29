"""P6 · 交付件：.state 运行态备份/恢复。TDD 红→绿。

商用级得能一键备份/还原运行态（会话/定时/后台/日志/视觉 blob），换机或误删不丢。
恢复防 tarbomb（路径穿越成员/软链逃逸跳过）+ 非空目标须 force（防误覆盖当前运行态）。全离线。
运行：仓库根 `python -m unittest tests.test_backup -v`
"""
import io
import tarfile
import tempfile
import unittest
from pathlib import Path

from harness import backup


class 备份恢复(unittest.TestCase):
    def test_备份再恢复往返_内容一致(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / ".state"
            (src / "sessions").mkdir(parents=True)
            (src / "sessions" / "a.json").write_text("会话数据X", encoding="utf-8")
            (src / "schedule").mkdir()
            (src / "schedule" / "t.json").write_text("定时Y", encoding="utf-8")
            arc = Path(d) / "bak.tar.gz"
            backup.create_backup(arc, src_dir=src)
            self.assertTrue(arc.exists())

            tgt = Path(d) / "restored"
            tgt.mkdir()
            ok, _ = backup.restore_backup(arc, target_dir=tgt)
            self.assertTrue(ok)
            self.assertEqual((tgt / ".state" / "sessions" / "a.json").read_text(encoding="utf-8"), "会话数据X")
            self.assertEqual((tgt / ".state" / "schedule" / "t.json").read_text(encoding="utf-8"), "定时Y")

    def test_恢复拒绝路径穿越成员_防tarbomb(self):
        with tempfile.TemporaryDirectory() as d:
            arc = Path(d) / "evil.tar.gz"
            with tarfile.open(arc, "w:gz") as tar:
                data = b"pwned"
                info = tarfile.TarInfo(name="../evil.txt")   # 穿越到 target 外
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            tgt = Path(d) / "tgt"
            tgt.mkdir()
            backup.restore_backup(arc, target_dir=tgt, force=True)
            self.assertFalse((Path(d) / "evil.txt").exists())   # 穿越成员被跳过、没写到 target 外

    def test_恢复拒绝逃出state落到仓库根的成员_防越界覆盖RCE(self):
        # H1：成员 `.state/../evil.env` 解析到 target/evil.env——在 target(=ROOT) 内、但在 .state 外。
        # 旧围栏钉在 ROOT 会放行 → 可覆盖 .env / harness/*.py（潜在 RCE/密钥劫持）；
        # 新围栏钉在 .state 必须拒绝：只有真落在 .state/ 里的成员才解。
        with tempfile.TemporaryDirectory() as d:
            arc = Path(d) / "evil.tar.gz"
            with tarfile.open(arc, "w:gz") as tar:
                data = b"pwned"
                info = tarfile.TarInfo(name=".state/../evil.env")   # 前缀是 .state 但 ../ 逃回仓库根
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            tgt = Path(d) / "tgt"
            (tgt / ".state").mkdir(parents=True)
            backup.restore_backup(arc, target_dir=tgt, force=True)
            self.assertFalse((tgt / "evil.env").exists())          # 逃出 .state 的成员被拒、没落到仓库根

    def test_恢复拒绝无state前缀的裸成员(self):
        # H1 补充：归档根不是 .state 的成员（如直接一个 `.env`）也必须拒——只认 .state/ 下的东西。
        with tempfile.TemporaryDirectory() as d:
            arc = Path(d) / "evil2.tar.gz"
            with tarfile.open(arc, "w:gz") as tar:
                data = b"pwned"
                info = tarfile.TarInfo(name=".env")                 # 裸成员、不在 .state/ 下
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            tgt = Path(d) / "tgt"
            (tgt / ".state").mkdir(parents=True)
            backup.restore_backup(arc, target_dir=tgt, force=True)
            self.assertFalse((tgt / ".env").exists())

    def test_恢复不覆盖非空目标除非force(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / ".state"
            src.mkdir()
            (src / "x").write_text("1", encoding="utf-8")
            arc = Path(d) / "b.tar.gz"
            backup.create_backup(arc, src_dir=src)

            tgt = Path(d) / "tgt"
            (tgt / ".state").mkdir(parents=True)
            (tgt / ".state" / "existing").write_text("旧的别删", encoding="utf-8")
            ok, _ = backup.restore_backup(arc, target_dir=tgt, force=False)
            self.assertFalse(ok)                                 # 非空目标拒绝覆盖
            self.assertTrue((tgt / ".state" / "existing").exists())
            ok2, _ = backup.restore_backup(arc, target_dir=tgt, force=True)
            self.assertTrue(ok2)                                 # force 才覆盖恢复


if __name__ == "__main__":
    unittest.main(verbosity=2)
