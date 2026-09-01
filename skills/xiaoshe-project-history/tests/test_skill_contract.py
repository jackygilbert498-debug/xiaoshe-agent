from __future__ import annotations

import json
from pathlib import Path
import re
import unittest

from xiaoshe_history.config import read_source_config


SKILL_ROOT = Path(__file__).resolve().parents[1]


class SkillContractTests(unittest.TestCase):
    def test_skill_entrypoint_has_discriminating_frontmatter_and_modes(self) -> None:
        skill_path = SKILL_ROOT / "SKILL.md"
        text = skill_path.read_text(encoding="utf-8")
        match = re.match(r"\A---\n(?P<frontmatter>.*?)\n---\n(?P<body>.*)\Z", text, re.DOTALL)
        self.assertIsNotNone(match)
        frontmatter = match.group("frontmatter")
        body = match.group("body")
        self.assertIn("name: xiaoshe-project-history", frontmatter)
        description = next(
            line.removeprefix("description:").strip()
            for line in frontmatter.splitlines()
            if line.startswith("description:")
        )
        self.assertTrue(description.startswith("Use when"))
        for mode in (
            "configure",
            "doctor",
            "inventory",
            "timeline",
            "compare",
            "gaps",
            "course-export",
        ):
            self.assertIn(f"`{mode}`", body)
        self.assertIn("read-only", body.lower())
        self.assertIn("integrity-failed", body)

    def test_skill_references_only_existing_resources(self) -> None:
        text = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
        referenced = re.findall(r"\((references/[^)]+|scripts/[^)]+)\)", text)
        self.assertTrue(referenced)
        for relative in referenced:
            self.assertTrue((SKILL_ROOT / relative).is_file(), relative)

    def test_ui_metadata_mentions_explicit_skill_invocation(self) -> None:
        text = (SKILL_ROOT / "agents" / "openai.yaml").read_text(encoding="utf-8")
        self.assertIn('$xiaoshe-project-history', text)
        self.assertIn('allow_implicit_invocation: true', text)

    def test_example_config_is_v2_parseable_and_contains_no_personal_path(self) -> None:
        example = SKILL_ROOT / "references" / "source-config.example.json"

        sources = read_source_config(example)
        raw = example.read_text(encoding="utf-8")

        self.assertGreaterEqual(len(sources), 3)
        self.assertNotIn("C:\\Users", raw)
        self.assertTrue(any(source.archive_prefix for source in sources))

        published = (
            SKILL_ROOT / "references" / "source-config.published.example.json"
        )
        published_sources = read_source_config(published)
        published_raw = published.read_text(encoding="utf-8")
        self.assertEqual(
            [source.source_id for source in published_sources],
            ["xiaoshe-release", "handoffs"],
        )
        self.assertNotIn("C:\\Users", published_raw)

    def test_reusable_artifacts_have_no_author_path_or_windows_launcher_dependency(self) -> None:
        offenders: list[str] = []
        for path in SKILL_ROOT.rglob("*"):
            if "tests" in path.parts:
                continue
            if path.suffix.lower() not in {".md", ".json", ".yaml", ".py"}:
                continue
            text = path.read_text(encoding="utf-8-sig")
            if "C:\\Users\\zfy20" in text or "py -3" in text:
                offenders.append(str(path.relative_to(SKILL_ROOT)))

        self.assertEqual(offenders, [])

    def test_reference_scenarios_cover_full_first_run_and_failure_workflow(self) -> None:
        payload = json.loads(
            (SKILL_ROOT / "evals" / "scenarios.json").read_text(encoding="utf-8")
        )
        self.assertEqual(payload["schema"], "xiaoshe-history-evals/v1")
        self.assertGreaterEqual(len(payload["scenarios"]), 7)
        self.assertTrue(
            {
                "configure",
                "doctor",
                "inventory",
                "compare",
                "gaps",
                "course-export",
            }.issubset({scenario["mode"] for scenario in payload["scenarios"]})
        )
        for scenario in payload["scenarios"]:
            self.assertTrue(scenario["mustInclude"])
            self.assertTrue(scenario["forbiddenActions"])


if __name__ == "__main__":
    unittest.main()
