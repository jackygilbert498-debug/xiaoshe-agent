from dataclasses import FrozenInstanceError
import unittest

from harness import ui_schema
from harness.task_model import (
    CreateTask,
    RunContext,
    RunStatus,
    TaskStatus,
    TaskingError,
    UpdateTaskDefinition,
)


class TaskModelTests(unittest.TestCase):
    def test_task_status_is_the_approved_closed_set(self):
        expected = [
            "Draft", "Planning", "AwaitingPlanApproval", "Ready", "Running",
            "WaitingUser", "Review", "Verifying", "Succeeded", "Failed",
            "Cancelled", "Archived",
        ]
        self.assertEqual(expected, [item.value for item in TaskStatus])
        self.assertEqual(expected, ui_schema.ENUMS["TASK_STATUS"])

    def test_create_task_normalizes_acceptance_without_deduplicating(self):
        with self.assertRaisesRegex(ValueError, "goal"):
            CreateTask(project_id="prj_1", title="x", goal="  ", acceptance=())
        draft = CreateTask(
            project_id="prj_1", title="  修复解析器  ", goal="理解当前问题 ",
            acceptance=("  单元测试通过 ", "单元测试通过"),
        )
        self.assertEqual(draft.title, "修复解析器")
        self.assertEqual(draft.acceptance, ("单元测试通过", "单元测试通过"))

    def test_command_ids_versions_and_run_context_are_checked(self):
        with self.assertRaisesRegex(ValueError, "task_id"):
            UpdateTaskDefinition("bad", 1, "req_1")
        with self.assertRaisesRegex(ValueError, "expected_version"):
            UpdateTaskDefinition("tsk_1", -1, "req_1")
        ctx = RunContext("tsk_1", "run_1", None, "ws_1", {}, lambda *_: None)
        with self.assertRaises(FrozenInstanceError):
            ctx.run_id = "run_2"
        self.assertEqual(RunStatus.RUNNING.value, "Running")

    def test_tasking_error_has_safe_serializable_shape(self):
        error = TaskingError("TASK_VERSION_CONFLICT", "任务已被更新", {"current_version": 2})
        self.assertEqual(error.as_dict(), {
            "code": "TASK_VERSION_CONFLICT", "message": "任务已被更新",
            "details": {"current_version": 2},
        })


if __name__ == "__main__":
    unittest.main()
