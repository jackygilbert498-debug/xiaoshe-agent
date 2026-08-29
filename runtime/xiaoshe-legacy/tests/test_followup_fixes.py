"""接手后续修复批：3 条核实过的真 bug（TDD 先写红，再修绿）。

1. kimi_client._post 非流式解码不对称：curl 吐非 UTF-8 字节时该转 KimiError，而非裸抛 UnicodeDecodeError
   （流式路径 _post_stream 已带 errors="replace"，非流式漏了）。
2. schedule.stop_task 毒化下一次：pidfile 陈旧/缺 child_pid 时不该落 .stopped 标记（否则下一次正常
   运行被误记 interrupted），且缺 child_pid 时不该裸抛 TypeError。
3. permission 命令扫描 token 补齐常见凭据文件（.aws/.netrc/.npmrc/.pypirc/.pgpass/.dockercfg/.gnupg）。
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import kimi_client, permission, schedule


@unittest.skipIf(os.name == "nt", "假 curl 用 sh 脚本，仅 POSIX；bug/修复本身与平台无关")
class 非流式返回非UTF8字节(unittest.TestCase):
    def test_curl吐非UTF8字节_转成KimiError而非裸崩UnicodeDecodeError(self):
        d = tempfile.mkdtemp()
        fake = Path(d) / "fake_curl.sh"
        # 读掉 -K - 的配置(stdin)后，往 stdout 打三个非法 UTF-8 起始字节 + 文本，退出码 0
        fake.write_text("#!/bin/sh\ncat >/dev/null 2>&1\nprintf '\\377\\376\\375bad'\n")
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        with mock.patch.object(kimi_client.config, "API_KEY", "sk-x"), \
             mock.patch.object(kimi_client.config, "PROXY", ""), \
             mock.patch.object(kimi_client.config, "CURL", str(fake)):
            with self.assertRaises(kimi_client.KimiError):
                kimi_client._post({"model": "m", "messages": []}, timeout=5, retry=0)


class 急停陈旧pidfile不毒化下一次(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self._patch = mock.patch.object(schedule, "RUNNING_DIR", Path(self.d))
        self._patch.start()

    def tearDown(self):
        self._patch.stop()

    def _write_pidfile(self, name, info):
        schedule._pid_path(name).write_text(json.dumps(info), encoding="utf-8")

    def test_pidfile陈旧_进程早没了_不落stopped标记且清理陈旧记录(self):
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()  # 收尸后 pid 不再存活
        self._write_pidfile("报时", {"child_pid": dead.pid, "supervisor_pid": os.getpid()})
        result = schedule.stop_task("报时")
        self.assertFalse(result)  # 没在跑
        self.assertFalse((schedule.RUNNING_DIR / "报时.stopped").exists())  # 关键：没毒化下一次
        self.assertFalse(schedule._pid_path("报时").exists())  # 陈旧 pidfile 已清

    def test_pidfile缺child_pid_不裸抛TypeError_干净返回False(self):
        self._write_pidfile("报时", {"supervisor_pid": os.getpid()})  # 无 child_pid
        result = schedule.stop_task("报时")  # 不能抛异常
        self.assertFalse(result)
        self.assertFalse((schedule.RUNNING_DIR / "报时.stopped").exists())

    @unittest.skipIf(os.name == "nt", "用 killpg 探活/急停，仅 POSIX")
    def test_进程还活着_正常急停_落stopped标记并杀掉(self):
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                                start_new_session=True)
        try:
            self._write_pidfile("报时", {"child_pid": proc.pid, "supervisor_pid": os.getpid()})
            result = schedule.stop_task("报时")
            self.assertTrue(result)
            self.assertTrue((schedule.RUNNING_DIR / "报时.stopped").exists())
            self.assertEqual(proc.wait(timeout=5), -15)  # 被 SIGTERM 杀掉
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


class 命令密钥硬拒补齐(unittest.TestCase):
    def _deny(self, cmd):
        self.assertEqual(permission.check("run_command", {"command": cmd}).action, "deny",
                         f"应硬拒：{cmd}")

    def test_补齐常见凭据文件一律硬拒(self):
        self._deny("cat ~/.aws/config")          # AWS（credentials 已被旧 token 覆盖，这里测 .aws 目录）
        self._deny("cat ~/.netrc")               # netrc 登录凭据
        self._deny("cat ~/.npmrc")               # npm token
        self._deny("cat ~/.pypirc")              # PyPI 上传凭据
        self._deny("cat ~/.pgpass")              # Postgres 密码
        self._deny("cat ~/.dockercfg")           # Docker registry 凭据
        self._deny("gpg --homedir ~/.gnupg -a")  # GPG 私钥环

    def test_相近的正常命令不被误拒_仍是ask(self):
        # 只含 "aws"/"npm" 而无凭据文件名——不该退化成 deny
        self.assertEqual(permission.check("run_command", {"command": "aws s3 ls"}).action, "ask")
        self.assertEqual(permission.check("run_command", {"command": "npm install"}).action, "ask")


if __name__ == "__main__":
    unittest.main()
