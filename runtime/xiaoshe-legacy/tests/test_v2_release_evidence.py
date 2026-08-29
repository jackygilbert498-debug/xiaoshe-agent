from __future__ import annotations

import copy
import hashlib
import io
import json
import math
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from scripts.validate_v2_release import (
    ValidationFailure,
    canonical_hash,
    canonical_self_hash,
    hash_allowed_artifacts,
    load_expected_document,
    main,
    repository_snapshot,
    validate_governance_status,
    validate_release_evidence,
)


SHA_A = "sha256:" + "a" * 64
SHA_B = "sha256:" + "b" * 64
HEAD_A = "a" * 40
EMPTY_SHA = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
LOCAL_COMMANDS = {
    "plan11-task1-8-focused": "py -3 -X utf8 -m unittest tests.test_model_registry tests.test_model_client tests.test_model_adapters tests.test_model_secrets tests.test_provider_switch tests.test_provider_delivery_closure tests.test_context_budget tests.test_prompt_prefix tests.test_calibrate tests.test_headless_ctx tests.test_runtime_metrics tests.test_inbox_adapters tests.test_task_inbox tests.test_task_api tests.test_feishu_inbox tests.test_doctor tests.test_handoff_package_portability tests.test_s_command_installer -q",
    "generated-docs-validation": "py -3 -X utf8 scripts/check_docs.py",
    "node-ui-gates": "node --experimental-vm-modules --test tests/*.test.mjs",
    "secret-diff-scan": "py -3 -X utf8 -m unittest tests.test_model_secrets tests.test_evidence_redaction tests.test_repository_hygiene -q",
    "strict-python-full-suite": "py -3 -X utf8 -W error::ResourceWarning -m unittest discover -s tests -q",
    "v2-release-validator": "py -3 -X utf8 -m unittest tests.test_v2_release_evidence -q",
}
LOCAL_COUNTS = {
    "plan11-task1-8-focused": 244,
    "generated-docs-validation": 1,
    "node-ui-gates": 83,
    "secret-diff-scan": 11,
    "strict-python-full-suite": 3124,
    "v2-release-validator": 28,
}


def candidate() -> dict:
    value = {
        "schema_version": 1,
        "kind": "xiaoshe-v2-release-candidate",
        "candidate_id": "v2-candidate-2026-08-16",
        "release_version": "2.0.0-candidate.1",
        "functional_head": HEAD_A,
        "generated_at": "2026-08-16T12:00:00Z",
        "repository": {
            "dirty": False,
            "status_sha256": SHA_A,
            "patch_sha256": SHA_B,
        },
        "artifacts": [
            {"id": "runtime-benchmark", "sha256": SHA_A},
            {"id": "windows-launcher", "sha256": SHA_B},
        ],
        "local_gates": [
            {"id": gate_id, "command": command, "status": "passed",
             "count": LOCAL_COUNTS[gate_id], "log_sha256": SHA_A}
            for gate_id, command in LOCAL_COMMANDS.items()
        ],
        "self_hash": "",
    }
    value["self_hash"] = canonical_self_hash(value)
    return value


