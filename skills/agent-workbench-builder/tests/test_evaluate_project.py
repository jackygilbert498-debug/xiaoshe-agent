from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from evaluate_project import EvaluationError, evaluate
from scaffold_project import scaffold


def make_project(root: Path) -> Path:
    project = root / "不同 Agent 项目"
    scaffold(
        project,
        product_kind="focused-agent",
        slug="request-triage-agent",
        title="请求分诊 Agent",
        scenario="把本地请求分诊为待办",
        primary_user="项目负责人",
        trigger="收到新的请求文件",
        input_description="包含 request_id 和 content 的 JSON",
        observable_output="经批准后生成的任务 JSON",
        dangerous_write="在输出目录创建任务文件",
        runtime="standalone",
    )
    return project


def adapt_standalone_project(project: Path) -> None:
    """Turn the generated starter into a small but behaviorally distinct domain."""

    contract_path = project / "agent_project.json"
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    contract["development"]["stage"] = "domain-adapted"
    contract_path.write_text(
        json.dumps(contract, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    domain_path = project / "agent_workbench/domain.py"
    domain_text = domain_path.read_text(encoding="utf-8")
    domain_text = domain_text.replace(
        '("发票", "预算", "invoice", "budget")',
        '("发票", "预算", "报销", "invoice", "budget", "expense")',
    ).replace(
        'category = "finance"',
        'category = "expense-review"',
    )
    domain_path.write_text(domain_text, encoding="utf-8")

    fixture_path = project / "fixtures/domain-cases.json"
    fixture_path.write_text(
        json.dumps(
            {
                "schema": "agent-workbench-domain-fixtures/v1",
                "cases": [
                    {
                        "id": "expense-urgent",
                        "kind": "positive",
                        "scenarioId": "primary-task",
                        "capabilityId": "core-task",
                        "input": {
                            "request_id": "expense-001",
                            "content": "今天需要审核这笔报销",
                        },
                        "expected": {"category": "expense-review", "priority": "high"},
                    },
                    {
                        "id": "general-normal",
                        "kind": "positive",
                        "scenarioId": "primary-task",
                        "capabilityId": "core-task",
                        "input": {
                            "request_id": "general-001",
                            "content": "整理下周资料",
                        },
                        "expected": {"category": "general", "priority": "normal"},
                    },
                    {
                        "id": "empty-content",
                        "kind": "boundary",
                        "scenarioId": "primary-task",
                        "capabilityId": "core-task",
                        "input": {
                            "request_id": "invalid-001",
                            "content": "",
                        },
                        "expectedError": "INVALID_REQUEST",
                    },
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    domain_test = project / "tests/test_workbench.py"
    domain_test.write_text(
        domain_test.read_text(encoding="utf-8")
        + "\n# Domain fixture: expense-review is intentionally project-specific.\n",
        encoding="utf-8",
    )


class EvaluateTests(unittest.TestCase):
    def test_workbench_contract_requires_multiple_representative_scenarios(self) -> None:
        blueprint = json.loads(
            (SCRIPTS.parent / "assets/workbench-blueprint.example.json").read_text(
                encoding="utf-8"
            )
        )
        with tempfile.TemporaryDirectory() as raw:
            project = Path(raw) / "workbench"
            scaffold(
                project,
                product_kind="workbench",
                blueprint=blueprint,
            )
            contract_path = project / "agent_project.json"
            contract = json.loads(contract_path.read_text(encoding="utf-8"))
            contract["acceptanceScenarios"] = contract["acceptanceScenarios"][:2]
            contract_path.write_text(json.dumps(contract), encoding="utf-8")
            with self.assertRaisesRegex(EvaluationError, "representative scenario coverage"):
                evaluate(project, run_commands=False, timeout=60)

    def test_live_evaluation_passes_and_no_run_stays_partial(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            project = make_project(Path(raw))
            starter, starter_code = evaluate(project, run_commands=True, timeout=60)
            self.assertEqual((starter["status"], starter_code), ("PARTIAL", 2))
            self.assertEqual(starter["project"]["developmentStage"], "starter")
            self.assertEqual(
                next(gate for gate in starter["hardGates"] if gate["id"] == "domain-adaptation")["status"],
                "partial",
            )

            adapt_standalone_project(project)
            live, code = evaluate(project, run_commands=True, timeout=60)
            self.assertEqual((live["status"], code), ("PASS", 0))
            self.assertEqual(live["score"]["earned"], 20)
            self.assertTrue(all(gate["status"] == "pass" for gate in live["hardGates"]))
            (project / "evidence/graduation.json").write_text(
                json.dumps(live, ensure_ascii=False), encoding="utf-8"
            )
            repeated, repeated_code = evaluate(project, run_commands=True, timeout=60)
            self.assertEqual((repeated["status"], repeated_code), ("PASS", 0))
            self.assertEqual(repeated["resultDigest"], live["resultDigest"])
            no_run, no_run_code = evaluate(project, run_commands=False, timeout=60)
            self.assertEqual((no_run["status"], no_run_code), ("PARTIAL", 2))
            self.assertIn("partial", {gate["status"] for gate in no_run["hardGates"]})

    def test_machine_absolute_path_fails_clean_handoff_gate(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            project = make_project(Path(raw))
            adapt_standalone_project(project)
            readme = project / "README.md"
            readme.write_text(readme.read_text(encoding="utf-8") + "\n/Users/example/private/file\n", encoding="utf-8")
            report, code = evaluate(project, run_commands=True, timeout=60)
            self.assertEqual((report["status"], code), ("FAIL", 3))
            self.assertFalse(report["staticScan"]["passed"])
            self.assertEqual(report["staticScan"]["violations"][0]["kind"], "machine-absolute-path")

    def test_tampered_archive_is_not_accepted_from_stale_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            project = make_project(Path(raw))
            adapt_standalone_project(project)
            live, code = evaluate(project, run_commands=True, timeout=60)
            self.assertEqual(code, 0)
            archive = project / "dist/request-triage-agent-handoff.zip"
            archive.write_bytes(archive.read_bytes() + b"tamper")
            report, code = evaluate(project, run_commands=False, timeout=60)
            self.assertEqual((report["status"], code), ("FAIL", 3))
            self.assertFalse(report["evidenceSummary"]["handoffVerified"])

    def test_arbitrary_executable_command_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            project = make_project(Path(raw))
            contract_path = project / "agent_project.json"
            contract = json.loads(contract_path.read_text(encoding="utf-8"))
            contract["commands"]["test"] = ["bash", "-c", "echo unsafe"]
            contract_path.write_text(json.dumps(contract), encoding="utf-8")
            with self.assertRaises(EvaluationError):
                evaluate(project, run_commands=False, timeout=60)

    def test_stage_flip_without_changed_domain_files_cannot_graduate(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            project = make_project(Path(raw))
            contract_path = project / "agent_project.json"
            contract = json.loads(contract_path.read_text(encoding="utf-8"))
            contract["development"]["stage"] = "domain-adapted"
            contract_path.write_text(
                json.dumps(contract, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            report, code = evaluate(project, run_commands=True, timeout=60)
            self.assertEqual((report["status"], code), ("PARTIAL", 2))
            gate = next(
                item for item in report["hardGates"] if item["id"] == "domain-adaptation"
            )
            self.assertEqual(gate["status"], "partial")
            self.assertIn("starter-files-unchanged", gate["reasonCodes"])

    def test_domain_fixture_must_keep_a_boundary_case(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            project = make_project(Path(raw))
            adapt_standalone_project(project)
            fixtures_path = project / "fixtures/domain-cases.json"
            fixtures = json.loads(fixtures_path.read_text(encoding="utf-8"))
            fixtures["cases"] = [case for case in fixtures["cases"] if case["kind"] == "positive"]
            fixtures_path.write_text(
                json.dumps(fixtures, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            report, code = evaluate(project, run_commands=True, timeout=60)
            self.assertNotEqual((report["status"], code), ("PASS", 0))
            gate = next(
                item for item in report["hardGates"] if item["id"] == "domain-adaptation"
            )
            self.assertIn(gate["status"], {"partial", "fail"})


if __name__ == "__main__":
    unittest.main()
