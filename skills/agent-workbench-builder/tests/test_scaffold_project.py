from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from scaffold_project import ScaffoldError, scaffold


def build_focused(root: Path, name: str = "单场景 项目", *, runtime: str = "dsh") -> Path:
    destination = root / name
    scaffold(
        destination,
        product_kind="focused-agent",
        slug="request-triage-agent",
        title="请求分诊 Agent",
        scenario="把本地请求分诊为待办",
        primary_user="项目负责人",
        trigger="收到新的请求文件",
        input_description="包含 task_id、scenario_id 和 content 的 JSON",
        observable_output="经批准后生成的任务 JSON",
        dangerous_write="在输出目录创建任务文件",
        runtime=runtime,
    )
    return destination


def blueprint() -> dict[str, object]:
    return json.loads(
        (SKILL_ROOT / "assets/workbench-blueprint.example.json").read_text(encoding="utf-8")
    )


def build_workbench(root: Path, name: str = "通用 工作台") -> Path:
    destination = root / name
    scaffold(
        destination,
        product_kind="workbench",
        blueprint=blueprint(),
    )
    return destination


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


class ScaffoldTests(unittest.TestCase):
    def test_focused_scaffold_is_deterministic_and_portable(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            first = build_focused(root, "项目 一")
            second = build_focused(root, "项目 二")
            self.assertEqual(tree_digest(first), tree_digest(second))
            text = "\n".join(
                path.read_text(encoding="utf-8")
                for path in first.rglob("*")
                if path.is_file() and path.suffix not in {".zip", ".pyc", ".pyo"}
            )
            self.assertNotIn("__PROJECT_", text)
            self.assertNotIn(str(SKILL_ROOT), text)
            contract = json.loads((first / "agent_project.json").read_text(encoding="utf-8"))
            provenance = json.loads(
                (first / "builder-provenance.json").read_text(encoding="utf-8")
            )
            self.assertEqual(contract["schema"], "agent-workbench-project/v4")
            self.assertEqual(contract["project"]["kind"], "focused-agent")
            self.assertEqual(len(contract["capabilities"]), 1)
            self.assertEqual(len(contract["acceptanceScenarios"]), 1)
            self.assertFalse(contract["runtime"]["bundled"])
            self.assertEqual(contract["development"]["stage"], "starter")
            self.assertEqual(
                contract["development"]["domainEvidence"]["fixtures"],
                "fixtures/domain-cases.json",
            )
            self.assertEqual(provenance["schema"], "agent-workbench-builder-provenance/v3")
            self.assertEqual(provenance["starterStage"], "starter")
            self.assertEqual(
                set(provenance["starterFileSha256"]),
                set(contract["development"]["criticalFiles"]),
            )
            self.assertTrue(
                all(len(value) == 64 for value in provenance["starterFileSha256"].values())
            )
            self.assertTrue((first / "fixtures/domain-cases.json").is_file())
            self.assertFalse(any(path.name == "DSH" and path.is_dir() for path in first.rglob("*")))

    def test_workbench_scaffold_preserves_multiple_capabilities_and_scenarios(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            project = build_workbench(Path(raw))
            contract = json.loads((project / "agent_project.json").read_text(encoding="utf-8"))
            provenance = json.loads(
                (project / "builder-provenance.json").read_text(encoding="utf-8")
            )
            self.assertEqual(contract["project"]["kind"], "workbench")
            self.assertEqual(len(contract["capabilities"]), 3)
            self.assertEqual(len(contract["acceptanceScenarios"]), 3)
            self.assertEqual(provenance["productKind"], "workbench")
            self.assertTrue((project / "src/capabilities.mjs").is_file())
            fixtures = json.loads(
                (project / "fixtures/domain-cases.json").read_text(encoding="utf-8")
            )
            positive = [case for case in fixtures["cases"] if case["kind"] == "positive"]
            boundary = [case for case in fixtures["cases"] if case["kind"] == "boundary"]
            self.assertGreaterEqual(len(positive), 3)
            self.assertGreaterEqual(len(boundary), 1)
            self.assertEqual(
                {case["scenarioId"] for case in positive},
                {item["id"] for item in contract["acceptanceScenarios"]},
            )
            self.assertEqual(
                {case["capabilityId"] for case in positive},
                {item["id"] for item in contract["capabilities"]},
            )

    def test_documented_workbench_blueprint_is_runnable(self) -> None:
        text = (SKILL_ROOT / "references/workbench-blueprint.md").read_text(
            encoding="utf-8"
        )
        fenced_json = text.split("```json", 1)[1].split("```", 1)[0]
        documented_blueprint = json.loads(fenced_json)
        with tempfile.TemporaryDirectory() as raw:
            project = Path(raw) / "documented-workbench"
            scaffold(
                project,
                product_kind="workbench",
                blueprint=documented_blueprint,
            )
            contract = json.loads(
                (project / "agent_project.json").read_text(encoding="utf-8")
            )
            self.assertEqual(contract["project"]["kind"], "workbench")
            self.assertEqual(len(contract["capabilities"]), 2)
            self.assertEqual(len(contract["acceptanceScenarios"]), 3)

    def test_existing_destination_is_never_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            destination = Path(raw) / "existing"
            destination.mkdir()
            marker = destination / "keep.txt"
            marker.write_text("keep", encoding="utf-8")
            with self.assertRaises(ScaffoldError):
                build_focused(Path(raw), "existing")
            self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

    def test_invalid_slug_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            with self.assertRaises(ScaffoldError):
                scaffold(
                    Path(raw) / "project",
                    product_kind="focused-agent",
                    slug="Bad Slug",
                    title="Title",
                    scenario="Scenario",
                    primary_user="User",
                    trigger="Trigger",
                    input_description="Input",
                    observable_output="Output",
                    dangerous_write="Write",
                )

    def test_workbench_rejects_single_scenario_blueprint(self) -> None:
        value = blueprint()
        value["scenarios"] = value["scenarios"][:1]
        with tempfile.TemporaryDirectory() as raw:
            with self.assertRaisesRegex(ScaffoldError, "3-20"):
                scaffold(
                    Path(raw) / "project",
                    product_kind="workbench",
                    blueprint=value,
                )

    def test_generated_projects_run_their_unit_tests(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            for project in (build_focused(Path(raw)), build_workbench(Path(raw))):
                completed = subprocess.run(
                    [sys.executable, "tools/test_project.py"],
                    cwd=project,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=60,
                    check=False,
                )
                self.assertEqual(
                    completed.returncode,
                    0,
                    completed.stderr.decode(errors="replace"),
                )

    def test_standalone_supports_focused_agent_only(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            destination = build_focused(Path(raw), "standalone", runtime="standalone")
            self.assertTrue((destination / "agent_workbench/core.py").is_file())
            self.assertFalse((destination / "cordis.patch.yml").exists())
            with self.assertRaisesRegex(ScaffoldError, "focused-agent only"):
                scaffold(
                    Path(raw) / "unsupported",
                    product_kind="workbench",
                    blueprint=blueprint(),
                    runtime="standalone",
                )


if __name__ == "__main__":
    unittest.main()
