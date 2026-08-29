from __future__ import annotations
import hashlib,subprocess,tempfile,unittest
from pathlib import Path
from harness.task_api import TaskAPI
from harness.task_engine import TaskEngine
from harness.task_model import CreateTask,FinishRun,RunStatus
from harness.task_store import TaskStore
from harness.project_memory import ProjectMemoryStore
from harness.verification import VerificationService
from harness.verification_model import normalize_profile
from harness.verification_trust import VerificationTrustStore

def plan(): return {'objective':'验证','assumptions':[],'steps':[{'id':'implement','title':'改动','intent':'改动','files':['a.py'],'validation':['unit'],'risk':'low','depends_on':[]}],'acceptance_mapping':{'tests':['implement']},'estimated_budget':{}}
def profile(argv): return {'name':'p','checks':[{'id':'unit','name':'unit','argv':argv,'cwd':'.','timeout_seconds':30,'env_allowlist':['PATH'],'network':'deny','required':True}]}

class CompletionLoopTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name)/'repo'; self.root.mkdir(); subprocess.run(['git','init','-q',str(self.root)],check=True); (self.root/'a.py').write_text('x=1\n'); subprocess.run(['git','-C',str(self.root),'add','a.py'],check=True); subprocess.run(['git','-C',str(self.root),'-c','user.name=t','-c','user.email=t@x','commit','-qm','base'],check=True); self.store=TaskStore(Path(self.temp.name)/'t.sqlite'); self.engine=TaskEngine(self.store); TaskAPI(self.store,self.engine); self.project=self.store.create_project('p',self.root)
 def tearDown(self): self.temp.cleanup()
 def ready_for_verify(self):
  task=self.engine.create_task(CreateTask(self.project['id'],'t','g',('tests',))); proposed=self.engine.propose_plan(task['id'],plan(),'a',task['version']); task=self.store.get_task(task['id']); self.engine.review_plan(__import__('harness.task_model',fromlist=['ReviewPlan']).ReviewPlan(task['id'],proposed['revision'],'approve','ok',task['version'],'u')); task=self.store.get_task(task['id']); task,run=self.engine.start_run(__import__('harness.task_model',fromlist=['StartRun']).StartRun(task['id'],task['version'],'a')); (self.root/'a.py').write_text('x=2\n'); task,run=self.engine.finish_run(FinishRun(run['id'],task['version'],'a',RunStatus.COMPLETED)); cs=self.store.current_changeset(task['id']); task,_,_=self.engine.apply_review_decision(task_id=task['id'],changeset_id=cs['id'],request_id='req_r',decision='approve',feedback='ok',diff_hash=cs['diff_hash'],workspace_version=cs['workspace_version'],expected_version=task['version'],actor='u'); return task
 def trust(self,p): VerificationTrustStore(self.store).approve(self.project['id'],p,{'a.py':hashlib.sha256((self.root/'a.py').read_bytes()).hexdigest()},'u')
 def test_success_event_references_proof_after_all_green(self):
  task=self.ready_for_verify(); p=normalize_profile(profile(['python','-c','print(1)']),self.root); self.trust(p); result=VerificationService(self.store).run(task['id'],p,task['version']); done=self.engine.complete_task(task['id'],self.store.get_task(task['id'])['version'],'u',result['proof']['id']); self.assertEqual('Succeeded',done['status']); self.assertIn('completion_input_hash',self.store.list_events(task['id'])[-2]['payload_json']); candidates=ProjectMemoryStore(self.store).list(self.project['id']); self.assertEqual(('candidate','项目验收约定：tests'),(candidates[0].status,candidates[0].text))
 def test_failed_check_returns_review_then_starts_repair_attempt(self):
  task=self.ready_for_verify(); p=normalize_profile(profile(['python','-c','import sys;sys.exit(2)']),self.root); self.trust(p); result=VerificationService(self.store).run(task['id'],p,task['version']); self.assertEqual('Review',result['task']['status']); repaired,run=self.engine.start_repair_from_verification(task['id'],result['task']['version'],'u','修复后重跑'); self.assertEqual('Running',repaired['status']); self.assertEqual(2,run['attempt'])
if __name__ == '__main__': unittest.main()
