"""真实 localhost 服务上的 Task v2 契约：路由、版本冲突与事件补拉。"""
from __future__ import annotations

import os
import json
import queue
from concurrent.futures import ThreadPoolExecutor
import unittest
from pathlib import Path

from harness import ui_bus
from tests.ui_server.test_server import ServerCase


def plan_fixture():
    return json.loads((Path(__file__).parent / "fixtures" / "tasking" / "plan_v1.json").read_text(encoding="utf-8"))


class TaskApiTests(ServerCase):
    def setUp(self):
        self._previous = os.environ.get("XIAOSHE_TASKING_V2")
        os.environ["XIAOSHE_TASKING_V2"] = "on"
        super().setUp()
        self.workspace = Path(self._tmp.name) / "workspace"
        self.workspace.mkdir()

    def tearDown(self):
        super().tearDown()
        if self._previous is None:
            os.environ.pop("XIAOSHE_TASKING_V2", None)
        else:
            os.environ["XIAOSHE_TASKING_V2"] = self._previous

    def project(self):
        st, _, body, _ = self.http("POST", "/api/v2/projects", body={
            "name": "任务项目", "root": str(self.workspace),
        })
        self.assertEqual(201, st)
        return body["project"]

    def task(self):
        project = self.project()
        st, headers, body, _ = self.http("POST", "/api/v2/tasks", body={
            "project_id": project["id"], "title": "修复解析器", "goal": "修复解析器", "acceptance": ["单测通过"],
        })
        self.assertEqual(201, st)
        self.assertIn("ETag", headers)
        return body["task"]

    def test_stale_write_returns_current_version_and_no_extra_event(self):
        task = self.task()
        st, _, body, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/transition", body={
            "to": "Planning", "expected_version": task["version"], "actor": "user",
        })
        self.assertEqual(200, st)
        before = len(self.sess.task_api.store.list_events(task["id"]))
        st, _, body, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/transition", body={
            "to": "Cancelled", "expected_version": task["version"], "actor": "user",
        })
        self.assertEqual(409, st)
        self.assertEqual("TASK_VERSION_CONFLICT", body["error"]["code"])
        self.assertEqual(1, body["error"]["details"]["current_version"])
        self.assertEqual(before, len(self.sess.task_api.store.list_events(task["id"])))

    def test_plan_proposal_and_review_use_task_engine(self):
        task = self.task()
        body = plan_fixture()
        body["acceptance_mapping"] = {"单测通过": ["implement"]}
        st, _, proposed, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/plans", body={
            "body": body, "actor": "agent", "expected_version": task["version"],
        })
        self.assertEqual(201, st)
        self.assertEqual("AwaitingPlanApproval", proposed["task"]["status"])
        st, _, reviewed, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/plans/1/review", body={
            "decision": "approve", "feedback": "可以", "actor": "user", "expected_version": proposed["task"]["version"],
        })
        self.assertEqual(200, st)
        self.assertEqual("approved", reviewed["plan"]["status"])
        self.assertEqual("Ready", reviewed["task"]["status"])

    def test_invalid_plan_returns_422_field_errors(self):
        task = self.task()
        st, _, response, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/plans", body={
            "body": {"steps": []}, "actor": "agent", "expected_version": task["version"],
        })
        self.assertEqual(422, st)
        self.assertEqual("TASK_PLAN_INVALID", response["error"]["code"])
        self.assertEqual("/steps", response["error"]["details"]["fields"][0]["path"])

    def test_structured_question_answers_and_resumes_same_run(self):
        task = self.task()
        st, _, ready, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/transition", body={
            "to": "Ready", "expected_version": task["version"], "actor": "user",
        })
        self.assertEqual(200, st)
        st, _, started, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/runs", body={
            "expected_version": ready["task"]["version"], "actor": "agent",
        })
        self.assertEqual(201, st)
        st, _, asked, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/runs/{started['run']['id']}/questions", body={
            "prompt": "保留本地改动吗？", "choices": ["保留", "覆盖"], "allow_free_text": False,
            "reason_code": "FILE_CONFLICT", "actor": "agent",
        })
        self.assertEqual(201, st)
        self.assertEqual("WaitingUser", asked["task"]["status"])
        st, _, answered, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/questions/{asked['question']['id']}/answer", body={
            "answer": "保留", "actor": "user", "expected_version": asked["task"]["version"],
        })
        self.assertEqual(200, st)
        self.assertEqual("Running", answered["task"]["status"])
        self.assertEqual(started["run"]["id"], answered["task"]["active_run_id"])

    def test_stop_and_steer_are_queued_run_controls_not_task_statuses(self):
        task = self.task()
        st, _, ready, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/transition", body={
            "to": "Ready", "expected_version": task["version"], "actor": "user",
        })
        st, _, started, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/runs", body={
            "expected_version": ready["task"]["version"], "actor": "agent",
        })
        st, _, steered, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/runs/{started['run']['id']}/steer", body={
            "text": "先运行测试", "actor": "user", "expected_version": started["task"]["version"],
        })
        self.assertEqual(202, st)
        self.assertEqual(1, steered["queued_input_count"])
        self.assertEqual("Running", steered["task"]["status"])
        st, _, stopped, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/runs/{started['run']['id']}/stop", body={
            "actor": "user", "expected_version": started["task"]["version"],
        })
        self.assertEqual(202, st)
        self.assertTrue(stopped["stop_requested"])
        self.assertEqual("Running", stopped["task"]["status"])

    def test_detail_events_after_seq_and_inbox_are_state_based(self):
        task = self.task()
        self.http("POST", f"/api/v2/tasks/{task['id']}/transition", body={
            "to": "Planning", "expected_version": task["version"], "actor": "user",
        })
        st, _, body, _ = self.get(f"/api/v2/tasks/{task['id']}?events_after=1")
        self.assertEqual(200, st)
        self.assertEqual([2], [event["seq"] for event in body["events"]])
        self.assertEqual("task.transitioned", body["events"][0]["type"])
        self.assertEqual(2, body["task"]["last_seq"])
        st, _, inbox, _ = self.get("/api/v2/inbox")
        self.assertEqual(200, st)
        self.assertEqual(task["id"], inbox["groups"]["Planning"][0]["id"])
        self.assertEqual(2, inbox["groups"]["Planning"][0]["last_seq"])

    def test_patch_accepts_if_match_and_publishes_committed_event(self):
        task = self.task()
        before = ui_bus.current_seq()
        st, headers, body, _ = self.http("PATCH", f"/api/v2/tasks/{task['id']}", headers={
            "If-Match": f'W/"{task["id"]}:{task["version"]}"',
        }, body={"request_id": "req_patch_1", "acceptance": ["离线测试通过"]})
        self.assertEqual(200, st)
        self.assertEqual(["离线测试通过"], body["task"]["acceptance"])
        self.assertIn("ETag", headers)
        self.assertGreater(ui_bus.current_seq(), before)

    def test_invalid_patch_is_rejected_without_silent_data_loss(self):
        task = self.task()
        before = len(self.sess.task_api.store.list_events(task["id"]))
        st, _, body, _ = self.http("PATCH", f"/api/v2/tasks/{task['id']}", body={
            "request_id": "req_patch_bad", "expected_version": task["version"], "acceptance": "不是数组",
        })
        self.assertEqual(400, st)
        self.assertEqual("TASK_BAD_REQUEST", body["error"]["code"])
        self.assertEqual(before, len(self.sess.task_api.store.list_events(task["id"])))

    def test_events_after_must_be_nonnegative(self):
        task = self.task()
        st, _, body, _ = self.get(f"/api/v2/tasks/{task['id']}?events_after=-1")
        self.assertEqual(400, st)
        self.assertEqual("TASK_BAD_REQUEST", body["error"]["code"])

    def test_session_preview_and_import_are_idempotent(self):
        project = self.project()
        sessions = self.state_dir / "sessions"; sessions.mkdir()
        source = sessions / "legacy_1.json"
        source.write_text(json.dumps({"history": [{"role": "user", "content": "  修复   旧会话  "}], "todos": []}, ensure_ascii=False), encoding="utf-8")
        before = source.read_bytes()
        st, _, body, _ = self.get("/api/v2/sessions/legacy_1/task-preview")
        self.assertEqual(200, st)
        self.assertEqual("修复 旧会话", body["preview"]["goal"])
        st, _, first, _ = self.http("POST", "/api/v2/sessions/legacy_1/import-task", body={"project_id": project["id"]})
        self.assertEqual(201, st)
        st, _, second, _ = self.http("POST", "/api/v2/sessions/legacy_1/import-task", body={"project_id": project["id"]})
        self.assertEqual(200, st)
        self.assertEqual(first["task"]["id"], second["task"]["id"])
        self.assertEqual(before, source.read_bytes())

    def test_rest_event_and_websocket_event_use_same_task_serializer(self):
        task = self.task()
        subscriber = ui_bus.subscribe()
        try:
            st, _, _, _ = self.http("POST", f"/api/v2/tasks/{task['id']}/transition", body={
                "to": "Planning", "expected_version": task["version"], "actor": "user",
            })
            self.assertEqual(200, st)
            envelope = subscriber.get(timeout=1)
            # 若同一写入同时 flush 了 v1 脏状态，取 task.* 那一条即可。
            while envelope["type"] != "task.transitioned":
                envelope = subscriber.get(timeout=1)
            st, _, detail, _ = self.get(f"/api/v2/tasks/{task['id']}?events_after=1")
            self.assertEqual(200, st)
            self.assertEqual(detail["events"][0], envelope["payload"])
        except queue.Empty as exc:
            self.fail(f"未收到 task.transitioned WS 事件: {exc}")
        finally:
            ui_bus.unsubscribe(subscriber)

    def test_concurrent_session_import_broadcasts_only_one_created_event(self):
        project = self.project()
        sessions = self.state_dir / "sessions"; sessions.mkdir()
        (sessions / "parallel.json").write_text(json.dumps({"history": [{"role": "user", "content": "并发 API 导入"}], "todos": []}, ensure_ascii=False), encoding="utf-8")
        subscriber = ui_bus.subscribe()
        try:
            def import_once(_):
                return self.http("POST", "/api/v2/sessions/parallel/import-task", body={"project_id": project["id"]})
            with ThreadPoolExecutor(max_workers=12) as pool:
                responses = list(pool.map(import_once, range(12)))
            self.assertEqual(1, sum(status == 201 for status, _, _, _ in responses))
            self.assertTrue(all(status in {200, 201} for status, _, _, _ in responses))
            events = []
            while True:
                try:
                    events.append(subscriber.get_nowait())
                except queue.Empty:
                    break
            self.assertEqual(1, sum(event["type"] == "task.created" for event in events))
        finally:
            ui_bus.unsubscribe(subscriber)


class TaskingOffTests(ServerCase):
    def test_off_does_not_mount_v2_routes(self):
        st, _, body, _ = self.get("/api/v2/tasks")
        self.assertEqual(404, st)
        self.assertEqual("not_found", body["error"]["code"])


if __name__ == "__main__":
    unittest.main()
