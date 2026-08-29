from __future__ import annotations
import subprocess,tempfile,unittest
from pathlib import Path
from harness.task_store import TaskStore
from harness.task_engine import TaskEngine
from harness.task_model import CreateTask,StartRun,FinishRun,RunStatus,TaskStatus
from harness.task_api import TaskAPI
from harness.verification_discovery import discover
from harness.verification_trust import VerificationTrustStore
from harness.verification import VerificationService

class VerificationServiceTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name)/'repo'; self.root.mkdir(); subprocess.run(['git','init','-q',str(self.root)],check=True); (self.root/'a.py').write_text('x=1\n'); (self.root/'pyproject.toml').write_text('[build-system]\n'); (self.root/'test_ok.py').write_text('import unittest\nclass Ok(unittest.TestCase):\n def test_ok(self): self.assertTrue(True)\n'); subprocess.run(['git','-C',str(self.root),'add','.'],check=True); subprocess.run(['git','-C',str(self.root),'-c','user.name=t','-c','user.email=t@x','commit','-qm','base'],check=True)
  self.store=TaskStore(Path(self.temp.name)/'tasks.sqlite'); self.engine=TaskEngine(self.store); self.api=TaskAPI(self.store,self.engine); project=self.store.create_project('p',self.root); task=self.engine.create_task(CreateTask(project['id'],'t','g',('tests',))); ready=self.engine.transition(task['id'],TaskStatus.READY,task['version'],'u'); self.task,self.run=self.engine.start_run(StartRun(ready['id'],ready['version'],'a')); (self.root/'a.py').write_text('x=2\n'); self.task,self.run=self.engine.finish_run(FinishRun(self.run['id'],self.task['version'],'a',RunStatus.COMPLETED)); cs=self.store.current_changeset(self.task['id']); self.task,_,_=self.engine.apply_review_decision(task_id=self.task['id'],changeset_id=cs['id'],request_id='req_1',decision='approve',feedback='ok',diff_hash=cs['diff_hash'],workspace_version=cs['workspace_version'],expected_version=self.task['version'],actor='u'); self.profile=discover(self.root)[0].profile; candidate=discover(self.root)[0]; VerificationTrustStore(self.store).approve(project['id'],self.profile,candidate.source_hashes,'u')
 def tearDown(self): self.temp.cleanup()
 def test_runs_trusted_checks_persists_uncovered_acceptance_without_false_success(self):
  result=VerificationService(self.store).run(self.task['id'],self.profile,self.task['version'])
  self.assertEqual('passed',result['verification']['status']); self.assertFalse(result['decision']['allowed']); self.assertIsNone(result['proof']); self.assertEqual('not_covered',result['coverage'][0]['status'])
 def test_untrusted_profile_cannot_run(self):
  self.store.revoke_verification_profile(self.store.get_verification_profile(self.task['project_id'],__import__('harness.verification_model',fromlist=['profile_checksum']).profile_checksum(self.profile))['id'])
  with self.assertRaisesRegex(Exception,'UNTRUSTED'): VerificationService(self.store).run(self.task['id'],self.profile,self.task['version'])
