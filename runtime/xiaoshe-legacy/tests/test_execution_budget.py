import tempfile
import unittest
from pathlib import Path
from harness.execution_budget import BudgetExceeded, BudgetLedger
from harness.task_model import CreateTask, StartRun
from harness.task_store import TaskStore

class ExecutionBudgetTests(unittest.TestCase):
 def test_reservation_prevents_overspend_and_unknown_reservation_stays_conservative(self):
  with tempfile.TemporaryDirectory() as temp:
   store=TaskStore(Path(temp)/"t.db"); project=store.create_project("p",Path(temp)); task=store.create_task(CreateTask(project["id"],"t","g",("a",)))
   ready=store.transition_task(task["id"],task["version"],"Ready","test"); _,run=store.start_run(StartRun(ready["id"],ready["version"],"test"))
   ledger=BudgetLedger(store,run["id"],{"tool_calls":1})
   with ledger.reserve("tool_calls") as ticket: ledger.commit(ticket)
   with self.assertRaisesRegex(BudgetExceeded,"BUDGET_TOOLS_EXCEEDED"):
    with ledger.reserve("tool_calls"): pass

 def test_model_and_cost_limits_use_the_same_durable_ledger(self):
  with tempfile.TemporaryDirectory() as temp:
   store=TaskStore(Path(temp)/"t.db"); project=store.create_project("p",Path(temp)); task=store.create_task(CreateTask(project["id"],"t","g",("a",)))
   ready=store.transition_task(task["id"],task["version"],"Ready","test"); _,run=store.start_run(StartRun(ready["id"],ready["version"],"test"))
   ledger=BudgetLedger(store,run["id"],{"model_tokens":2,"cost_micros":3})
   with ledger.reserve("model_tokens",2) as ticket: ledger.commit(ticket)
   with self.assertRaisesRegex(BudgetExceeded,"BUDGET_MODEL_TOKENS_EXCEEDED"):
    with ledger.reserve("model_tokens"): pass
   with ledger.reserve("cost_micros",3) as ticket: ledger.commit(ticket)
   self.assertEqual(3,ledger.evidence()["used"]["cost_micros"])
