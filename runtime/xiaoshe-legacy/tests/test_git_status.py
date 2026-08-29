import unittest

from harness.git_status import StatusParseError, parse_porcelain_v2


class GitStatusParserTests(unittest.TestCase):
    def test_nul_format_preserves_spaces_unicode_and_rename_pairs(self):
        raw = (b"# branch.head main\0"
               b"1 M. N... 100644 100644 100644 abc def \xe7\x9b\xae\xe5\xbd\x95/\xe6\x9c\x89 \xe7\xa9\xba\xe6\xa0\xbc.py\0"
               b"2 R. N... 100644 100644 100644 abc def R100 \xe6\x96\xb0 \xe5\x90\x8d.py\0\xe6\x97\xa7\n\xe5\x90\x8d.py\0")
        status = parse_porcelain_v2(raw)
        self.assertIn("目录/有 空格.py", [item.path for item in status.changed])
        self.assertEqual("旧\n名.py", status.renamed[0].original_path)
        self.assertEqual("main", status.branch)

    def test_rejects_absolute_or_parent_escape(self):
        for raw in (b"? ../escape\0", b"? C:/outside\0", b"? /etc/passwd\0"):
            with self.subTest(raw=raw):
                with self.assertRaisesRegex(StatusParseError, "PATH_OUTSIDE_PROJECT"):
                    parse_porcelain_v2(raw)

    def test_rejects_unknown_and_truncated_records(self):
        with self.assertRaisesRegex(StatusParseError, "STATUS_RECORD_UNKNOWN"):
            parse_porcelain_v2(b"x bad\0")
        with self.assertRaisesRegex(StatusParseError, "STATUS_RECORD_TRUNCATED"):
            parse_porcelain_v2(b"2 R. N... 1 1 1 a b R100 new\0")

    def test_parses_unmerged_record_without_human_status_output(self):
        status = parse_porcelain_v2(b"u UU N... 100644 100644 100644 100644 a b c conflict.py\0")
        self.assertEqual("conflict.py", status.unmerged[0].path)


if __name__ == "__main__":
    unittest.main()
