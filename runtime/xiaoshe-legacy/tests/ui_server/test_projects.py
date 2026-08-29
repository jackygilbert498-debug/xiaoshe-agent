"""tests/ui_server/test_projects.py：项目分组（UI 批次 B）——数据层 + REST API + 会话切换。

覆盖：projects.py CRUD/assign/unassign/单一归属/删项目保会话/坏档容错；
/api/projects* 与 /api/sessions* 路由（鉴权沿用、入参校验、删除项目会话回未分组、
POST /api/sessions/new 生成新 sid 并切换 + 旧会话存档、POST /api/sessions/resume）。

运行：python -m unittest tests.ui_server.test_projects -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from harness import projects, session  # noqa: E402
from tests.ui_server.test_server import ServerCase  # noqa: E402


# ---------------------------------------------------------------- 数据层（projects.py）

class TestProjectsStore(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "projects.json"

    def tearDown(self):
        self._tmp.cleanup()

    def test_create_load_roundtrip(self):
        pr = projects.create("我的项目", path=self.path)
        self.assertRegex(pr["id"], r"^proj-[0-9a-f]{8}$")
        self.assertEqual(pr["name"], "我的项目")
        self.assertEqual(pr["session_ids"], [])
        self.assertTrue(pr["created"])
        data = projects.load(path=self.path)
        self.assertEqual(data["projects"], [pr])

    def test_name_validation(self):
        for bad in ("", "   ", "a" * 61, 123, None):
            with self.assertRaises(projects.ProjectError, msg=repr(bad)):
                projects.create(bad, path=self.path)
        pr = projects.create("  多  空白\t名  ", path=self.path)
        self.assertEqual(pr["name"], "多 空白 名")          # 压空白防撕乱侧栏

    def test_rename(self):
        pr = projects.create("旧名", path=self.path)
        out = projects.rename(pr["id"], "新名", path=self.path)
        self.assertEqual(out["name"], "新名")
        self.assertEqual(projects.load(path=self.path)["projects"][0]["name"], "新名")
        self.assertIsNone(projects.rename("proj-00000000", "x", path=self.path))
        with self.assertRaises(projects.ProjectError):
            projects.rename(pr["id"], " ", path=self.path)

    def test_assign_single_membership(self):
        a = projects.create("A", path=self.path)
        b = projects.create("B", path=self.path)
        self.assertTrue(projects.assign(a["id"], "s-1", path=self.path))
        self.assertEqual(projects.project_of("s-1", path=self.path), a["id"])
        self.assertTrue(projects.assign(b["id"], "s-1", path=self.path))   # 单一归属：自动移出 A
        self.assertEqual(projects.project_of("s-1", path=self.path), b["id"])
        self.assertEqual(projects.load(path=self.path)["projects"][0]["session_ids"], [])
        self.assertTrue(projects.assign(b["id"], "s-1", path=self.path))   # 幂等
        self.assertEqual(projects.load(path=self.path)["projects"][1]["session_ids"], ["s-1"])

    def test_assign_validation(self):
        a = projects.create("A", path=self.path)
        self.assertFalse(projects.assign("proj-00000000", "s-1", path=self.path))
        for bad in ("../etc", "a/b", "x" * 65, ""):
            with self.assertRaises(projects.ProjectError, msg=bad):
                projects.assign(a["id"], bad, path=self.path)
        with self.assertRaises(projects.ProjectError):
            projects.assign("not-a-pid", "s-1", path=self.path)

    def test_unassign(self):
        a = projects.create("A", path=self.path)
        projects.assign(a["id"], "s-1", path=self.path)
        self.assertTrue(projects.unassign(a["id"], "s-1", path=self.path))
        self.assertIsNone(projects.project_of("s-1", path=self.path))
        self.assertTrue(projects.unassign(a["id"], "s-1", path=self.path))  # 幂等
        self.assertFalse(projects.unassign("proj-00000000", "s-1", path=self.path))

    def test_remove_session_cleans_all_project_references(self):
        a = projects.create("A", path=self.path)
        projects.assign(a["id"], "s-1", path=self.path)
        projects.remove_session("s-1", path=self.path)
        self.assertIsNone(projects.project_of("s-1", path=self.path))

    def test_delete_keeps_sessions(self):
        a = projects.create("A", path=self.path)
        projects.assign(a["id"], "s-1", path=self.path)
        self.assertTrue(projects.delete(a["id"], path=self.path))
        self.assertEqual(projects.load(path=self.path)["projects"], [])
        self.assertIsNone(projects.project_of("s-1", path=self.path))       # 会话回未分组
        self.assertFalse(projects.delete(a["id"], path=self.path))

    def test_load_tolerates_bad_file(self):
        self.assertEqual(projects.load(path=self.path), {"projects": []})    # 不存在
        self.path.write_text("{不是 json", encoding="utf-8")
        self.assertEqual(projects.load(path=self.path), {"projects": []})
        self.path.write_text(json.dumps({"projects": [
            {"id": "bad pid", "name": "坏id"},
            {"id": "proj-11111111", "name": "  "},
            {"id": "proj-22222222", "name": "好", "session_ids": ["ok-1", "../bad", "ok-1", 5]},
            "garbage",
        ]}), encoding="utf-8")
        data = projects.load(path=self.path)
        self.assertEqual(len(data["projects"]), 1)
        self.assertEqual(data["projects"][0]["session_ids"], ["ok-1"])       # 坏 sid 滤掉 + 去重

    def test_sessions_index_has_saved_at(self):
        tmp = Path(self._tmp.name) / "sessions"
        with mock.patch.object(session, "SESSIONS_DIR", tmp):
            session.save_session("s-a", [{"role": "user", "content": "你好"}], [])
            session.save_session("headless-x", [{"role": "user", "content": "后台"}], [])
            idx = projects.sessions_index(limit=10)
        ids = [s["id"] for s in idx]
        self.assertIn("s-a", ids)
        self.assertNotIn("headless-x", ids)                                  # 无头档案不进列表
        rec = next(s for s in idx if s["id"] == "s-a")
        self.assertEqual(rec["preview"], "你好")
        self.assertTrue(rec["saved_at"])                                     # 日期搜索靠它


# ---------------------------------------------------------------- REST API

class TestProjectsAPI(ServerCase):
    """路由：/api/projects* CRUD + assign/unassign；沿用 token 鉴权与统一错误形状。"""

    def http(self, method, path, **kw):
        body = kw.get("body")
        if isinstance(body, (dict, list)):            # 中文项目名：utf-8 字节（基座 latin-1 默认会炸）
            kw["body"] = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers = dict(kw.get("headers") or {})
            headers.setdefault("Content-Type", "application/json")
            kw["headers"] = headers
        return super().http(method, path, **kw)

    def _projects_path(self):
        return self.state_dir / "projects.json"

    # ---------------- CRUD

    def test_projects_crud_flow(self):
        st, _, body, _ = self.get("/api/projects")
        self.assertEqual((st, body["projects"]), (200, []))

        st, _, body, _ = self.http("POST", "/api/projects", body={"name": "批次B"})
        self.assertEqual(st, 200)
        pr = body["project"]
        self.assertRegex(pr["id"], r"^proj-[0-9a-f]{8}$")
        self.assertEqual(pr["name"], "批次B")

        st, _, body, _ = self.http("POST", "/api/projects/rename",
                                   body={"id": pr["id"], "name": "批次B改"})
        self.assertEqual(st, 200)
        self.assertEqual(body["project"]["name"], "批次B改")

        st, _, body, _ = self.http("POST", "/api/projects/delete", body={"id": pr["id"]})
        self.assertEqual((st, body["ok"]), (200, True))
        st, _, body, _ = self.get("/api/projects")
        self.assertEqual(body["projects"], [])

    def test_projects_auth_and_validation(self):
        st, _, _, _ = self.http("GET", "/api/projects", token=None)
        self.assertEqual(st, 401)                                            # 鉴权面沿用
        st, _, body, _ = self.http("POST", "/api/projects", body={"name": "  "})
        self.assertEqual(st, 400)
        self.assertIn("error", body)
        st, _, body, _ = self.http("POST", "/api/projects", body={"name": "x", "hack": 1})
        self.assertEqual(st, 400)                                            # 未知字段拒（schema 闸）
        st, _, body, _ = self.http("POST", "/api/projects/rename",
                                   body={"id": "proj-00000000", "name": "x"})
        self.assertEqual(st, 404)
        st, _, body, _ = self.http("POST", "/api/projects/delete",
                                   body={"id": "proj-00000000"})
        self.assertEqual(st, 404)
        st, _, body, _ = self.http("POST", "/api/projects/rename",
                                   body={"id": "bad id", "name": "x"})
        self.assertEqual(st, 400)

    # ---------------- assign / unassign

    def test_assign_unassign_flow(self):
        _, _, body, _ = self.http("POST", "/api/projects", body={"name": "P"})
        pid = body["project"]["id"]
        st, _, body, _ = self.http("POST", "/api/projects/assign",
                                   body={"id": pid, "sid": "sess-1"})
        self.assertEqual((st, body["ok"]), (200, True))
        st, _, body, _ = self.get("/api/projects")
        self.assertEqual(body["projects"][0]["session_ids"], ["sess-1"])

        st, _, body, _ = self.http("POST", "/api/projects/unassign",
                                   body={"id": pid, "sid": "sess-1"})
        self.assertEqual((st, body["ok"]), (200, True))
        st, _, body, _ = self.get("/api/projects")
        self.assertEqual(body["projects"][0]["session_ids"], [])

        st, _, body, _ = self.http("POST", "/api/projects/assign",
                                   body={"id": "proj-00000000", "sid": "sess-1"})
        self.assertEqual(st, 404)
        st, _, body, _ = self.http("POST", "/api/projects/assign",
                                   body={"id": pid, "sid": "../穿越"})
        self.assertEqual(st, 400)

    def test_delete_project_keeps_session_membership_semantics(self):
        """删除项目不删会话：归属记录随项目消失，会话档案本身不动。"""
        _, _, body, _ = self.http("POST", "/api/projects", body={"name": "P"})
        pid = body["project"]["id"]
        self.http("POST", "/api/projects/assign", body={"id": pid, "sid": "sess-1"})
        st, _, _, _ = self.http("POST", "/api/projects/delete", body={"id": pid})
        self.assertEqual(st, 200)
        data = projects.load(path=self._projects_path())
        self.assertEqual(data["projects"], [])

    # ---------------- /api/sessions 列表

    def test_sessions_list_endpoint(self):
        tmp = Path(self.state_dir) / "sessions_pool"
        with mock.patch.object(session, "SESSIONS_DIR", tmp):
            session.save_session("s-list-1", [{"role": "user", "content": "第一条"}], [])
            st, _, body, _ = self.get("/api/sessions")
        self.assertEqual(st, 200)
        self.assertEqual(body["current"], self.sid)
        ids = [s["id"] for s in body["sessions"]]
        self.assertIn("s-list-1", ids)
        rec = next(s for s in body["sessions"] if s["id"] == "s-list-1")
        self.assertEqual(set(rec), {"id", "n_messages", "preview", "saved_at"})

    # ---------------- 新会话 / 恢复

    def test_sessions_new_switches_sid_and_archives(self):
        self.history.append({"role": "user", "content": "旧会话内容"})
        tmp_sessions = Path(self.state_dir) / "sessions_pool"
        tmp_logs = Path(self.state_dir) / "logs_pool"
        with mock.patch.object(session, "SESSIONS_DIR", tmp_sessions), \
             mock.patch.object(session, "LOGS_DIR", tmp_logs):
            old_sid = self.sid
            st, _, body, _ = self.http("POST", "/api/sessions/new", body={})
            self.assertEqual(st, 200)
            self.assertTrue(body["switched"])
            new_sid = body["sid"]
            self.assertNotEqual(new_sid, old_sid)
            self.assertEqual(self.sess.sid, new_sid)                        # 服务端真切换
            self.assertEqual(self.sess.ctx["session_id"], new_sid)
            self.assertTrue((tmp_sessions / f"{old_sid}.json").exists())    # 旧会话已存档
            self.assertFalse(any(m.get("role") == "user" for m in self.sess.history))
        st, _, body, _ = self.get("/api/sessions")
        self.assertEqual(body["current"], new_sid)

    def test_sessions_resume_rest(self):
        tmp_sessions = Path(self.state_dir) / "sessions_pool"
        with mock.patch.object(session, "SESSIONS_DIR", tmp_sessions):
            session.save_session("s-old", [{"role": "user", "content": "旧内容"}], [])
            st, _, body, _ = self.http("POST", "/api/sessions/resume", body={"sid": "s-old"})
            self.assertEqual(st, 200)
            self.assertTrue(body["resumed"])
            self.assertIn("旧内容", [m.get("content") for m in self.sess.history])  # 只装内容不动 sid
            self.assertEqual(self.sess.sid, self.sid)
            st, _, body, _ = self.http("POST", "/api/sessions/resume", body={"sid": "no-such"})
            self.assertEqual(st, 200)
            self.assertFalse(body["resumed"])
            self.assertEqual(body["reason"], "unreadable")
            st, _, body, _ = self.http("POST", "/api/sessions/resume", body={"sid": "../bad"})
            self.assertEqual(st, 200)
            self.assertFalse(body["resumed"])                               # 白名单拦（对齐 WS resume）

    def test_sessions_rename_and_recoverable_delete(self):
        tmp_sessions = Path(self.state_dir) / "sessions_pool"
        tmp_trash = Path(self.state_dir) / "trash_pool"
        with mock.patch.object(session, "SESSIONS_DIR", tmp_sessions), \
             mock.patch.object(session, "TRASH_DIR", tmp_trash):
            session.save_session("s-manage", [{"role": "user", "content": "旧预览"}], [])
            st, _, body, _ = self.http("POST", "/api/sessions/rename",
                                       body={"sid": "s-manage", "title": "  新 名称  "})
            self.assertEqual(st, 200)
            self.assertEqual(body["title"], "新 名称")
            self.assertEqual(session.load_session("s-manage")["title"], "新 名称")
            st, _, body, _ = self.http("POST", "/api/sessions/delete", body={"sid": "s-manage"})
            self.assertEqual(st, 200)
            self.assertTrue(body["recoverable"])
            self.assertFalse((tmp_sessions / "s-manage.json").exists())
            self.assertEqual(len(list(tmp_trash.glob("*-s-manage.json"))), 1)

    def test_delete_current_requires_safe_switch(self):
        st, _, body, _ = self.http("POST", "/api/sessions/delete", body={"sid": self.sid})
        self.assertEqual(st, 409)
        self.assertEqual(body["error"]["code"], "current")


if __name__ == "__main__":
    unittest.main()
