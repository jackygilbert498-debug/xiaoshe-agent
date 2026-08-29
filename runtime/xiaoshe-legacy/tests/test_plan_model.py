import json
from pathlib import Path
import unittest

from harness.plan_model import PLAN_SCHEMA_VERSION, PlanValidationError, normalize_plan, plan_checksum, validate_plan


def fixture_plan():
    path = Path(__file__).parent / "fixtures" / "tasking" / "plan_v1.json"
    return json.loads(path.read_text(encoding="utf-8"))


class PlanModelTests(unittest.TestCase):
    def test_fixture_is_the_stable_v1_contract(self):
        plan = normalize_plan(fixture_plan())
        self.assertEqual(PLAN_SCHEMA_VERSION, plan["schema_version"])
        self.assertEqual("sha256:156fd675b176d9bcb044c028ec1c4c12f49b4a73350736b3b40a9ece5cbfe972", plan_checksum(plan))

    def test_checksum_ignores_mapping_order_but_not_step_order(self):
        first = fixture_plan()
        second = json.loads(json.dumps(first))
        second["estimated_budget"] = dict(reversed(list(second["estimated_budget"].items())))
        self.assertEqual(plan_checksum(first), plan_checksum(second))
        second["steps"] = list(reversed(second["steps"]))
        self.assertNotEqual(plan_checksum(first), plan_checksum(second))

    def test_rejects_cycle_and_unmapped_acceptance(self):
        body = fixture_plan()
        body["steps"][0]["depends_on"] = [body["steps"][-1]["id"]]
        body["acceptance_mapping"].pop("回归测试通过")
        errors = validate_plan(body, acceptance_ids=("解析器返回明确错误", "回归测试通过"))
        self.assertEqual({"PLAN_DEPENDENCY_CYCLE", "PLAN_ACCEPTANCE_UNMAPPED"}, {error.code for error in errors})

    def test_rejects_reviewable_plan_without_confirmed_acceptance(self):
        errors = validate_plan(fixture_plan(), acceptance_ids=())
        self.assertIn("PLAN_ACCEPTANCE_REQUIRED", {error.code for error in errors})

    def test_rejects_unsafe_file_scope_and_bounded_large_input(self):
        body = fixture_plan()
        body["steps"][0]["files"] = ["../secrets.txt"]
        error = validate_plan(body, acceptance_ids=("解析器返回明确错误",))[0]
        self.assertEqual(("PLAN_PATH_ESCAPE", "/steps/0/files/0"), (error.code, error.path))
        body = fixture_plan()
        body["steps"] *= 101
        error = validate_plan(body, acceptance_ids=("解析器返回明确错误",))[0]
        self.assertEqual("PLAN_LIMIT_EXCEEDED", error.code)

    def test_validation_error_is_json_pointer_serializable(self):
        error = PlanValidationError("PLAN_FIELD_TYPE", "/steps/0/title", "必须是文本")
        self.assertEqual({"code": "PLAN_FIELD_TYPE", "path": "/steps/0/title", "message": "必须是文本"}, error.as_dict())


if __name__ == "__main__":
    unittest.main()
