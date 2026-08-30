"""Persistent, fail-closed execution budget ledger for unattended Runs."""
from __future__ import annotations
from contextlib import contextmanager
from dataclasses import dataclass
from .task_store import _now

@dataclass
class BudgetExceeded(RuntimeError):
    code: str
    def __str__(self): return self.code

class BudgetLedger:
    LIMITS = {"wall_seconds": "BUDGET_WALL_CLOCK_EXCEEDED", "model_tokens": "BUDGET_MODEL_TOKENS_EXCEEDED",
              "cost_micros": "BUDGET_COST_EXCEEDED", "tool_calls": "BUDGET_TOOLS_EXCEEDED",
              "network_calls": "BUDGET_NETWORK_EXCEEDED", "repair_attempts": "BUDGET_ATTEMPTS_EXCEEDED"}
    def __init__(self, store, run_id: str, limits: dict[str, int]):
        self.store, self.run_id, self.limits = store, run_id, dict(limits)
    def used(self, kind: str) -> int:
        conn=self.store._connect()
        try:
            row=conn.execute("SELECT reserved,committed FROM run_budget_ledger WHERE run_id=? AND kind=?",(self.run_id,kind)).fetchone()
            return (row["reserved"]+row["committed"]) if row else 0
        finally: conn.close()
    @contextmanager
    def reserve(self, kind: str, amount: int = 1):
        limit=self.limits.get(kind)
        if limit is None or amount < 1: raise ValueError("BUDGET_LIMIT_INVALID")
        with self.store.transaction() as conn:
            row=conn.execute("SELECT reserved,committed FROM run_budget_ledger WHERE run_id=? AND kind=?",(self.run_id,kind)).fetchone()
            used=(row["reserved"]+row["committed"]) if row else 0
            if used+amount > limit: raise BudgetExceeded(self.LIMITS.get(kind,"BUDGET_EXCEEDED"))
            conn.execute("INSERT INTO run_budget_ledger(run_id,kind,reserved,committed,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(run_id,kind) DO UPDATE SET reserved=reserved+excluded.reserved,updated_at=excluded.updated_at",(self.run_id,kind,amount,0,_now()))
        ticket={"committed":False}
        try: yield ticket
        finally:
            with self.store.transaction() as conn:
                if ticket["committed"]:
                    conn.execute("UPDATE run_budget_ledger SET reserved=reserved-?,committed=committed+?,updated_at=? WHERE run_id=? AND kind=?",(amount,amount,_now(),self.run_id,kind))
                # Unknown crashed reservation stays reserved: never silently becomes spendable.
    def commit(self, ticket: dict): ticket["committed"]=True
    def evidence(self) -> dict:
        return {"run_id":self.run_id,"limits":self.limits,"used":{kind:self.used(kind) for kind in self.limits}}
