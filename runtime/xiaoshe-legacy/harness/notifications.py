"""Privacy-preserving task reminders; notifications are never evidence payloads."""
from __future__ import annotations
import secrets
from dataclasses import dataclass

@dataclass(frozen=True)
class NotificationReceipt:
    event_id: str; title: str; body: str; deep_link: str; sent: bool

class NotificationService:
    def __init__(self): self._seen: dict[str, NotificationReceipt] = {}
    def notify(self, event_id: str, task_id: str, status: str) -> NotificationReceipt:
        if event_id in self._seen: return self._seen[event_id]
        body = {"WaitingUser": "需要回答或确认", "Review": "改动等待审查", "Verifying": "验证需要关注"}.get(status, "任务状态已更新")
        receipt = NotificationReceipt(event_id, "小蛇任务需要你处理", body, f"xiaoshe://task/{secrets.token_urlsafe(24)}", True)
        self._seen[event_id] = receipt
        return receipt