def observation(status: str = "passed") -> dict:
    artifacts = candidate()["artifacts"]
    required = {
        "observation-14d-30tasks": {"days": 14, "tasks": 30},
        "exact-binary-soak": {"hours": 72, "unknown_replays": 0},
        "fault-injection": {"count": 50},
        "git-recovery": {"count": 20},
        "windows-10-lifecycle": {"count": 1},
        "clean-windows-lifecycle": {"count": 1},
        "real-user-b0-b2": {"count": 3},
        "independent-security-review": {"count": 1},
        "independent-privacy-review": {"count": 1},
        "staging-rollback-drill": {"count": 1},
        "native-zoom-125-150": {"count": 2},
        "real-phone-pwa": {"count": 1},
        "feishu-sandbox": {"count": 1},
    }
    records = []
    for gate_id, metrics in required.items():
        if status == "not_run":
            metrics = {key: 0 for key in metrics}
            source_hash = log_hash = EMPTY_SHA
            started_at = ended_at = None
        else:
            source_hash, log_hash = SHA_A, SHA_B
            started_at = "2026-08-16T12:00:00Z"
            if gate_id == "observation-14d-30tasks":
                ended_at = "2026-08-30T12:00:00Z"
            elif gate_id == "exact-binary-soak":
                ended_at = "2026-08-19T12:00:00Z"
            else:
                ended_at = "2026-08-16T13:00:00Z"
        records.append({
            "id": gate_id,
            "status": status,
            "functional_head": HEAD_A,
            "artifacts": copy.deepcopy(artifacts),
            "source_sha256": source_hash,
            "log_sha256": log_hash,
            "started_at": started_at,
            "ended_at": ended_at,
            "metrics": metrics,
        })
    value = {
        "schema_version": 1,
        "kind": "xiaoshe-v2-release-observation",
        "candidate_id": "v2-candidate-2026-08-16",
        "release_version": "2.0.0-candidate.1",
        "functional_head": HEAD_A,
        "candidate_hash": candidate()["self_hash"],
        "generated_at": "2026-08-31T12:30:00Z",
        "records": records,
        "requested_action": "release",
        "self_hash": "",
    }
    value["self_hash"] = canonical_self_hash(value)
    return value


def governance(cand: dict, obs: dict, action: str = "release",
               blockers: list[str] | None = None) -> dict:
    value = {
        "schema_version": 2,
        "kind": "xiaoshe-v2-release-governance-status",
        "candidate_id": cand["candidate_id"],
        "functional_head": cand["functional_head"],
        "candidate_hash": cand["self_hash"],
        "observation_hash": obs["self_hash"],
        "action": action,
        "blockers_hash": canonical_hash(blockers or []),
        "self_hash": "",
    }
    value["self_hash"] = canonical_self_hash(value)
    return value


