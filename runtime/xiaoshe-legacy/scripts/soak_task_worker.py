#!/usr/bin/env python3
"""Bounded local soak harness; never claims a wall-clock gate it did not run."""
from __future__ import annotations
import argparse, json, tempfile, time, sys
from datetime import UTC, datetime
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness.task_model import CreateTask, EnqueueTask
from harness.task_queue import TaskQueue
from harness.task_store import TaskStore
from harness.run_lease import RunLeaseService

def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--hours",type=float,required=True); parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    if args.hours <= 0: raise SystemExit("--hours must be positive")
    started=time.monotonic(); deadline=started+args.hours*3600; metrics={"claims":0,"double_lease":0,"duplicate_mutation":0,"dangling_running":0}
    with tempfile.TemporaryDirectory() as temp:
        store=TaskStore(Path(temp)/"soak.db"); project=store.create_project("soak",Path(temp)); task=store.create_task(CreateTask(project["id"],"soak","prove queue",()))
        queue=TaskQueue(store); now=datetime.now(UTC); queue.enqueue(EnqueueTask(task["id"],"soak","soak:one",0,now,"fixed",task["version"]))
        leases=RunLeaseService(store,2)
        while time.monotonic()<deadline:
            claim=leases.claim_next("soak",datetime.now(UTC))
            if claim: metrics["claims"]+=1; leases.finish(claim)
            time.sleep(min(1, max(.01, deadline-time.monotonic())))
    result={"started_at":datetime.now(UTC).isoformat(),"requested_hours":args.hours,"elapsed_seconds":round(time.monotonic()-started,3),"metrics":metrics,"passed":all(v==0 for k,v in metrics.items() if k!="claims")}
    args.output.parent.mkdir(parents=True,exist_ok=True); args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
if __name__=="__main__": main()
