import os
import json
import sys
import subprocess
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest import mock

from harness.artifact_store import ArtifactStore
from harness import agent, checkpoint as undo_checkpoint, effects, permission
from harness.task_checkpoint import CheckpointService
from harness.task_model import CreateTask, RunContext
from harness.task_engine import TaskEngine
from harness.task_api import TaskAPI
from harness.task_recovery import RecoveryError, RecoveryService
from harness.task_store import TaskStore
from harness.workspace import WorkspaceService
from harness.workspace_paths import WorkspacePathError, WorkspacePathPolicy
from harness.worktree_manager import WorktreeManager


def _allowing_plan_gate_module() -> types.ModuleType:
    """Keep recovery-side Task dispatch tests independent of later-plan files."""
    module = types.ModuleType("harness.plan_gate")

    class PlanGate:
        def before_action(self, *_args, **_kwargs):
            return None

    module.PlanGate = PlanGate
    return module


def _allowing_run_policy_module() -> types.ModuleType:
    """Keep the test focused on recovery fencing, not a later scope module."""
    module = types.ModuleType("harness.run_policy")
    module.classify_deviation = lambda *_args, **_kwargs: type(
        "Deviation", (), {"level": "none", "reason": ""},
    )()
    module.apply_mode = lambda decision, *_args, **_kwargs: decision
    return module


class WorkspaceRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.base=Path(self.temp.name); self.repo=self.base / "项目 空格"; self.repo.mkdir()
        self.git("init"); self.git("config","user.email","test@example.com"); self.git("config","user.name","test")
        self.write("tracked.txt",b"old"); self.git("add","."); self.git("commit","-m","initial")
        self.store=TaskStore(self.base / "state" / "tasks.db"); self.project=self.store.create_project("repo",self.repo)
        self.task=self.store.create_task(CreateTask(self.project["id"],"recover","recover",()))
        self.paths=WorkspacePathPolicy(self.base / "workspaces"); self.workspace_service=WorkspaceService(self.store)

    def tearDown(self): self.temp.cleanup()
    def git(self,*args, cwd=None): return subprocess.run(["git",*args],cwd=cwd or self.repo,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
    def write(self,rel,data):
        p=self.repo/rel; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(data); return p

    def test_dirty_preflight_is_read_only_and_recommends_isolated(self):
        self.write("tracked.txt",b"user work"); before=(self.repo/"tracked.txt").read_bytes()
        result=self.workspace_service.preflight(self.project["id"],self.task["id"])
        self.assertEqual("isolated",result.recommended_mode); self.assertIn("DIRTY_WORKTREE",result.warnings)
        self.assertEqual(before,(self.repo/"tracked.txt").read_bytes())

    def test_path_policy_rejects_project_overlap_and_symlink_escape(self):
        with self.assertRaisesRegex(WorkspacePathError,"OVERLAPS"):
            WorkspacePathPolicy(self.repo / ".xiaoshe").allocate(self.repo,self.task["id"],"ws_abc")
        escape=self.base / "escape"; escape.mkdir(); target=self.paths.allocate(self.repo,self.task["id"],"ws_abc")
        target.parent.parent.mkdir(parents=True)
        try:
            target.parent.symlink_to(escape,target_is_directory=True)
        except OSError as error:
            if os.name == "nt" and error.winerror == 1314:
                self.skipTest("Windows host lacks the symbolic-link privilege required by this fixture")
            raise
        with self.assertRaisesRegex(WorkspacePathError,"ESCAPE"):
            self.paths.allocate(self.repo,self.task["id"],"ws_abc")

    def test_worktree_lease_and_reconcile_never_delete(self):
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        manager=WorktreeManager(self.store,self.paths); work=manager.create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        self.assertTrue(Path(work["root"]).is_dir()); manager.acquire_lease(work["id"],"worker-a")
        with self.assertRaisesRegex(ValueError,"HELD"): manager.acquire_lease(work["id"],"worker-b")
        Path(work["root"]).rename(Path(work["root"]).with_name("kept-by-user"))
        self.assertEqual("orphaned",manager.reconcile()[0]["status"])
        self.assertTrue((Path(work["root"]).with_name("kept-by-user")).exists())

    def test_checkpoint_preview_and_execute_preserves_unknown_files(self):
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        root=Path(work["root"]); (root/"tracked.txt").write_bytes(b"checkpoint"); (root/"managed-new.txt").write_bytes(b"remove on restore")
        artifacts=ArtifactStore(self.base / "artifacts"); checkpoints=CheckpointService(self.store,artifacts)
        cp=checkpoints.create(self.task["id"],work["id"],"manual",["tracked.txt","managed-new.txt","absent.txt"])
        (root/"tracked.txt").write_bytes(b"changed"); (root/"managed-new.txt").unlink(); (root/"absent.txt").write_bytes(b"delete")
        (root/"unknown-user-file.txt").write_bytes(b"keep")
        recovery=RecoveryService(self.store,checkpoints); preview=recovery.preview(self.task["id"],cp["id"])
        deletes=[x["path"] for x in preview["operations"] if x["kind"]=="delete"]
        self.assertEqual(["absent.txt"],deletes); self.assertNotIn("unknown-user-file.txt",deletes)
        result=recovery.execute(self.task["id"],preview["id"],preview["preview_hash"])
        self.assertEqual("completed",result["status"]); self.assertEqual(b"checkpoint",(root/"tracked.txt").read_bytes())
        self.assertEqual(b"remove on restore",(root/"managed-new.txt").read_bytes()); self.assertFalse((root/"absent.txt").exists())
        self.assertEqual(b"keep",(root/"unknown-user-file.txt").read_bytes())

    def test_preview_drift_rejects_before_mutation(self):
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        root=Path(work["root"]); artifacts=ArtifactStore(self.base / "artifacts"); checkpoints=CheckpointService(self.store,artifacts)
        cp=checkpoints.create(self.task["id"],work["id"],"manual",["tracked.txt"]); (root/"tracked.txt").write_text("first",encoding="utf-8")
        recovery=RecoveryService(self.store,checkpoints); preview=recovery.preview(self.task["id"],cp["id"]); (root/"tracked.txt").write_text("later",encoding="utf-8")
        with self.assertRaisesRegex(RecoveryError,"STALE"): recovery.execute(self.task["id"],preview["id"],preview["preview_hash"])
        self.assertEqual("later",(root/"tracked.txt").read_text(encoding="utf-8"))

    def test_irreversible_effect_after_checkpoint_requires_matching_acknowledgement(self):
        """Removing effect acknowledgement must block recovery before any manifest mutation."""
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        root=Path(work["root"]); checkpoints=CheckpointService(self.store,ArtifactStore(self.base / "artifacts"))
        checkpoint=checkpoints.create(self.task["id"],work["id"],"manual",["tracked.txt"])
        (root/"tracked.txt").write_text("changed",encoding="utf-8")
        ledger=self.base / "state" / "effects.jsonl"
        effects.record_effect("run_command", {"command":"git status"}, {"task_id":self.task["id"]}, path=ledger, action_id="act_safe")

        recovery=RecoveryService(self.store,checkpoints,effects_path=ledger)
        preview=recovery.preview(self.task["id"],checkpoint["id"])

        self.assertTrue(preview["irreversible_ack_required"])
        self.assertEqual({"id","action","time","target","reason","evidence_ref"},set(preview["irreversible_effects"][0]))
        with self.assertRaisesRegex(RecoveryError,"IRREVERSIBLE_ACK_REQUIRED"):
            recovery.execute(self.task["id"],preview["id"],preview["preview_hash"])
        self.assertEqual("changed",(root/"tracked.txt").read_text(encoding="utf-8"))
        self.assertEqual("completed",recovery.execute(self.task["id"],preview["id"],preview["preview_hash"],irreversible_acknowledged=True)["status"])

    def test_recovery_api_requires_explicit_boolean_effect_acknowledgement(self):
        """A truthy string must never bypass the recovery acknowledgement contract."""
        api=TaskAPI(self.store,workspace_root=self.repo); path=f"/api/v2/tasks/{self.task['id']}"
        workspace=api.dispatch("POST",path+"/workspaces",{"mode":"isolated"}).body["workspace"]
        checkpoint=api.dispatch("POST",path+"/checkpoints",{"workspace_id":workspace["id"],"kind":"manual","paths":["tracked.txt"]}).body["checkpoint"]
        preview=api.dispatch("POST",path+"/recovery-previews",{"checkpoint_id":checkpoint["id"]}).body["preview"]

        missing=api.dispatch("POST",path+"/recovery-executions",{"preview_id":preview["id"],"preview_hash":preview["preview_hash"]})
        string=api.dispatch("POST",path+"/recovery-executions",{"preview_id":preview["id"],"preview_hash":preview["preview_hash"],"irreversible_effects_acknowledged":"true"})

        self.assertEqual(400,missing.status)
        self.assertEqual(400,string.status)

    def test_effect_added_after_preview_invalidates_even_acknowledged_recovery(self):
        """A recovery preview must not authorize external effects it did not show."""
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        root=Path(work["root"]); checkpoints=CheckpointService(self.store,ArtifactStore(self.base / "artifacts"))
        checkpoint=checkpoints.create(self.task["id"],work["id"],"manual",["tracked.txt"])
        (root/"tracked.txt").write_text("changed",encoding="utf-8")
        ledger=self.base / "state" / "effects.jsonl"; recovery=RecoveryService(self.store,checkpoints,effects_path=ledger)
        preview=recovery.preview(self.task["id"],checkpoint["id"])
        effects.record_effect("run_command", {"command":"git status"}, {"task_id":self.task["id"]}, path=ledger, action_id="act_late")

        with self.assertRaisesRegex(RecoveryError,"PREVIEW_STALE"):
            recovery.execute(self.task["id"],preview["id"],preview["preview_hash"],irreversible_acknowledged=True)
        self.assertEqual("changed",(root/"tracked.txt").read_text(encoding="utf-8"))

    def test_effect_added_after_recovery_before_checkpoint_blocks_manifest_restore(self):
        """An effect in the final checkpoint-to-mutation window invalidates the preview."""
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        root=Path(work["root"]); ledger=self.base / "state" / "effects.jsonl"

        class CheckpointsWithLateEffect(CheckpointService):
            def create(inner, task_id, workspace_id, kind, paths, *, run_id=None):
                checkpoint=super().create(task_id,workspace_id,kind,paths,run_id=run_id)
                if kind == "recovery_before":
                    effects.record_effect("run_command", {"command":"argument-value"}, {"task_id":task_id}, path=ledger)
                return checkpoint

        checkpoints=CheckpointsWithLateEffect(self.store,ArtifactStore(self.base / "artifacts"))
        checkpoint=checkpoints.create(self.task["id"],work["id"],"manual",["tracked.txt"])
        (root/"tracked.txt").write_text("changed",encoding="utf-8")
        recovery=RecoveryService(self.store,checkpoints,effects_path=ledger); preview=recovery.preview(self.task["id"],checkpoint["id"])

        with self.assertRaisesRegex(RecoveryError,"PREVIEW_STALE"):
            recovery.execute(self.task["id"],preview["id"],preview["preview_hash"],irreversible_acknowledged=True)
        self.assertEqual("changed",(root/"tracked.txt").read_text(encoding="utf-8"))
        self.assertIn("recovery_before",[item["kind"] for item in self.store.list_task_checkpoints(self.task["id"])])

    def test_effect_injected_after_execution_record_waits_until_manifest_recovery_finishes(self):
        """The effects fence serializes a late ledger write behind every manifest mutation."""
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        root=Path(work["root"]); ledger=self.base / "state" / "effects.jsonl"
        checkpoints=CheckpointService(self.store,ArtifactStore(self.base / "artifacts"))
        checkpoint=checkpoints.create(self.task["id"],work["id"],"manual",["tracked.txt"])
        (root/"tracked.txt").write_text("changed",encoding="utf-8")
        recovery=RecoveryService(self.store,checkpoints,effects_path=ledger); preview=recovery.preview(self.task["id"],checkpoint["id"])
        started=threading.Event(); wrote=threading.Event(); finished=threading.Event(); observed_finished=[]; workers=[]
        create_original=self.store.create_recovery_execution; finish_original=self.store.finish_recovery_execution

        def create_with_late_effect(*args, **kwargs):
            execution=create_original(*args, **kwargs)
            def inject():
                started.set(); effects.record_effect("run_command", {"command":"argument-value"}, {"task_id":self.task["id"]}, path=ledger)
                observed_finished.append(finished.is_set()); wrote.set()
            worker=threading.Thread(target=inject); worker.start(); workers.append(worker)
            self.assertTrue(started.wait(1)); wrote.wait(0.1)
            return execution

        def finish_with_signal(*args, **kwargs):
            result=finish_original(*args, **kwargs); finished.set(); return result

        self.store.create_recovery_execution=create_with_late_effect
        self.store.finish_recovery_execution=finish_with_signal
        result=recovery.execute(self.task["id"],preview["id"],preview["preview_hash"],irreversible_acknowledged=True)
        workers[0].join(2)

        self.assertEqual("completed",result["status"])
        self.assertFalse(workers[0].is_alive())
        self.assertEqual([True],observed_finished)
        self.assertEqual("old",(root/"tracked.txt").read_text(encoding="utf-8"))

    def test_task_effect_does_not_execute_or_drop_its_record_inside_recovery_fence(self):
        """A task-bound real write waits for recovery, then persists its effect record."""
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        root=Path(work["root"]); ledger=self.base / "state" / "effects.jsonl"
        checkpoints=CheckpointService(self.store,ArtifactStore(self.base / "artifacts"))
        checkpoint=checkpoints.create(self.task["id"],work["id"],"manual",["tracked.txt"])
        (root/"tracked.txt").write_text("changed",encoding="utf-8")
        recovery=RecoveryService(self.store,checkpoints,effects_path=ledger); preview=recovery.preview(self.task["id"],checkpoint["id"])
        attempted=threading.Event(); finished=threading.Event(); observed_finished=[]; outcomes=[]; workers=[]
        create_original=self.store.create_recovery_execution; finish_original=self.store.finish_recovery_execution
        context=RunContext(self.task["id"],"run_late","1",work["id"],
                           {"mode":"collaborate","plan_files":("late-effect.txt",)})

        def create_with_real_effect(*args, **kwargs):
            execution=create_original(*args, **kwargs)
            def invoke():
                attempted.set()
                outcomes.append(agent._run_tool("write_file", {"path":"late-effect.txt","content":"late"},
                                                {"_run_context":context,"_approved_tools":{"write_file"}}, lambda *_: True, self.base / "agent.log"))
                observed_finished.append(finished.is_set())
            worker=threading.Thread(target=invoke); worker.start(); workers.append(worker)
            self.assertTrue(attempted.wait(1)); worker.join(1)
            return execution

        def finish_with_signal(*args, **kwargs):
            result=finish_original(*args, **kwargs); finished.set(); return result

        with mock.patch.object(effects,"EFFECTS_FILE",ledger), mock.patch.object(permission,"ROOT",root), \
             mock.patch.object(undo_checkpoint,"UNDO_DIR",self.base / "undo"), \
             mock.patch.dict(sys.modules, {
                 "harness.plan_gate": _allowing_plan_gate_module(),
                 "harness.run_policy": _allowing_run_policy_module(),
             }):
            self.store.create_recovery_execution=create_with_real_effect
            self.store.finish_recovery_execution=finish_with_signal
            result=recovery.execute(self.task["id"],preview["id"],preview["preview_hash"],irreversible_acknowledged=True)
            workers[0].join(3)

        self.assertEqual("completed",result["status"])
        self.assertFalse(workers[0].is_alive())
        self.assertEqual([True],observed_finished,outcomes)
        self.assertEqual([False], [outcomes[0][1]])
        self.assertEqual([True], [outcomes[0][2]])
        self.assertEqual("late",(root/"late-effect.txt").read_text(encoding="utf-8"))
        self.assertEqual(self.task["id"],effects.load(ledger)[0]["task_id"])

    def test_task_effect_keeps_pending_ledger_entry_when_completion_persistence_fails(self):
        """A real task effect remains reviewable if its final ledger write fails."""
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        root=Path(work["root"]); ledger=self.base / "state" / "effects.jsonl"
        checkpoints=CheckpointService(self.store,ArtifactStore(self.base / "artifacts"))
        checkpoint=checkpoints.create(self.task["id"],work["id"],"manual",["tracked.txt"])
        context=RunContext(self.task["id"],"run_pending","1",work["id"],
                           {"mode":"collaborate","plan_files":("pending-effect.txt",)})

        with mock.patch.object(effects,"EFFECTS_FILE",ledger), mock.patch.object(permission,"ROOT",root), mock.patch.object(undo_checkpoint,"UNDO_DIR",self.base / "undo"), \
             mock.patch.object(effects,"complete_task_effect",side_effect=effects.EffectRecordError("forced")), \
             mock.patch.dict(sys.modules, {
                 "harness.plan_gate": _allowing_plan_gate_module(),
                 "harness.run_policy": _allowing_run_policy_module(),
             }):
            _,is_error,executed=agent._run_tool("write_file", {"path":"pending-effect.txt","content":"written"},
                                                 {"_run_context":context,"_approved_tools":{"write_file"}}, lambda *_: True, self.base / "agent.log")

        self.assertTrue(is_error)
        self.assertTrue(executed)
        self.assertEqual("written",(root/"pending-effect.txt").read_text(encoding="utf-8"))
        records=effects.load(ledger)
        self.assertEqual(1,len(records))
        self.assertIsNone(records[0]["ok"])
        preview=RecoveryService(self.store,checkpoints,effects_path=ledger).preview(self.task["id"],checkpoint["id"])
        self.assertEqual("needs_review",preview["irreversible_effects"][0]["reason"])

    def test_task_bound_legacy_effect_is_unknown_and_requires_review(self):
        """Missing irreversibility metadata is never reclassified as a safe effect."""
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        checkpoints=CheckpointService(self.store,ArtifactStore(self.base / "artifacts"))
        checkpoint=checkpoints.create(self.task["id"],work["id"],"manual",["tracked.txt"])
        ledger=self.base / "state" / "effects.jsonl"
        effects.record_effect("run_command", {"command":"git status"}, {"task_id":self.task["id"]}, path=ledger)
        legacy=json.loads(ledger.read_text(encoding="utf-8")); legacy.pop("irreversible"); legacy.pop("irrev_why",None)
        ledger.write_text(json.dumps(legacy)+"\n",encoding="utf-8")

        preview=RecoveryService(self.store,checkpoints,effects_path=ledger).preview(self.task["id"],checkpoint["id"])

        self.assertEqual("unknown",preview["irreversible_effects"][0]["action"])
        self.assertEqual("needs_review",preview["irreversible_effects"][0]["reason"])
        self.assertEqual("unknown",preview["irreversible_effects"][0]["target"])
        self.assertTrue(preview["irreversible_ack_required"])

    def test_new_command_effect_uses_fixed_safe_summary_in_ledger_and_preview(self):
        """Command arguments must not survive in a recovery-facing effect record."""
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        checkpoints=CheckpointService(self.store,ArtifactStore(self.base / "artifacts"))
        checkpoint=checkpoints.create(self.task["id"],work["id"],"manual",["tracked.txt"])
        ledger=self.base / "state" / "effects.jsonl"; raw_command="argument-value"
        effects.record_effect("run_command", {"command":raw_command}, {"task_id":self.task["id"]}, path=ledger, action_id="act_safe")

        record=effects.load(ledger)[0]
        preview=RecoveryService(self.store,checkpoints,effects_path=ledger).preview(self.task["id"],checkpoint["id"])

        self.assertEqual("command",record["target"])
        self.assertNotIn(raw_command,json.dumps(record))
        self.assertEqual("command",preview["irreversible_effects"][0]["action"])
        self.assertEqual("command",preview["irreversible_effects"][0]["target"])

    def test_malformed_effect_record_is_needs_review_without_its_raw_target(self):
        """A ledger record with an invalid ID cannot expose its attacker-controlled target."""
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        checkpoints=CheckpointService(self.store,ArtifactStore(self.base / "artifacts"))
        checkpoint=checkpoints.create(self.task["id"],work["id"],"manual",["tracked.txt"])
        ledger=self.base / "state" / "effects.jsonl"; raw_target="untrusted-value"
        effects.record_effect("run_command", {"command":"ignored"}, {"task_id":self.task["id"]}, path=ledger)
        malformed=effects.load(ledger)[0]; malformed["id"]="invalid"; malformed["target"]=raw_target
        ledger.write_text(json.dumps(malformed)+"\n",encoding="utf-8")

        preview=RecoveryService(self.store,checkpoints,effects_path=ledger).preview(self.task["id"],checkpoint["id"])

        effect=preview["irreversible_effects"][0]
        self.assertEqual("unknown",effect["action"])
        self.assertEqual("unknown",effect["target"])
        self.assertEqual("needs_review",effect["reason"])
        self.assertNotIn(raw_target,json.dumps(effect))

    def test_task_bound_effect_missing_success_flag_is_needs_review(self):
        """An incomplete task-bound ledger item cannot be silently dropped as safe."""
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        checkpoints=CheckpointService(self.store,ArtifactStore(self.base / "artifacts"))
        checkpoint=checkpoints.create(self.task["id"],work["id"],"manual",["tracked.txt"])
        ledger=self.base / "state" / "effects.jsonl"
        effects.record_effect("run_command", {"command":"ignored"}, {"task_id":self.task["id"]}, path=ledger)
        malformed=effects.load(ledger)[0]; malformed.pop("ok")
        ledger.write_text(json.dumps(malformed)+"\n",encoding="utf-8")

        preview=RecoveryService(self.store,checkpoints,effects_path=ledger).preview(self.task["id"],checkpoint["id"])

        self.assertEqual("unknown",preview["irreversible_effects"][0]["action"])
        self.assertEqual("needs_review",preview["irreversible_effects"][0]["reason"])

    def test_new_native_text_effect_never_records_the_input_text(self):
        """Native text input receives a fixed category before it reaches the ledger."""
        ledger=self.base / "state" / "effects.jsonl"; raw_text="input-value"
        effects.record_effect("type_text", {"text":raw_text}, {"task_id":self.task["id"]}, path=ledger)

        record=effects.load(ledger)[0]

        self.assertEqual("native_ui",record["target"])
        self.assertNotIn(raw_text,json.dumps(record))

    def test_fork_keeps_source_and_records_immutable_relation(self):
        preflight=self.workspace_service.preflight(self.project["id"],self.task["id"])
        work=WorktreeManager(self.store,self.paths).create(self.task["id"],self.project["id"],self.repo,preflight.dirty_baseline,"HEAD")
        cp=CheckpointService(self.store,ArtifactStore(self.base / "artifacts")).create(self.task["id"],work["id"],"manual",["tracked.txt"])
        fork=TaskEngine(self.store).fork_from_checkpoint(self.task["id"],cp["id"],"alternative",self.task["version"])
        self.assertNotEqual(self.task["id"],fork["id"]); self.assertEqual("Draft",fork["status"])
        relation=self.store.list_task_relations(fork["id"])[0]
        self.assertEqual((fork["id"],self.task["id"],"forked_from"),(relation["source_task_id"],relation["target_task_id"],relation["kind"]))

    def test_api_exposes_preflight_workspace_checkpoint_recovery_and_fork(self):
        api=TaskAPI(self.store,workspace_root=self.repo)
        path=f"/api/v2/tasks/{self.task['id']}"
        response=api.dispatch("GET",path+"/workspace-preflight")
        self.assertEqual(200,response.status); self.assertIn("isolated",response.body["preflight"]["allowed_modes"])
        response=api.dispatch("POST",path+"/workspaces",{"mode":"isolated"})
        self.assertEqual(201,response.status); workspace=response.body["workspace"]
        response=api.dispatch("POST",path+"/checkpoints",{"workspace_id":workspace["id"],"kind":"manual","paths":["tracked.txt"]})
        self.assertEqual(201,response.status); checkpoint=response.body["checkpoint"]
        root=Path(workspace["root"]); (root/"tracked.txt").write_text("changed",encoding="utf-8")
        response=api.dispatch("POST",path+"/recovery-previews",{"checkpoint_id":checkpoint["id"]})
        self.assertEqual(201,response.status); preview=response.body["preview"]
        response=api.dispatch("POST",path+"/recovery-executions",{"preview_id":preview["id"],"preview_hash":preview["preview_hash"],"irreversible_effects_acknowledged":False})
        self.assertEqual(200,response.status); self.assertEqual("completed",response.body["recovery"]["status"])
        response=api.dispatch("POST",path+"/forks",{"checkpoint_id":checkpoint["id"],"title":"fork","expected_version":self.store.get_task(self.task["id"])["version"]})
        self.assertEqual(201,response.status); self.assertNotEqual(self.task["id"],response.body["task"]["id"])


if __name__ == "__main__": unittest.main()
