"""版本化 Task REST 边界。

这里只做 HTTP 形状、输入解析和稳定错误映射；领域规则仍完全由
``TaskEngine`` 和 ``TaskStore`` 决定，避免 Handler 变成第二个状态机。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from .task_engine import TaskEngine
from .task_model import (AnswerQuestion, AskQuestion, CreateMemoryCandidate, CreateTask, FinishRun, MemoryKind,
                         MemoryStatus, RunStatus, StartRun, TaskStatus, ReviewPlan, TaskingError, UpdateTaskDefinition)
from .task_store import TaskStore
from .session_import import SessionImporter
from .run_control import RunControl
from .artifact_store import ArtifactRef, ArtifactStore
from .change_set import ChangeSetService
from .diff_capture import DiffCapture
from .review_service import ReviewService
from .verification import VerificationService
from .verification_discovery import discover
from .verification_model import normalize_profile, profile_checksum
from .verification_trust import VerificationTrustStore
from .task_checkpoint import CheckpointService, TaskCheckpointError
from .task_recovery import RecoveryError, RecoveryService
from .workspace import WorkspaceService
from .workspace_paths import WorkspacePathPolicy
from .worktree_manager import WorktreeManager, WorktreeError
from .workspace_version import WorkspaceVersionService
from .task_inbox import TaskInbox
from .task_queue import TaskQueue
from .task_model import EnqueueTask
from datetime import UTC, datetime
from .memory_sources import MemorySourceResolver
from .project_memory import ProjectMemoryStore
from .memory_conflicts import MemoryConflictService
from .error_codes import REGISTRY, map_exception
from .diagnostic_bundle import DiagnosticBundle
from .telemetry import TelemetryQueue


@dataclass(frozen=True)
class HTTPResult:
    status: int
    body: dict[str, Any]
    headers: dict[str, str] = field(default_factory=dict)


class TaskAPI:
    def __init__(self, store: TaskStore, engine: TaskEngine | None = None,
                 workspace_root: Path | None = None,
                 event_sink: Callable[[dict[str, Any]], None] | None = None,
                 session_importer: SessionImporter | None = None,
                 run_control: RunControl | None = None,
                 artifact_store: ArtifactStore | None = None,
                 changesets: ChangeSetService | None = None,
                 reviews: ReviewService | None = None):
        self.store = store
        self.engine = engine or TaskEngine(store)
        self.workspace_root = Path(workspace_root or ".").resolve()
        self.event_sink = event_sink
        self.session_importer = session_importer
        self.run_control = run_control or RunControl(store)
        self.artifact_store = artifact_store or ArtifactStore(self.store.db_path.parent / "review-artifacts")
        self.changesets = changesets or ChangeSetService(DiffCapture(self.artifact_store))
        self.reviews = reviews or ReviewService(store=self.store)
        self.engine.changesets = self.changesets
        self.verification = VerificationService(self.store, self.artifact_store)
        self.verification_trust = VerificationTrustStore(self.store)
        self.checkpoints = CheckpointService(self.store, self.artifact_store)
        self.recovery = RecoveryService(self.store, self.checkpoints)
        self.workspace_service = WorkspaceService(self.store)
        self.workspace_paths = WorkspacePathPolicy(self.store.db_path.parent / "task-workspaces")
        self.worktrees = WorktreeManager(self.store, self.workspace_paths)
        self.project_memory = ProjectMemoryStore(self.store)
        self.memory_sources = MemorySourceResolver(self.store)
        self.memory_conflicts = MemoryConflictService(self.store, self.project_memory)
        beta_state = self.store.db_path.parent / "beta-state"
        self.diagnostics = DiagnosticBundle(beta_state / "diagnostics")
        self.telemetry = TelemetryQueue(beta_state / "telemetry-outbox.json")

    @staticmethod
    def _error(status: int, code: str, message: str, hint: str = "", details: dict | None = None) -> HTTPResult:
        # Preserve established domain codes during the migration, while known
        # public codes use their registered status/message/detail allowlist.
        spec = REGISTRY.get(code)
        if spec.code != "INTERNAL_UNEXPECTED" or code == "INTERNAL_UNEXPECTED":
            public = REGISTRY.public(code, details)
            return HTTPResult(spec.http_status, {"error": public})
        error = {"code": code, "message": message, "hint": hint, "retryable": status >= 500}
        if details:
            error["details"] = details
        return HTTPResult(status, {"error": error})

    @staticmethod
    def _body(value: Any) -> dict:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise TaskingError("TASK_BAD_REQUEST", "请求体必须是 JSON 对象")
        return value

    @staticmethod
    def _required_text(body: dict, key: str) -> str:
        value = body.get(key)
        if not isinstance(value, str) or not value.strip():
            raise TaskingError("TASK_BAD_REQUEST", f"缺少或无效字段: {key}")
        return value.strip()

    @staticmethod
    def _version(body: dict, headers: Mapping[str, str]) -> int:
        value = body.get("expected_version")
        if value is None:
            raw = headers.get("If-Match") or headers.get("if-match")
            if isinstance(raw, str):
                match = re.fullmatch(r'(?:W/)?"?(?:[^:]+:)?(\d+)"?', raw.strip())
                value = int(match.group(1)) if match else None
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise TaskingError("TASK_EXPECTED_VERSION_REQUIRED", "写入必须携带非负 expected_version", {"field": "expected_version"})
        return value

    @staticmethod
    def _task_view(task: dict) -> dict:
        public = dict(task)
        try:
            public["acceptance"] = list(json.loads(public.pop("acceptance_json")).get("items", []))
        except (TypeError, ValueError, json.JSONDecodeError):
            public["acceptance"] = []
            public.pop("acceptance_json", None)
        return public

    def _task_with_seq(self, task: dict) -> dict:
        public = self._task_view(task)
        public["last_seq"] = self.store.last_event_seq(task["id"])
        return public

    @staticmethod
    def _queue_view(item) -> dict:
        value = dict(item.__dict__)
        for key in ("not_before", "created_at", "updated_at"):
            if key in value and hasattr(value[key], "isoformat"):
                value[key] = value[key].isoformat().replace("+00:00", "Z")
        return value

    @staticmethod
    def _memory_view(record) -> dict:
        """只序列化产品需要的账本字段；时间统一为 UTC ISO。"""
        value = dict(record.__dict__)
        for key, item in value.items():
            if isinstance(item, datetime):
                value[key] = item.astimezone(UTC).isoformat().replace("+00:00", "Z")
        return value

    @staticmethod
    def _memory_receipt_view(receipt: dict) -> dict:
        public = dict(receipt)
        try:
            public["record_ids"] = list(json.loads(public.pop("record_ids_json")))
        except (TypeError, ValueError, json.JSONDecodeError):
            public["record_ids"] = []
            public.pop("record_ids_json", None)
        return public

    @staticmethod
    def _event_view(event: dict) -> dict:
        payload = json.loads(event["payload_json"])
        run_id = payload.get("run_id") if isinstance(payload, dict) else None
        return {"v": 2, "event_id": f"{event['task_id']}:{event['seq']}", "seq": event["seq"],
                "type": event["type"], "task_id": event["task_id"], "run_id": run_id,
                "at": event["created_at"], "payload": payload}

    def _emit_new_events(self, task_id: str, before_seq: int) -> None:
        if self.event_sink is None:
            return
        for event in self.store.list_events_after(task_id, before_seq):
            self.event_sink(self._event_view(event))

    @staticmethod
    def _etag(task: dict) -> dict[str, str]:
        return {"ETag": f'W/"{task["id"]}:{task["version"]}"'}

    def dispatch(self, method: str, path: str, body: Any = None,
                 headers: Mapping[str, str] | None = None, query: Mapping[str, list[str]] | None = None) -> HTTPResult:
        headers, query = headers or {}, query or {}
        try:
            return self._dispatch(method.upper(), path, body, headers, query)
        except TaskingError as exc:
            # Registered domain codes own their public HTTP semantics.  Keeping
            # a second hand-maintained status table here caused 404 sources to
            # become 400 when the error registry was introduced.
            status = REGISTRY.get(exc.code).http_status
            return self._error(status, exc.code, exc.message, "刷新任务后重试" if status == 409 else "检查请求字段", exc.details)
        except KeyError:
            return self._error(404, "TASK_NOT_FOUND", "任务或项目不存在", "刷新列表后重试")
        except ValueError as exc:
            return self._error(400, "TASK_BAD_REQUEST", str(exc), "检查请求字段")
        except (TaskCheckpointError, RecoveryError) as exc:
            return self._error(409, str(exc), "工作区或恢复预览已变化", "刷新预览后重试")
        except WorktreeError as exc:
            return self._error(409, str(exc), "隔离工作树创建失败", "检查 Git 状态或改选当前工作树")
        except Exception as exc:
            # Never leak raw exception text (which can contain paths, command
            # output or credentials) through the public HTTP boundary.
            public = map_exception(exc)
            return HTTPResult(500, {"error": public})

    def _dispatch(self, method: str, path: str, raw_body: Any,
                  headers: Mapping[str, str], query: Mapping[str, list[str]]) -> HTTPResult:
        body = self._body(raw_body)
        if path == "/api/v2/beta-observability" and method == "GET":
            def evidence(name: str) -> dict:
                candidate = self.workspace_root / "docs" / "evidence" / name / "report.json"
                if not candidate.is_file(): return {"state": "missing"}
                try:
                    payload = json.loads(candidate.read_text(encoding="utf-8"))
                    return {"state": "pass" if payload.get("pass", payload.get("acceptance_pass") == 1.0) else "hold",
                            "updated_at": candidate.stat().st_mtime, "summary": {key: payload.get(key) for key in ("case_count", "acceptance_pass", "delta", "pass")}}
                except (OSError, ValueError, json.JSONDecodeError): return {"state": "invalid"}
            return HTTPResult(200, {"v": 1, "gates": {"resources": evidence("g7-resources"), "task_eval": evidence("g8-eval"),
                "privacy": {"state": self.telemetry.consent, "queued": len(self.telemetry.preview())},
                "release": {"state": "hold", "reason": "awaiting signed installers and external cohort evidence"}}})
        if path == "/api/v2/privacy" and method == "GET":
            return HTTPResult(200, {"consent": self.telemetry.consent, "consent_version": self.telemetry.consent_version,
                                    "payloads": self.telemetry.preview()})
        if path == "/api/v2/privacy" and method == "POST":
            self.telemetry.set_consent(body.get("consent"), body.get("consent_version"))
            if body.get("clear") is True: self.telemetry.clear()
            return HTTPResult(200, {"consent": self.telemetry.consent, "payloads": self.telemetry.preview()})
        if path == "/api/v2/diagnostics/preview" and method == "POST":
            preview = self.diagnostics.preview({"app_version": "0.1.0", "schema_version": self.store.SCHEMA_VERSION,
                                                "platform_capability": body.get("platform_capability", "unknown"),
                                                "error_counts": body.get("error_counts", {}), "task_counts": body.get("task_counts", {})})
            return HTTPResult(200, {"preview_id": preview.id, "files": list(preview.files), "manifest": preview.manifest})
        if path == "/api/v2/diagnostics/export" and method == "POST":
            archive = self.diagnostics.create(self._required_text(body, "preview_id"))
            return HTTPResult(201, {"archive": archive.name})
        if method == "GET" and path == "/api/v2/projects":
            return HTTPResult(200, {"projects": self.store.list_projects()})
        if method == "POST" and path == "/api/v2/projects":
            name = self._required_text(body, "name")
            raw_root = body.get("root")
            if raw_root is not None and (not isinstance(raw_root, str) or not raw_root.strip()):
                raise TaskingError("TASK_BAD_REQUEST", "root 必须是非空路径")
            root = Path(raw_root.strip()).expanduser() if isinstance(raw_root, str) else self.workspace_root
            project = self.store.create_project(name, root)
            return HTTPResult(201, {"project": project})
        session_preview = re.fullmatch(r"/api/v2/sessions/([A-Za-z0-9_-]{1,64})/task-preview", path)
        if session_preview and method == "GET":
            if self.session_importer is None:
                return self._error(404, "TASK_SESSION_IMPORT_UNAVAILABLE", "旧会话导入不可用", "继续以旧会话模式工作")
            preview = self.session_importer.preview(session_preview.group(1))
            if "error" in preview:
                error = preview["error"]
                return self._error(404 if error["code"] == "SESSION_NOT_FOUND" else 400,
                                   error["code"], error["message"], "检查旧会话后重试", error.get("details"))
            return HTTPResult(200, {"preview": preview})
        session_import = re.fullmatch(r"/api/v2/sessions/([A-Za-z0-9_-]{1,64})/import-task", path)
        if session_import and method == "POST":
            if self.session_importer is None:
                return self._error(404, "TASK_SESSION_IMPORT_UNAVAILABLE", "旧会话导入不可用", "继续以旧会话模式工作")
            project_id = self._required_text(body, "project_id")
            session_id = session_import.group(1)
            task, created = self.session_importer.import_as_task_with_result(session_id, project_id)
            if created:
                self._emit_new_events(task["id"], 0)
            return HTTPResult(201 if created else 200, {"task": self._task_with_seq(task)}, self._etag(task))
        project_match = re.fullmatch(r"/api/v2/projects/(prj_[A-Za-z0-9_-]+)", path)
        memory_list = re.fullmatch(r"/api/v2/projects/(prj_[A-Za-z0-9_-]+)/memories", path)
        memory_action = re.fullmatch(r"/api/v2/projects/(prj_[A-Za-z0-9_-]+)/memories/(mem_[A-Za-z0-9_-]+)/(approve|reject|forget|rewrite-and-approve|review)", path)
        memory_source = re.fullmatch(r"/api/v2/projects/(prj_[A-Za-z0-9_-]+)/memory-sources", path)
        memory_receipts = re.fullmatch(r"/api/v2/projects/(prj_[A-Za-z0-9_-]+)/memory-usage-receipts", path)
        memory_supersede = re.fullmatch(r"/api/v2/projects/(prj_[A-Za-z0-9_-]+)/memories/(mem_[A-Za-z0-9_-]+)/supersede", path)
        profile_list = re.fullmatch(r"/api/v2/projects/(prj_[A-Za-z0-9_-]+)/verification-profiles", path)
        profile_approve = re.fullmatch(r"/api/v2/projects/(prj_[A-Za-z0-9_-]+)/verification-profiles/(sha256(?::|%3A)[0-9a-f]{64})/approve", path)
        if memory_source and method == "GET":
            project_id = memory_source.group(1)
            source_ref = (query.get("source_ref") or [None])[0]
            if not isinstance(source_ref, str) or not source_ref:
                raise TaskingError("TASK_BAD_REQUEST", "source_ref 是必填查询参数")
            return HTTPResult(200, {"source": dict(self.memory_sources.resolve(project_id, source_ref).__dict__)})
        if memory_receipts and method == "GET":
            project_id = memory_receipts.group(1)
            self.store.get_project(project_id)
            run_id = (query.get("run_id") or [None])[0]
            if run_id is not None and (not isinstance(run_id, str) or not re.fullmatch(r"run_[A-Za-z0-9_-]+", run_id)):
                raise TaskingError("TASK_BAD_REQUEST", "run_id 必须是运行 ID")
            raw_limit = (query.get("limit") or ["50"])[0]
            try:
                limit = int(raw_limit)
            except (TypeError, ValueError) as exc:
                raise TaskingError("TASK_BAD_REQUEST", "limit 必须是 1 到 100 的整数") from exc
            if not 1 <= limit <= 100:
                raise TaskingError("TASK_BAD_REQUEST", "limit 必须是 1 到 100 的整数")
            receipts = self.store.list_memory_usage_receipts(project_id, run_id, limit)
            return HTTPResult(200, {"receipts": [self._memory_receipt_view(item) for item in receipts]})
        if memory_list and method == "GET":
            project_id = memory_list.group(1)
            status = (query.get("status") or [None])[0]
            if status is not None and status not in {kind.value for kind in MemoryStatus}:
                raise TaskingError("TASK_BAD_REQUEST", "status 不是有效的记忆状态")
            return HTTPResult(200, {"memories": [self._memory_view(item) for item in self.project_memory.list(project_id, status)]})
        if memory_list and method == "POST":
            project_id = memory_list.group(1)
            source_ref = self._required_text(body, "source_ref")
            source = self.memory_sources.resolve(project_id, source_ref)
            raw_review_after = body.get("review_after")
            review_after = None
            if raw_review_after is not None:
                if not isinstance(raw_review_after, str):
                    raise TaskingError("TASK_BAD_REQUEST", "review_after 必须是 UTC ISO 时间")
                try:
                    parsed_review_after = datetime.fromisoformat(raw_review_after.replace("Z", "+00:00"))
                    if parsed_review_after.tzinfo is None:
                        raise ValueError("missing timezone")
                    review_after = parsed_review_after.astimezone(UTC)
                except ValueError as exc:
                    raise TaskingError("TASK_BAD_REQUEST", "review_after 必须是 UTC ISO 时间") from exc
            record = self.project_memory.create(CreateMemoryCandidate(
                project_id, MemoryKind(self._required_text(body, "kind")), self._required_text(body, "text"),
                source_ref, source.trust, body.get("confidence", 0.5),
                self._required_text(body, "actor"), review_after, body.get("request_id"),
            ))
            return HTTPResult(201, {"memory": self._memory_view(record)})
        if memory_action and method == "POST":
            project_id, memory_id, action = memory_action.groups()
            version, actor = self._version(body, headers), self._required_text(body, "actor")
            if action == "forget":
                record = self.project_memory.forget(project_id, memory_id, version, actor, self._required_text(body, "reason"))
            elif action == "rewrite-and-approve":
                record = self.project_memory.rewrite_and_approve(project_id, memory_id, self._required_text(body, "text"), version, actor)
            elif action == "review":
                raw = self._required_text(body, "review_after")
                try:
                    when = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                    if when.tzinfo is None:
                        raise ValueError("missing timezone")
                    when = when.astimezone(UTC)
                except ValueError as exc:
                    raise TaskingError("TASK_BAD_REQUEST", "review_after 必须是 UTC ISO 时间") from exc
                record = self.project_memory.renew_review(project_id, memory_id, when, version, actor)
            else:
                record = getattr(self.project_memory, action)(project_id, memory_id, version, actor)
            return HTTPResult(200, {"memory": self._memory_view(record)})
        if memory_supersede and method == "POST":
            project_id, old_id = memory_supersede.groups()
            # 取代是显式裁决；旧记录版本必须匹配，防止在用户确认期间取代已变化的事实。
            old = self.project_memory.get(project_id, old_id)
            if old.version != self._version(body, headers):
                raise TaskingError("TASK_VERSION_CONFLICT", "记忆已被其他操作更新")
            record = self.memory_conflicts.supersede(project_id, old_id, self._required_text(body, "new_memory_id"), self._required_text(body, "actor"))
            return HTTPResult(200, {"memory": self._memory_view(record)})
        if profile_list and method == "GET":
            project = self.store.get_project(profile_list.group(1))
            candidates = []
            for candidate in discover(Path(project["root"])):
                candidates.append({"name": candidate.name, "profile": (None if candidate.profile is None else __import__("dataclasses").asdict(candidate.profile)),
                                   "checksum": (None if candidate.profile is None else profile_checksum(candidate.profile)),
                                   "source_hashes": candidate.source_hashes, "trust_status": candidate.trust_status,
                                   "executable": candidate.executable, "reason": candidate.reason})
            return HTTPResult(200, {"candidates": candidates})
        if profile_approve and method == "POST":
            project_id, checksum = profile_approve.groups(); checksum=checksum.replace("%3A",":"); project = self.store.get_project(project_id)
            candidate = next((item for item in discover(Path(project["root"])) if item.profile and profile_checksum(item.profile) == checksum), None)
            if candidate is None: raise TaskingError("TASK_VERIFICATION_PROFILE_NOT_FOUND", "找不到仍有效的验证候选")
            trusted = self.verification_trust.approve(project_id, candidate.profile, candidate.source_hashes, self._required_text(body,"actor"))
            return HTTPResult(200, {"profile": trusted})
        if method == "GET" and project_match:
            project_id = project_match.group(1)
            project = next((p for p in self.store.list_projects() if p["id"] == project_id), None)
            if project is None:
                raise TaskingError("TASK_PROJECT_NOT_FOUND", "项目不存在")
            tasks = [self._task_with_seq(t) for t in self.store.list_tasks({"project_id": project_id})]
            return HTTPResult(200, {"project": project, "tasks": tasks})
        if method == "GET" and path == "/api/v2/tasks":
            filters = {key: (query.get(key) or [None])[0] for key in ("project_id", "status", "legacy_session_id")}
            return HTTPResult(200, {"tasks": [self._task_with_seq(t) for t in self.store.list_tasks(filters)]})
        if method == "POST" and path == "/api/v2/tasks":
            acceptance = body.get("acceptance", [])
            if not isinstance(acceptance, list) or not all(isinstance(item, str) for item in acceptance):
                raise TaskingError("TASK_BAD_REQUEST", "acceptance 必须是字符串数组")
            goal = self._required_text(body, "goal")
            title = body.get("title") if isinstance(body.get("title"), str) else goal[:80]
            project_id = self._required_text(body, "project_id")
            before = 0
            task = self.engine.create_task(CreateTask(project_id, title, goal, tuple(acceptance), body.get("legacy_session_id")))
            self._emit_new_events(task["id"], before)
            return HTTPResult(201, {"task": self._task_with_seq(task)}, self._etag(task))
        task_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)", path)
        task_cancel = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/cancel", path)
        changesets_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/changesets", path)
        current_changeset = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/changesets/current", path)
        capture_changeset = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/changesets", path)
        artifact_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/changesets/(csg_[A-Za-z0-9_-]+)/artifacts/(tracked|staged|untracked-\d+)", path)
        review_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/reviews", path)
        verification_list = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/verifications", path)
        verification_detail = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/verifications/(vrf_[A-Za-z0-9_-]+)", path)
        evidence_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/evidence/(vrf_[A-Za-z0-9_-]+)/(vck_[A-Za-z0-9_-]+)", path)
        completion_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/complete", path)
        repair_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/repair", path)
        checkpoints_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/checkpoints", path)
        recovery_preview_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/recovery-previews", path)
        recovery_execute_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/recovery-executions", path)
        fork_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/forks", path)
        queue_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/queue", path)
        queue_control = re.fullmatch(r"/api/v2/queue/(qit_[A-Za-z0-9_-]+)/(pause|resume|cancel)", path)
        workspace_preflight = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/workspace-preflight", path)
        workspaces_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/workspaces", path)
        if current_changeset and method == "GET":
            task_id = current_changeset.group(1)
            self.store.get_task(task_id)
            changeset = self.store.current_changeset(task_id)
            return HTTPResult(200, {"changeset": changeset})
        if queue_match and method == "POST":
            task_id = queue_match.group(1); task = self.store.get_task(task_id)
            workspaces = self.store.list_workspaces(task_id)
            isolated_ready = any(item["mode"] == "isolated" and item["status"] in {"ready", "leased"}
                                 for item in workspaces)
            if task["status"] != TaskStatus.READY.value or task.get("active_plan_revision") is None \
                    or not self.store.acceptance_items(task) or not isolated_ready:
                raise TaskingError(
                    "TASK_UNATTENDED_PRECONDITION_REQUIRED",
                    "无人队列必须绑定已批准计划、验收标准和可用的隔离工作区",
                    {"task_status": task["status"], "has_approved_plan": task.get("active_plan_revision") is not None,
                     "has_acceptance": bool(self.store.acceptance_items(task)), "has_isolated_workspace": isolated_ready},
                )
            not_before = body.get("not_before") or datetime.now(UTC).isoformat().replace("+00:00", "Z")
            try: when = datetime.fromisoformat(str(not_before).replace("Z", "+00:00")).astimezone(UTC)
            except ValueError: raise TaskingError("TASK_BAD_REQUEST", "not_before 必须是 UTC ISO 时间")
            item = TaskQueue(self.store).enqueue(EnqueueTask(task_id, self._required_text(body, "trigger_kind"), self._required_text(body, "trigger_key"), body.get("priority", 0), when, self._required_text(body, "policy_id"), self._version(body, headers)))
            return HTTPResult(201, {"queue_item": self._queue_view(item)})
        if queue_control and method == "POST":
            item_id, action = queue_control.groups(); version = self._version(body, headers); queue = TaskQueue(self.store)
            item = getattr(queue, action)(item_id, version)
            return HTTPResult(200, {"queue_item": self._queue_view(item)})
        if task_cancel and method == "POST":
            task_id = task_cancel.group(1)
            before = self.store.last_event_seq(task_id)
            task, run = self.engine.cancel_task(task_id, self._version(body, headers), self._required_text(body, "actor"))
            self._emit_new_events(task_id, before)
            return HTTPResult(200, {"task": self._task_with_seq(task), "run": run}, self._etag(task))
        if changesets_match and method == "GET":
            task_id = changesets_match.group(1)
            self.store.get_task(task_id)
            return HTTPResult(200, {"changesets": self.store.list_changesets(task_id)})
        if capture_changeset and method == "POST":
            task_id = capture_changeset.group(1)
            task = self.store.get_task(task_id)
            run_id = self._required_text(body, "run_id")
            run = self.store.get_run(run_id)
            if run["task_id"] != task_id:
                raise TaskingError("TASK_NOT_FOUND", "该运行不属于此任务")
            if task["status"] != TaskStatus.REVIEW.value:
                raise TaskingError("TASK_TRANSITION_INVALID", "只有待审查任务可以捕获变更集", {"from": task["status"]})
            policy = json.loads(run["policy_json"])
            baseline = policy.get("baseline_ref")
            if not isinstance(baseline, str) or not baseline:
                raise TaskingError("TASK_CHANGESET_BASELINE_REQUIRED", "该运行没有可审计的 Git 基线")
            project = self.store.get_project(task["project_id"])
            plan = None
            if task.get("active_plan_revision") is not None:
                plan = self.engine.plans.get(task_id, int(task["active_plan_revision"]))["body"]
            before = self.store.last_event_seq(task_id)
            try:
                captured = self.changesets.capture_changes(task_id, run_id, Path(project["root"]), baseline, plan)
            except RuntimeError as exc:
                raise TaskingError("TASK_CHANGESET_CAPTURE_FAILED", "无法稳定捕获当前工作区变更", {"reason": str(exc)}) from exc
            saved = self.store.find_changeset(run_id, captured.workspace_version, captured.diff_hash)
            if saved is None:
                saved = self.store.insert_changeset(task_id, run_id, captured.workspace_version, captured.diff_hash, captured.manifest())
            self._emit_new_events(task_id, before)
            return HTTPResult(201 if before != self.store.last_event_seq(task_id) else 200, {"changeset": saved})
        if artifact_match and method == "GET":
            task_id, changeset_id, artifact_key = artifact_match.groups()
            changeset = self.store.get_changeset(changeset_id)
            if changeset["task_id"] != task_id:
                raise TaskingError("TASK_NOT_FOUND", "变更集不存在")
            artifacts = changeset["manifest"].get("artifacts", {})
            if artifact_key in {"tracked", "staged"}:
                raw_ref = artifacts.get(artifact_key)
            else:
                index = int(artifact_key.split("-", 1)[1])
                values = artifacts.get("untracked", [])
                raw_ref = values[index].get("content_artifact") if 0 <= index < len(values) else None
            if not isinstance(raw_ref, dict):
                raise TaskingError("TASK_NOT_FOUND", "该产物不存在或不允许显示正文")
            ref = ArtifactRef(**raw_ref)
            if not self.artifact_store.verify(ref):
                raise TaskingError("TASK_ARTIFACT_HASH_MISMATCH", "审查产物缺失或校验失败")
            if not ref.media_type.startswith("text/"):
                raise TaskingError("TASK_ARTIFACT_NOT_TEXT", "二进制产物只提供元数据")
            return HTTPResult(200, {"artifact": raw_ref, "text": self.artifact_store.read(ref).decode("utf-8", "surrogateescape")})
        if review_match and method == "POST":
            task_id = review_match.group(1)
            changeset_id = self._required_text(body, "changeset_id")
            changeset = self.store.get_changeset(changeset_id)
            if changeset["task_id"] != task_id:
                raise TaskingError("TASK_NOT_FOUND", "该变更集不属于此任务")
            project = self.store.get_project(self.store.get_task(task_id)["project_id"])
            self.reviews.check_persisted_freshness(changeset_id, Path(project["root"]),
                                                   self._required_text(body, "diff_hash"),
                                                   self._required_text(body, "workspace_version"))
            before = self.store.last_event_seq(task_id)
            task, review, repair_run = self.engine.apply_review_decision(
                task_id=task_id, changeset_id=changeset_id, request_id=self._required_text(body, "request_id"),
                decision=self._required_text(body, "decision"), feedback=body.get("feedback", ""),
                diff_hash=self._required_text(body, "diff_hash"), workspace_version=self._required_text(body, "workspace_version"),
                expected_version=self._version(body, headers), actor=self._required_text(body, "actor"),
            )
            self._emit_new_events(task_id, before)
            return HTTPResult(200, {"task": self._task_with_seq(task), "review": review, "run": repair_run}, self._etag(task))
        if verification_list and method == "POST":
            task_id = verification_list.group(1); task=self.store.get_task(task_id); project=self.store.get_project(task["project_id"])
            checksum=self._required_text(body,"profile_checksum"); record=self.store.get_verification_profile(project["id"],checksum)
            if record is None: raise TaskingError("TASK_VERIFICATION_PROFILE_NOT_FOUND","验证配置不存在")
            profile=normalize_profile(json.loads(record["profile_json"]),Path(project["root"]))
            before=self.store.last_event_seq(task_id)
            result=self.verification.run(task_id,profile,self._version(body,headers),self._required_text(body,"actor"))
            self._emit_new_events(task_id,before)
            return HTTPResult(202,{**result,"task":self._task_with_seq(self.store.get_task(task_id))},self._etag(self.store.get_task(task_id)))
        if verification_list and method == "GET":
            task_id=verification_list.group(1); self.store.get_task(task_id); return HTTPResult(200,{"verification":self.store.latest_verification_run(task_id),"coverage":self.store.list_acceptance_coverage(task_id)})
        if verification_detail and method == "GET":
            task_id,verification_id=verification_detail.groups(); verification=self.store.get_verification_run(verification_id)
            if verification["task_id"] != task_id: raise TaskingError("TASK_NOT_FOUND","验证记录不存在")
            return HTTPResult(200,{"verification":verification,"coverage":self.store.list_acceptance_coverage(task_id,verification_id)})
        if evidence_match and method == "GET":
            task_id,verification_id,check_id=evidence_match.groups(); verification=self.store.get_verification_run(verification_id)
            if verification["task_id"] != task_id: raise TaskingError("TASK_NOT_FOUND","证据不存在")
            check=next((item for item in verification["checks"] if item["id"] == check_id),None)
            if check is None: raise TaskingError("TASK_NOT_FOUND","证据不存在")
            raw=check["result"].get("artifact");
            if not isinstance(raw,dict): raise TaskingError("TASK_NOT_FOUND","证据不存在")
            ref=ArtifactRef(**raw)
            if not self.artifact_store.verify(ref): raise TaskingError("TASK_ARTIFACT_HASH_MISMATCH","证据产物校验失败")
            return HTTPResult(200,{"artifact":raw,"text":self.artifact_store.read(ref).decode("utf-8","surrogateescape")})
        if completion_match and method == "POST":
            task_id=completion_match.group(1); before=self.store.last_event_seq(task_id)
            task=self.engine.complete_task(task_id,self._version(body,headers),self._required_text(body,"actor"),self._required_text(body,"proof_id"))
            self._emit_new_events(task_id,before)
            return HTTPResult(200,{"task":self._task_with_seq(task)},self._etag(task))
        if repair_match and method == "POST":
            task_id=repair_match.group(1); before=self.store.last_event_seq(task_id)
            task,run=self.engine.start_repair_from_verification(task_id,self._version(body,headers),self._required_text(body,"actor"),str(body.get("feedback", "")))
            self._emit_new_events(task_id,before)
            return HTTPResult(201,{"task":self._task_with_seq(task),"run":run},self._etag(task))
        if checkpoints_match and method == "GET":
            task_id=checkpoints_match.group(1); self.store.get_task(task_id)
            return HTTPResult(200,{"checkpoints":self.store.list_task_checkpoints(task_id)})
        if checkpoints_match and method == "POST":
            task_id=checkpoints_match.group(1); before=self.store.last_event_seq(task_id)
            paths=body.get("paths",[])
            if not isinstance(paths,list) or not all(isinstance(item,str) for item in paths): raise TaskingError("TASK_BAD_REQUEST","paths 必须是字符串数组")
            checkpoint=self.checkpoints.create(task_id,self._required_text(body,"workspace_id"),self._required_text(body,"kind"),paths,run_id=body.get("run_id"))
            self._emit_new_events(task_id,before); return HTTPResult(201,{"checkpoint":checkpoint})
        if recovery_preview_match and method == "POST":
            task_id=recovery_preview_match.group(1); before=self.store.last_event_seq(task_id)
            preview=self.recovery.preview(task_id,self._required_text(body,"checkpoint_id"))
            self._emit_new_events(task_id,before); return HTTPResult(201,{"preview":preview})
        if recovery_execute_match and method == "POST":
            task_id=recovery_execute_match.group(1); before=self.store.last_event_seq(task_id)
            acknowledgement=body.get("irreversible_effects_acknowledged")
            if not isinstance(acknowledgement,bool):
                raise TaskingError("TASK_BAD_REQUEST","irreversible_effects_acknowledged 必须是布尔值")
            result=self.recovery.execute(task_id,self._required_text(body,"preview_id"),self._required_text(body,"preview_hash"),
                                         irreversible_acknowledged=acknowledgement)
            self._emit_new_events(task_id,before); return HTTPResult(200,{"recovery":result})
        if fork_match and method == "POST":
            task_id=fork_match.group(1); before=self.store.last_event_seq(task_id)
            fork=self.engine.fork_from_checkpoint(task_id,self._required_text(body,"checkpoint_id"),self._required_text(body,"title"),self._version(body,headers))
            self._emit_new_events(task_id,before); return HTTPResult(201,{"task":self._task_with_seq(fork)})
        if workspace_preflight and method == "GET":
            task_id=workspace_preflight.group(1); task=self.store.get_task(task_id)
            result=self.workspace_service.preflight(task["project_id"],task_id)
            return HTTPResult(200,{"preflight":{"project_id":result.project_id,"task_id":result.task_id,"repo_kind":result.repo_kind,"allowed_modes":list(result.allowed_modes),"recommended_mode":result.recommended_mode,"warnings":list(result.warnings),"dirty_baseline":result.dirty_baseline,"capabilities":result.capabilities.__dict__}})
        if workspaces_match and method == "GET":
            task_id=workspaces_match.group(1); self.store.get_task(task_id); return HTTPResult(200,{"workspaces":self.store.list_workspaces(task_id)})
        if workspaces_match and method == "POST":
            task_id=workspaces_match.group(1); task=self.store.get_task(task_id); project=self.store.get_project(task["project_id"])
            preflight=self.workspace_service.preflight(project["id"],task_id); mode=self._required_text(body,"mode")
            if mode not in preflight.allowed_modes: raise TaskingError("TASK_WORKSPACE_MODE_UNAVAILABLE","该工作区模式当前不可用",{"allowed_modes":list(preflight.allowed_modes)})
            before=self.store.last_event_seq(task_id)
            if mode == "isolated":
                if preflight.repo_kind not in {"git","git_unborn"}: raise TaskingError("TASK_WORKSPACE_MODE_UNAVAILABLE","非 Git 项目只能使用 limited 模式")
                baseline_ref=str(body.get("baseline_ref") or "HEAD")
                workspace=self.worktrees.create(task_id,project["id"],Path(project["root"]),preflight.dirty_baseline,baseline_ref)
            else:
                workspace=self.store.reserve_workspace(task_id,project["id"],mode,preflight.dirty_baseline)
                workspace=self.store.activate_workspace(workspace["id"],Path(project["root"]),WorkspaceVersionService().current(Path(project["root"])))
            self._emit_new_events(task_id,before); return HTTPResult(201,{"workspace":workspace})
        plans_match = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/plans", path)
        if plans_match and method == "GET":
            task_id = plans_match.group(1)
            self.store.get_task(task_id)
            return HTTPResult(200, {"plans": self.engine.plans.list(task_id)})
        if plans_match and method == "POST":
            task_id = plans_match.group(1)
            before = len(self.store.list_events(task_id))
            plan_body = body.get("body")
            if not isinstance(plan_body, dict):
                raise TaskingError("TASK_BAD_REQUEST", "body 必须是 Plan 对象")
            plan = self.engine.propose_plan(task_id, plan_body, self._required_text(body, "actor"), self._version(body, headers))
            self._emit_new_events(task_id, before)
            task = self.store.get_task(task_id)
            return HTTPResult(201, {"plan": plan, "task": self._task_with_seq(task)}, self._etag(task))
        plan_review = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/plans/(\d+)/review", path)
        if plan_review and method == "POST":
            task_id, revision_text = plan_review.groups()
            before = len(self.store.list_events(task_id))
            edited_body = body.get("edited_body")
            if edited_body is not None and not isinstance(edited_body, dict):
                raise TaskingError("TASK_BAD_REQUEST", "edited_body 必须是 Plan 对象")
            reviewed = self.engine.review_plan(ReviewPlan(
                task_id, int(revision_text), self._required_text(body, "decision"),
                body.get("feedback", ""), self._version(body, headers), self._required_text(body, "actor"), edited_body,
            ))
            self._emit_new_events(task_id, before)
            task = self.store.get_task(task_id)
            return HTTPResult(200, {"plan": reviewed, "task": self._task_with_seq(task)}, self._etag(task))
        if task_match and method == "GET":
            task_id = task_match.group(1)
            task = self.store.get_task(task_id)
            after = (query.get("events_after") or ["0"])[0]
            try:
                events_after = int(after)
            except (TypeError, ValueError):
                raise TaskingError("TASK_BAD_REQUEST", "events_after 必须是非负整数")
            if events_after < 0:
                raise TaskingError("TASK_BAD_REQUEST", "events_after 必须是非负整数")
            return HTTPResult(200, {"task": self._task_with_seq(task), "events": [self._event_view(e) for e in self.store.list_events_after(task_id, events_after)]}, self._etag(task))
        if task_match and method == "PATCH":
            task_id = task_match.group(1)
            self.store.get_task(task_id)
            before = len(self.store.list_events(task_id))
            acceptance = None
            if "acceptance" in body:
                raw_acceptance = body["acceptance"]
                if not isinstance(raw_acceptance, list) or not all(isinstance(item, str) for item in raw_acceptance):
                    raise TaskingError("TASK_BAD_REQUEST", "acceptance 必须是字符串数组")
                acceptance = tuple(raw_acceptance)
            command = UpdateTaskDefinition(task_id, self._version(body, headers), self._required_text(body, "request_id"),
                                           body.get("title"), body.get("goal"),
                                           acceptance)
            updated = self.engine.update_task_definition(command)
            self._emit_new_events(task_id, before)
            return HTTPResult(200, {"task": self._task_with_seq(updated)}, self._etag(updated))
        transition = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/transition", path)
        if transition and method == "POST":
            task_id = transition.group(1)
            before = len(self.store.list_events(task_id))
            target = TaskStatus(self._required_text(body, "to"))
            updated = self.engine.transition(task_id, target, self._version(body, headers), self._required_text(body, "actor"))
            self._emit_new_events(task_id, before)
            return HTTPResult(200, {"task": self._task_with_seq(updated)}, self._etag(updated))
        run_start = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/runs", path)
        if run_start and method == "POST":
            task_id = run_start.group(1)
            before = len(self.store.list_events(task_id))
            policy = body.get("policy_snapshot", {})
            if not isinstance(policy, dict):
                raise TaskingError("TASK_BAD_REQUEST", "policy_snapshot 必须是对象")
            task, run = self.engine.start_run(StartRun(task_id, self._version(body, headers), self._required_text(body, "actor"),
                                                       body.get("workspace_id"), body.get("plan_revision_id"), policy))
            self._emit_new_events(task_id, before)
            return HTTPResult(201, {"task": self._task_with_seq(task), "run": run}, self._etag(task))
        run_stop = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/runs/(run_[A-Za-z0-9_-]+)/stop", path)
        if run_stop and method == "POST":
            task_id, run_id = run_stop.groups()
            run = self.store.get_run(run_id)
            if run["task_id"] != task_id:
                raise TaskingError("TASK_NOT_FOUND", "该运行不属于此任务")
            before = len(self.store.list_events(task_id))
            requested = self.run_control.request_stop(run_id, self._required_text(body, "actor"), self._version(body, headers))
            self._emit_new_events(task_id, before)
            task = self.store.get_task(task_id)
            return HTTPResult(202, {"task": self._task_with_seq(task), "run": self.store.get_run(run_id), "stop_requested": requested}, self._etag(task))
        run_steer = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/runs/(run_[A-Za-z0-9_-]+)/steer", path)
        if run_steer and method == "POST":
            task_id, run_id = run_steer.groups()
            run = self.store.get_run(run_id)
            if run["task_id"] != task_id:
                raise TaskingError("TASK_NOT_FOUND", "该运行不属于此任务")
            before = len(self.store.list_events(task_id))
            position = self.run_control.queue_steer(run_id, self._required_text(body, "text"), self._required_text(body, "actor"), self._version(body, headers))
            self._emit_new_events(task_id, before)
            task = self.store.get_task(task_id)
            return HTTPResult(202, {"task": self._task_with_seq(task), "run_id": run_id, "queue_position": position,
                                    "queued_input_count": self.run_control.queued_count(run_id)}, self._etag(task))
        task_questions = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/questions", path)
        if task_questions and method == "GET":
            task_id = task_questions.group(1)
            self.store.get_task(task_id)
            return HTTPResult(200, {"questions": self.engine.questions.list_open(task_id)})
        run_question = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/runs/(run_[A-Za-z0-9_-]+)/questions", path)
        if run_question and method == "POST":
            task_id, run_id = run_question.groups()
            run = self.store.get_run(run_id)
            if run["task_id"] != task_id:
                raise TaskingError("TASK_NOT_FOUND", "该运行不属于此任务")
            choices = body.get("choices")
            if not isinstance(choices, list) or not all(isinstance(item, str) for item in choices):
                raise TaskingError("TASK_BAD_REQUEST", "choices 必须是字符串数组")
            before = len(self.store.list_events(task_id))
            task, question = self.engine.ask_question(AskQuestion(
                run_id, self._required_text(body, "prompt"), tuple(choices),
                body.get("allow_free_text", False), self._required_text(body, "reason_code"), self._required_text(body, "actor"),
            ))
            self._emit_new_events(task_id, before)
            return HTTPResult(201, {"task": self._task_with_seq(task), "question": question}, self._etag(task))
        question_answer = re.fullmatch(r"/api/v2/tasks/(tsk_[A-Za-z0-9_-]+)/questions/(qst_[A-Za-z0-9_-]+)/answer", path)
        if question_answer and method == "POST":
            task_id, question_id = question_answer.groups()
            before = len(self.store.list_events(task_id))
            task, question = self.engine.answer_question(AnswerQuestion(
                task_id, question_id, self._required_text(body, "answer"), self._version(body, headers), self._required_text(body, "actor"),
            ))
            self._emit_new_events(task_id, before)
            return HTTPResult(200, {"task": self._task_with_seq(task), "question": question}, self._etag(task))
        if method == "GET" and path == "/api/v2/inbox":
            raw_needs_user = (query.get("needs_user") or ["false"])[0]
            if raw_needs_user not in {"true", "false"}: raise TaskingError("TASK_BAD_REQUEST", "needs_user 必须是 true 或 false")
            page = TaskInbox(self.store).query((query.get("project_id") or [None])[0], raw_needs_user == "true")
            tasks = [self._task_with_seq(t) for t in page.items]
            groups: dict[str, list[dict]] = {status.value: [] for status in TaskStatus}
            for task in tasks:
                groups[task["status"]].append(task)
            queue_items = self.store.list_queue_items()
            return HTTPResult(200, {"tasks": tasks, "groups": groups, "counts": page.counts, "next_cursor": page.next_cursor,
                                    "queue_items": queue_items})
        return self._error(404, "TASK_ROUTE_NOT_FOUND", f"没有这条 v2 路由：{path}", "查看 Task API 路由")
