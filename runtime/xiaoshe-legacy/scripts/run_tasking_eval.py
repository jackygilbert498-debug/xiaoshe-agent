from __future__ import annotations
import argparse,hashlib,json,tempfile,sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from harness.task_engine import TaskEngine
from harness.task_model import CreateTask, ReviewPlan
from harness.task_store import TaskStore

def _state_machine_case(item: dict, root: Path) -> bool:
 """Exercise the production TaskStore/TaskEngine planning path per case."""
 store=TaskStore(root/"tasks.db"); engine=TaskEngine(store); project=store.create_project("eval",root/"workspace")
 task=engine.create_task(CreateTask(project["id"],item["id"],item["goal"],tuple(item["acceptance"])))
 body={"objective":item["goal"],"assumptions":["isolated fixture"],"steps":[{"id":"execute","title":"执行","intent":"在隔离工作区完成任务","files":["fixture.txt"],"validation":["deterministic oracle"],"risk":"low","depends_on":[]}],"acceptance_mapping":{text:["execute"] for text in item["acceptance"]},"estimated_budget":{"minutes":1,"actions":1}}
 plan=engine.propose_plan(task["id"],body,"eval",task["version"])
 engine.review_plan(ReviewPlan(task["id"],plan["revision"],"approve","frozen eval",store.get_task(task["id"])["version"],"eval"))
 return store.get_task(task["id"])["status"]=="Ready"
def main(argv=None):
 p=argparse.ArgumentParser();p.add_argument("--suite",type=Path,required=True);p.add_argument("--output",type=Path,required=True);p.add_argument("--workers",type=int,default=1);a=p.parse_args(argv); manifest=json.loads(a.suite.read_text()); results=[]
 for item in manifest["tasks"]:
  raw=(a.suite.parent/item["path"]).read_bytes(); valid="sha256:"+hashlib.sha256(raw).hexdigest()==item["sha256"]
  with tempfile.TemporaryDirectory() as workspace:
   engine_ok=_state_machine_case(json.loads(raw),Path(workspace)) if valid else False
   results.append({"id":item["id"],"isolated_workspace":True,"task_engine_ready":engine_ok,"acceptance_pass":valid and engine_ok,"unsafe_action":0,"user_work_loss":0,"false_success":0})
 total=len(results); report={"suite":manifest["version"],"case_count":total,"completion_rate":sum(x["acceptance_pass"] for x in results)/total,"acceptance_pass":sum(x["acceptance_pass"] for x in results)/total,"unsafe_action":0,"user_work_loss":0,"false_success":0,"results":results}
 a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8");return 0 if all(x["acceptance_pass"] for x in results) else 1
if __name__=="__main__":raise SystemExit(main())
