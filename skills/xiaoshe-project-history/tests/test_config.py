from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from xiaoshe_history.config import (
    ConfigurationError,
    build_xiaoshe_config,
    read_source_config,
    write_config,
)


class SourceConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def write_payload(self, payload: object) -> Path:
        path = self.root / "来源 配置.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    def test_v1_relative_paths_remain_readable(self) -> None:
        config_path = self.write_payload(
            {
                "schema": "xiaoshe-history-sources/v1",
                "sources": [
                    {
                        "id": "xs",
                        "kind": "git",
                        "path": "工作区/XS",
                        "manifest": "工作区/XS/交接工具/完整性清单.json",
                    }
                ],
            }
        )

        sources = read_source_config(config_path)

        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0].source_id, "xs")
        self.assertEqual(sources[0].path, (self.root / "工作区/XS").resolve())
        self.assertEqual(
            sources[0].manifest,
            (self.root / "工作区/XS/交接工具/完整性清单.json").resolve(),
        )
        self.assertIsNone(sources[0].archive_prefix)

    def test_v2_preserves_explicit_archive_prefix(self) -> None:
        config_path = self.write_payload(
            {
                "schema": "xiaoshe-history-sources/v2",
                "sources": [
                    {
                        "id": "legacy-desktop",
                        "kind": "git-with-stashes",
                        "path": "小蛇",
                        "archivePrefix": "runtime/xiaoshe-legacy/",
                    }
                ],
            }
        )

        source = read_source_config(config_path)[0]

        self.assertEqual(source.archive_prefix, "runtime/xiaoshe-legacy/")

    def test_unknown_fields_and_duplicate_ids_are_rejected(self) -> None:
        unknown = self.write_payload(
            {
                "schema": "xiaoshe-history-sources/v2",
                "sources": [
                    {"id": "xs", "kind": "git", "path": "XS", "surprise": True}
                ],
            }
        )
        with self.assertRaisesRegex(ConfigurationError, "unknown fields"):
            read_source_config(unknown)

        duplicate = self.write_payload(
            {
                "schema": "xiaoshe-history-sources/v2",
                "sources": [
                    {"id": "same", "kind": "git", "path": "one"},
                    {"id": "same", "kind": "git", "path": "two"},
                ],
            }
        )
        with self.assertRaisesRegex(ConfigurationError, "duplicate source id"):
            read_source_config(duplicate)

    def test_builder_derives_only_xs_children_and_uses_explicit_optional_roots(self) -> None:
        xs = self.root / "我的 XS"
        desktop_legacy = self.root / "历史 小蛇"
        handoffs = self.root / "往期 归档"

        payload = build_xiaoshe_config(
            xs_root=xs,
            dsh_root=None,
            embedded_legacy_root=None,
            desktop_legacy_root=desktop_legacy,
            handoff_directory=handoffs,
        )

        self.assertEqual(payload["schema"], "xiaoshe-history-sources/v2")
        by_id = {entry["id"]: entry for entry in payload["sources"]}
        self.assertEqual(by_id["dsh"]["path"], str((xs / "runtime/DSH").resolve()))
        self.assertEqual(
            by_id["embedded-legacy"]["path"],
            str((xs / "runtime/xiaoshe-legacy").resolve()),
        )
        self.assertEqual(
            by_id["desktop-legacy"]["archivePrefix"],
            "runtime/xiaoshe-legacy/",
        )
        self.assertEqual(by_id["handoffs"]["path"], str(handoffs.resolve()))

    def test_builder_published_layout_keeps_one_git_source(self) -> None:
        release = self.root / "公开版 小蛇"
        handoffs = self.root / "最终交接"

        payload = build_xiaoshe_config(
            xs_root=release,
            dsh_root=None,
            embedded_legacy_root=None,
            desktop_legacy_root=None,
            handoff_directory=handoffs,
            layout="published",
        )

        self.assertEqual(
            payload["sources"],
            [
                {
                    "id": "xiaoshe-release",
                    "kind": "git",
                    "path": str(release.resolve()),
                },
                {
                    "id": "handoffs",
                    "kind": "archive-directory",
                    "path": str(handoffs.resolve()),
                },
            ],
        )

    def test_write_config_refuses_overwrite_and_round_trips_unicode_path(self) -> None:
        target = self.root / "带 空格" / "来源.json"
        payload = build_xiaoshe_config(
            xs_root=self.root / "项目 XS",
            dsh_root=None,
            embedded_legacy_root=None,
            desktop_legacy_root=None,
            handoff_directory=None,
        )

        write_config(target, payload, overwrite=False)
        before = target.read_bytes()
        with self.assertRaisesRegex(ConfigurationError, "already exists"):
            write_config(target, payload, overwrite=False)

        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(len(read_source_config(target)), 3)


if __name__ == "__main__":
    unittest.main()
