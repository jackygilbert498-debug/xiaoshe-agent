"""P0 · D4 尾批（非契约的四小修，TDD 红→绿）：

- #32 .pub 豁免收紧：credentials.pub/secrets.pub 是伪装，不该被"公钥豁免"放行
- #34 会话 todos 坏类型归空：setdefault 只补缺、不纠坏类型，坏 todos 会穿透
- #27 后台任务启动失败不留孤儿日志：Popen 起不来时临时日志文件要删掉
- #36 原子写 fsync 父目录（POSIX）：os.replace 后目录项变更也要落地才抗掉电

运行：仓库根 `python -m unittest discover -s tests -v`
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import _io, jobs, permission, session


class 敏感pub豁免收紧(unittest.TestCase):
    def test_credentials点pub与secrets点pub不再被豁免_仍判敏感(self):
        self.assertTrue(permission._is_sensitive(Path("credentials.pub")))
        self.assertTrue(permission._is_sensitive(Path("secrets.pub")))

    def test_真SSH公钥id开头与普通pub仍豁免_不误杀(self):
        for n in ("id_ed25519.pub", "id_rsa.pub", "mykey.pub"):
            self.assertFalse(permission._is_sensitive(Path(n)), f"{n} 不该被判敏感")


class 会话todos坏类型归空(unittest.TestCase):
    def test_todos是坏类型时load归空list_不穿透(self):
        d = tempfile.mkdtemp()
        p = Path(d) / "s.json"
        p.write_text(json.dumps({"history": [{"role": "user", "content": "hi"}],
                                 "todos": "我不是list"}), encoding="utf-8")
        data = session.load(p)
        self.assertEqual(data["todos"], [])


class 后台启动失败不留孤儿日志(unittest.TestCase):
    def test_Popen起不来时日志文件被删不留盘(self):
        d = tempfile.mkdtemp()
        with mock.patch.object(jobs, "JOBS_DIR", Path(d)), \
             mock.patch.object(jobs.subprocess, "Popen", side_effect=OSError("起不来")):
            with self.assertRaises(OSError):
                jobs.start("坏命令", cwd=d)
        self.assertEqual(list(Path(d).glob("*.log")), [], "Popen 失败应删掉空日志文件")


class 原子写fsync父目录(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "父目录 fsync 仅 POSIX 有意义")
    def test_replace后父目录被fsync_且内容不变(self):
        d = tempfile.mkdtemp()
        p = Path(d) / "f.txt"
        dir_fds, synced_dirs = {}, []
        real_open, real_fsync = os.open, os.fsync

        def spy_open(path, flags, *a, **k):
            fd = real_open(path, flags, *a, **k)
            if os.path.isdir(path):
                dir_fds[fd] = str(path)
            return fd

        def spy_fsync(fd):
            if fd in dir_fds:
                synced_dirs.append(dir_fds[fd])
            return real_fsync(fd)

        with mock.patch.object(_io.os, "open", spy_open), \
             mock.patch.object(_io.os, "fsync", spy_fsync):
            _io.atomic_write_text(p, "hello 落地")
        self.assertEqual(p.read_text(encoding="utf-8"), "hello 落地")  # 行为不变
        self.assertIn(str(p.parent), synced_dirs, "os.replace 后应 fsync 父目录")


if __name__ == "__main__":
    unittest.main()
