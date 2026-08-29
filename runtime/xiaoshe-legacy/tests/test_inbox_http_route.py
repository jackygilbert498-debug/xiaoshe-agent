import os
import unittest
from pathlib import Path

from tests.ui_server.test_server import ServerCase
from harness import ui_server
from harness.task_api import TaskAPI
from harness.task_store import TaskStore


class InboxHTTPRouteTests(ServerCase):
    def setUp(self):
        self.previous = os.environ.get("XIAOSHE_TASKING_V2")
        os.environ["XIAOSHE_TASKING_V2"] = "on"
        super().setUp()
        self.workspace = Path(self._tmp.name) / "workspace"
        self.workspace.mkdir()

    def tearDown(self):
        super().tearDown()
        if self.previous is None:
            os.environ.pop("XIAOSHE_TASKING_V2", None)
        else:
            os.environ["XIAOSHE_TASKING_V2"] = self.previous

    def project(self):
        status, _, body, _ = self.http("POST", "/api/v2/projects", body={"name": "inbox", "root": str(self.workspace)})
        self.assertEqual(201, status)
        return body["project"]

    def test_route_is_origin_bound_durable_and_idempotent(self):
        project = self.project()
        payload = {"client_id": "client-12345678", "project_id": project["id"],
                   "title": "offline", "goal": "persist only", "acceptance": []}
        api = self.sess.task_api
        headers = {"Host": "127.0.0.1:8765", "Origin": "http://127.0.0.1:8765", "Sec-Fetch-Site": "same-origin"}
        self.assertEqual(403, api.dispatch("POST", "/api/v2/inbox/intents", payload, headers).status)
        self.assertEqual(403, api.dispatch("POST", "/api/v2/inbox/intents", payload,
                         dict(headers, Origin="http://evil.test"), trusted_actor="ui:session").status)
        first = api.dispatch("POST", "/api/v2/inbox/intents", payload, headers, trusted_actor="ui:session")
        second = api.dispatch("POST", "/api/v2/inbox/intents", payload, headers, trusted_actor="ui:session")
        self.assertEqual((201, 200), (first.status, second.status))
        self.assertEqual(first.body["receipt"]["receipt_id"], second.body["receipt"]["receipt_id"])
        self.assertEqual([], api.store.list_tasks({"project_id": project["id"]}))
        self.assertEqual(409, api.dispatch("POST", "/api/v2/inbox/intents", dict(payload, goal="changed"),
                                         headers, trusted_actor="ui:session").status)

    def test_route_works_through_real_authenticated_http_boundary(self):
        project = self.project()
        status, _, body, _ = self.http("POST", "/api/v2/inbox/intents",
            headers={"Origin": f"http://127.0.0.1:{self.port}", "Sec-Fetch-Site": "same-origin"},
            body={"client_id": "client-http-1234", "project_id": project["id"],
                  "title": "offline", "goal": "durable receipt", "acceptance": []})
        self.assertEqual(201, status)
        self.assertEqual("accepted", body["receipt"]["status"])

    def test_installation_principal_and_receipt_survive_session_and_process_restart(self):
        first_principal = ui_server.installation_principal(self.state_dir)
        second_principal = ui_server.installation_principal(self.state_dir)
        self.assertEqual(first_principal, second_principal)
        store = TaskStore(self.state_dir / "restart.db")
        project = store.create_project("restart", self.workspace)
        payload = {"client_id": "client-restart-1", "project_id": project["id"],
                   "title": "retry", "goal": "same receipt", "acceptance": []}
        headers = {"Host": "127.0.0.1:8765", "Origin": "http://127.0.0.1:8765", "Sec-Fetch-Site": "same-origin"}
        first = TaskAPI(store).dispatch("POST", "/api/v2/inbox/intents", payload, headers,
                                        trusted_actor=first_principal)
        restarted = TaskAPI(TaskStore(store.db_path)).dispatch("POST", "/api/v2/inbox/intents", payload, headers,
                                                                trusted_actor=second_principal)
        isolated = TaskAPI(TaskStore(store.db_path)).dispatch("POST", "/api/v2/inbox/intents", payload, headers,
                                                              trusted_actor="installation_device_other123")
        self.assertEqual(first.body["receipt"]["receipt_id"], restarted.body["receipt"]["receipt_id"])
        self.assertTrue(restarted.body["receipt"]["duplicate"])
        self.assertNotEqual(first.body["receipt"]["receipt_id"], isolated.body["receipt"]["receipt_id"])
        self.assertEqual(2, __import__("harness.task_inbox", fromlist=["TaskInbox"]).TaskInbox(store).pending_intent_count())


if __name__ == "__main__":
    unittest.main()
