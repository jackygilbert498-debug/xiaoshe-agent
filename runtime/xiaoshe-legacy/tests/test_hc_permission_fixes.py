"""体检·全仓审查修复 · permission 三条（2 HIGH + 1 MED）。TDD 红→绿。

#1 HIGH：_is_sensitive 与 _cmd_hits 敏感集漂移——凭据文件走 read_file 零审批泄漏。
#2 HIGH：press_keys 的 SendKeys 花括号「产字符组」({n 1}/{h 10}) 绕过密钥硬护栏。
#3 MED：run_command 密钥扫描被 shell 通配符（.e* / .en? / id_rs?）绕过。
"""
import unittest

from harness import permission


class 凭据文件护栏漂移(unittest.TestCase):
    def test_凭据文件对read_file也硬拒(self):
        # 这些文件 _cmd_hits 早已拦，read_file 却零审批放行（read_file 在 SAFE_TOOLS）→ 补齐
        for name in [".netrc", ".npmrc", ".pypirc", ".pgpass", ".dockercfg", ".git-credentials"]:
            self.assertEqual(permission.check("read_file", {"path": name}).action, "deny", name)

    def test_ssh_aws_gnupg目录下文件硬拒(self):
        for path in [".ssh/known_hosts", ".ssh/config", ".aws/credentials", ".gnupg/secring.gpg"]:
            self.assertEqual(permission.check("read_file", {"path": path}).action, "deny", path)

    def test_safe_path对凭据文件抛错(self):
        with self.assertRaises(permission.PathError):
            permission.safe_path(".npmrc")

    def test_正常文件不误伤(self):
        for name in ["README.md", "notes.txt", "app.py"]:
            self.assertNotEqual(permission.check("read_file", {"path": name}).action, "deny", name)


class SendKeys花括号组绕过(unittest.TestCase):
    def test_产字符花括号组敲密钥命令被拦(self):
        for keys in ["cat .e{n 1}v{ENTER}", "type .e{n 1}v",
                     "{c 1}{a 1}{t 1}{ }{. 1}{e 1}{n 1}{v 1}{ENTER}", "gc id_rs{a 1}{ENTER}"]:
            self.assertEqual(permission.check("press_keys", {"keys": keys}).action, "deny", keys)

    def test_净零导航键老绕过仍拦_回归(self):
        self.assertEqual(permission.check("press_keys", {"keys": "cat .e{LEFT}{RIGHT}nv{ENTER}"}).action, "deny")

    def test_普通打字不误伤(self):
        self.assertEqual(permission.check("press_keys", {"keys": "hello{ENTER}"}).action, "ask")


class run_command通配符绕过(unittest.TestCase):
    def test_通配符读密钥被拦(self):
        for cmd in ["get-content .e*", "type .en?", "gc .e[n]v", "cat id_rs?", "type .en*"]:
            self.assertEqual(permission.check("run_command", {"command": cmd}).action, "deny", cmd)

    def test_普通通配命令不误伤(self):
        for cmd in ["dir *.py", "ls src/*.ts", "grep -r foo ./**"]:
            self.assertNotEqual(permission.check("run_command", {"command": cmd}).action, "deny", cmd)


if __name__ == "__main__":
    unittest.main(verbosity=2)
