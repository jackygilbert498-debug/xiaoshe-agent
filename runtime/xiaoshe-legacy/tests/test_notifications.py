import unittest
from harness.notifications import NotificationService

class NotificationTests(unittest.TestCase):
    def test_notification_contains_no_hostile_task_payload_and_is_idempotent(self):
        service=NotificationService(); receipt=service.notify("evt_1","tsk_safe","WaitingUser")
        self.assertEqual(receipt,service.notify("evt_1","tsk_safe","WaitingUser"))
        self.assertNotIn("secret.py",receipt.title+receipt.body+receipt.deep_link)
        self.assertNotIn("C:/",receipt.title+receipt.body+receipt.deep_link)