class V2ReleaseEvidenceTests(unittest.TestCase):
    def validate(self, cand: dict | None = None, obs: dict | None = None,
                 *, actual_head: str = HEAD_A, dirty: bool = False,
                 status_hash: str = SHA_A, patch_hash: str = SHA_B):
        return validate_release_evidence(
            cand or candidate(), obs or observation(), actual_head=actual_head,
            actual_dirty=dirty, actual_status_sha256=status_hash,
            actual_patch_sha256=patch_hash,
            actual_artifact_hashes={"runtime-benchmark": SHA_A, "windows-launcher": SHA_B},
        )

    def mutate_and_rehash(self, value: dict, fn) -> dict:
        result = copy.deepcopy(value)
        fn(result)
        result["self_hash"] = canonical_self_hash(result)
        return result

    def test_all_bound_passed_gates_can_release(self):
        report = self.validate()
        self.assertTrue(report["structural_pass"])
        self.assertEqual("release", report["action"])
        self.assertEqual([], report["blockers"])

    def test_template_and_unknown_fields_fail_closed(self):
        cand = self.mutate_and_rehash(candidate(), lambda x: x.update({"extra": "x"}))
        cand["candidate_id"] = "REPLACE_ME"
        cand["self_hash"] = canonical_self_hash(cand)
        report = self.validate(cand=cand)
        self.assertEqual("hold", report["action"])
        self.assertIn("candidate.schema", report["blockers"])
        self.assertIn("candidate.template", report["blockers"])

    def test_self_hash_and_candidate_binding_are_verified(self):
        cand = candidate()
        cand["release_version"] = "tampered"
        obs = self.mutate_and_rehash(observation(), lambda x: x.update({"candidate_hash": SHA_B}))
        report = self.validate(cand=cand, obs=obs)
        self.assertIn("candidate.self_hash", report["blockers"])
        self.assertIn("observation.candidate_hash", report["blockers"])

    def test_stale_head_and_repository_snapshot_mismatch_hold(self):
        report = self.validate(actual_head="b" * 40, dirty=True,
                               status_hash=SHA_B, patch_hash=SHA_A)
        for blocker in ("candidate.functional_head", "repository.dirty",
                        "repository.status_sha256", "repository.patch_sha256"):
            self.assertIn(blocker, report["blockers"])

    def test_local_gate_count_and_log_hash_are_strict(self):
        def mutate(x):
            x["local_gates"][0]["count"] = -1
            x["local_gates"][0]["log_sha256"] = "sha256:bad"
        report = self.validate(cand=self.mutate_and_rehash(candidate(), mutate))
        self.assertIn("candidate.local_gates", report["blockers"])

    def test_candidate_artifacts_are_checked_against_allowlisted_files(self):
        report = validate_release_evidence(
            candidate(), observation(), actual_head=HEAD_A, actual_dirty=False,
            actual_status_sha256=SHA_A, actual_patch_sha256=SHA_B,
            actual_artifact_hashes={"runtime-benchmark": SHA_B, "windows-launcher": SHA_B},
        )
        self.assertIn("candidate.artifact_hashes", report["blockers"])

    def test_artifacts_and_local_gate_ids_are_exact_not_subsets(self):
        cand = candidate()
        cand["artifacts"] = cand["artifacts"][:1]
        cand["local_gates"] = cand["local_gates"][:-1]
        cand["self_hash"] = canonical_self_hash(cand)
        report = self.validate(cand=cand)
        self.assertIn("candidate.artifacts", report["blockers"])
        self.assertIn("candidate.local_gates", report["blockers"])

    def test_local_gate_command_bool_count_and_empty_passed_log_fail(self):
        cand = candidate()
        cand["local_gates"][0]["command"] = "different command"
        cand["local_gates"][1]["count"] = True
        cand["local_gates"][2]["log_sha256"] = EMPTY_SHA
        cand["self_hash"] = canonical_self_hash(cand)
        self.assertIn("candidate.local_gates", self.validate(cand=cand)["blockers"])

    def test_required_local_gate_counts_cannot_be_zero_or_substituted(self):
        cand = candidate()
        cand["local_gates"][0]["count"] = 0
        cand["local_gates"][4]["count"] = 999
        cand["self_hash"] = canonical_self_hash(cand)
        self.assertIn("candidate.local_gates", self.validate(cand=cand)["blockers"])

    def test_thresholds_and_unknown_replay_fail_closed(self):
        obs = observation()
        obs["records"][0]["metrics"] = {"days": 13, "tasks": 29}
        obs["records"][1]["metrics"] = {"hours": 71, "unknown_replays": 1}
        obs["records"][2]["metrics"] = {"count": 49}
        obs["records"][3]["metrics"] = {"count": 19}
        obs["self_hash"] = canonical_self_hash(obs)
        report = self.validate(obs=obs)
        self.assertIn("gate.observation-14d-30tasks.threshold", report["blockers"])
        self.assertIn("gate.exact-binary-soak.threshold", report["blockers"])
        self.assertIn("gate.fault-injection.threshold", report["blockers"])
        self.assertIn("gate.git-recovery.threshold", report["blockers"])

    def test_rfc3339_order_and_real_elapsed_are_enforced(self):
        obs = observation()
        obs["generated_at"] = "2026-08-15T00:00:00Z"
        obs["records"][0]["ended_at"] = "2026-08-20T12:00:00Z"
        obs["records"][1]["started_at"] = "not-a-time"
        obs["self_hash"] = canonical_self_hash(obs)
        report = self.validate(obs=obs)
        self.assertIn("observation.generated_at", report["blockers"])
        self.assertIn("gate.observation-14d-30tasks.elapsed", report["blockers"])
        self.assertIn("gate.exact-binary-soak.time", report["blockers"])

    def test_observation_cannot_predate_the_functional_candidate(self):
        obs = observation()
        obs["records"][0]["started_at"] = "2026-08-01T00:00:00Z"
        obs["records"][1]["started_at"] = "2026-08-01T00:00:00Z"
        obs["self_hash"] = canonical_self_hash(obs)
        report = self.validate(obs=obs)
        self.assertIn("gate.observation-14d-30tasks.time", report["blockers"])
        self.assertIn("gate.exact-binary-soak.time", report["blockers"])

    def test_not_run_and_partial_status_rules_reject_false_evidence(self):
        obs = observation("not_run")
        obs["records"][0]["metrics"]["days"] = 1
        obs["records"][1]["started_at"] = "2026-08-16T12:00:00Z"
        obs["records"][2]["status"] = "partial"
        obs["self_hash"] = canonical_self_hash(obs)
        report = self.validate(obs=obs)
        self.assertIn("gate.observation-14d-30tasks.not_run_shape", report["blockers"])
        self.assertIn("gate.exact-binary-soak.not_run_shape", report["blockers"])
        self.assertIn("gate.fault-injection.partial_shape", report["blockers"])

    def test_passed_records_reject_empty_source_or_log_digest(self):
        obs = observation()
        obs["records"][0]["source_sha256"] = EMPTY_SHA
        obs["records"][1]["log_sha256"] = EMPTY_SHA
        obs["self_hash"] = canonical_self_hash(obs)
        report = self.validate(obs=obs)
        self.assertIn("gate.observation-14d-30tasks.hash", report["blockers"])
        self.assertIn("gate.exact-binary-soak.hash", report["blockers"])

    def test_missing_security_privacy_install_user_and_rollback_gates_hold(self):
        missing = {"windows-10-lifecycle", "real-user-b0-b2",
                   "independent-security-review", "independent-privacy-review",
                   "staging-rollback-drill"}
        obs = observation()
        obs["records"] = [r for r in obs["records"] if r["id"] not in missing]
        obs["self_hash"] = canonical_self_hash(obs)
        report = self.validate(obs=obs)
        for gate_id in missing:
            self.assertIn(f"gate.{gate_id}.missing", report["blockers"])

    def test_duplicate_records_and_artifacts_are_rejected(self):
        obs = observation()
        obs["records"].append(copy.deepcopy(obs["records"][0]))
        obs["records"][1]["artifacts"].append(copy.deepcopy(obs["records"][1]["artifacts"][0]))
        obs["self_hash"] = canonical_self_hash(obs)
        report = self.validate(obs=obs)
        self.assertIn("observation.records.duplicate", report["blockers"])
        self.assertIn("observation.records.artifacts", report["blockers"])

    def test_record_head_artifact_and_source_hashes_must_bind(self):
        obs = observation()
        obs["records"][0]["functional_head"] = "b" * 40
        obs["records"][1]["artifacts"][0]["sha256"] = SHA_B
        obs["records"][2]["source_sha256"] = "sha256:bad"
        obs["self_hash"] = canonical_self_hash(obs)
        report = self.validate(obs=obs)
        self.assertIn("gate.observation-14d-30tasks.binding", report["blockers"])
        self.assertIn("gate.exact-binary-soak.artifacts", report["blockers"])
        self.assertIn("gate.fault-injection.hash", report["blockers"])

    def test_not_run_and_partial_are_valid_but_force_hold(self):
        obs = observation("not_run")
        obs["requested_action"] = "hold"
        obs["self_hash"] = canonical_self_hash(obs)
        report = self.validate(obs=obs)
        self.assertTrue(report["structural_pass"])
        self.assertEqual("hold", report["action"])
        self.assertIn("gate.observation-14d-30tasks.not_run", report["blockers"])

    def test_requested_release_is_never_trusted_when_a_gate_is_not_passed(self):
        obs = observation()
        obs["records"][0]["status"] = "partial"
        obs["self_hash"] = canonical_self_hash(obs)
        self.assertEqual("hold", self.validate(obs=obs)["action"])

    def test_explicit_requested_hold_is_never_promoted_to_release(self):
        obs = observation()
        obs["requested_action"] = "hold"
        obs["self_hash"] = canonical_self_hash(obs)
        report = self.validate(obs=obs)
        self.assertEqual("hold", report["action"])
        self.assertIn("observation.requested_hold", report["blockers"])

    def test_cli_document_loader_rejects_noncanonical_path_before_reading(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "outside.json"
            with mock.patch.object(Path, "read_text", side_effect=AssertionError("must not read")):
                with self.assertRaises(ValidationFailure):
                    load_expected_document(outside, root, Path("docs/evidence/v2-release/candidate.json"))

    def test_repository_snapshot_rejects_subdirectory_as_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            child = root / "child"
            child.mkdir()
            with self.assertRaises(ValidationFailure):
                repository_snapshot(child, HEAD_A)

    def test_artifact_hashing_rejects_reparse_before_read(self):
        with mock.patch("scripts.validate_v2_release._path_has_reparse", return_value=True):
            with self.assertRaises(ValidationFailure):
                hash_allowed_artifacts(Path("."), {"runtime-benchmark": SHA_A,
                                                    "windows-launcher": SHA_B})

    def test_governance_status_binds_both_documents_and_decision(self):
        cand, obs = candidate(), observation()
        base = self.validate(cand=cand, obs=obs)
        valid = governance(cand, obs, "release", base["blockers"])
        self.assertEqual([], validate_governance_status(valid, cand, obs, base))
        invalid = copy.deepcopy(valid)
        invalid["observation_hash"] = SHA_A
        invalid["action"] = "hold"
        invalid["self_hash"] = canonical_self_hash(invalid)
        blockers = validate_governance_status(invalid, cand, obs, base)
        self.assertIn("governance.observation_hash", blockers)
        self.assertIn("governance.action", blockers)

    def test_non_finite_numbers_are_rejected_before_hashing(self):
        cand = candidate()
        cand["local_gates"][0]["count"] = math.nan
        cand["self_hash"] = "sha256:" + "0" * 64
        report = self.validate(cand=cand)
        self.assertIn("candidate.non_finite", report["blockers"])

    def test_secret_content_and_absolute_paths_are_rejected(self):
        obs = observation()
        obs["records"][0]["note"] = "sk-live-secret"
        obs["records"][1]["source_ref"] = "C:\\Users\\person\\SecretStore\\raw.log"
        obs["self_hash"] = canonical_self_hash(obs)
        report = self.validate(obs=obs)
        self.assertIn("observation.records.schema", report["blockers"])
        self.assertIn("evidence.sensitive", report["blockers"])

    def test_json_loader_rejects_duplicate_keys_and_nan(self):
        with self.assertRaises(ValidationFailure):
            ValidationFailure.load_json('{"a":1,"a":2}')
        with self.assertRaises(ValidationFailure):
            ValidationFailure.load_json('{"a":NaN}')

    def test_non_object_top_levels_return_structured_hold_without_traceback(self):
        for invalid in ([], None, 3, "text"):
            for cand, obs, expected in (
                    (invalid, {}, "candidate.schema"),
                    ({}, invalid, "observation.schema")):
                report = validate_release_evidence(
                    cand, obs, actual_head=HEAD_A, actual_dirty=False,
                    actual_status_sha256=SHA_A, actual_patch_sha256=SHA_B,
                    actual_artifact_hashes={"runtime-benchmark": SHA_A,
                                            "windows-launcher": SHA_B},
                )
                self.assertFalse(report["structural_pass"])
                self.assertEqual("hold", report["action"])
                self.assertIn(expected, report["blockers"])

            for documents in ((invalid, {}, {}), ({}, invalid, {}), ({}, {}, invalid)):
                output = io.StringIO()
                with mock.patch("scripts.validate_v2_release._validate_repo_root", return_value=Path(".")), \
                        mock.patch("scripts.validate_v2_release.load_expected_document",
                                   side_effect=documents), redirect_stdout(output):
                    code = main(["--candidate", "docs/evidence/v2-release/candidate.json",
                                 "--observation",
                                 "docs/evidence/v2-release/observation-summary.json"])
                self.assertEqual(1, code)
                report = json.loads(output.getvalue())
                self.assertFalse(report["structural_pass"])
                self.assertEqual("hold", report["action"])
                self.assertEqual(["input.invalid:ValidationFailure"], report["blockers"])
                self.assertNotIn("Traceback", output.getvalue())
                self.assertNotRegex(output.getvalue(), r"[A-Za-z]:[/\\]")


if __name__ == "__main__":
    unittest.main()
