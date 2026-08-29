import hashlib
import tempfile
import threading
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from harness.inbox_adapters import (
    AttachmentMetadata,
    InboxRequest,
    InboxSecurityError,
    LocalInboxSession,
    LocalPWAInboxAdapter,
)
from harness.task_inbox import TaskInbox
from harness.task_model import CreateTask
from harness.task_store import TaskStore


NOW = datetime(2026, 8, 16, 8, 0, tzinfo=UTC)


class InboxAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temp.name) / "task.db")
        self.project = self.store.create_project("p", Path(self.temp.name))
        self.inbox = TaskInbox(self.store)
        self.session = LocalInboxSession.from_tokens(
            identity_id="device_alice",
            bearer_token="bearer-secret",
            csrf_token="csrf-secret",
            expires_at=NOW + timedelta(hours=1),
            project_ids=(self.project["id"],),
        )
        self.adapter = LocalPWAInboxAdapter(
            inbox=self.inbox,
            allowed_origin="https://xiaoshe.test",
            sessions=(self.session,),
            clock=lambda: NOW,
        )

    def tearDown(self):
        self.temp.cleanup()

    def request(self, *, key="idem-12345678", nonce="nonce-12345678", body=None, **overrides):
        values = dict(
            origin="https://xiaoshe.test",
            host="xiaoshe.test",
            fetch_site="same-origin",
            bearer_token="bearer-secret",
            csrf_token="csrf-secret",
            request_nonce=nonce,
            issued_at=NOW,
            idempotency_key=key,
            body=body or {
                "project_id": self.project["id"],
                "title": "整理发票",
                "goal": "把本周发票归档",
                "acceptance": ["生成清单"],
            },
        )
        values.update(overrides)
        return InboxRequest(**values)

    def submit(self, request):
        identity = self.adapter.authenticate(request)
        intent = self.adapter.normalize(request, identity)
        duplicate = self.adapter.deduplicate(intent)
        return self.adapter.submit(intent, duplicate)

    def test_authentication_fails_closed_for_origin_host_csrf_expiry_and_replay(self):
        for name, changes, code in (
            ("origin", {"origin": "https://evil.test"}, "INBOX_ORIGIN_DENIED"),
            ("host", {"host": "evil.test"}, "INBOX_HOST_DENIED"),
            ("fetch", {"fetch_site": "cross-site"}, "INBOX_CROSS_SITE"),
            ("csrf", {"csrf_token": "wrong"}, "INBOX_CSRF_DENIED"),
            ("bearer", {"bearer_token": "wrong"}, "INBOX_AUTH_DENIED"),
            ("future", {"issued_at": NOW + timedelta(minutes=6)}, "INBOX_TOKEN_EXPIRED"),
            ("old", {"issued_at": NOW - timedelta(minutes=6)}, "INBOX_TOKEN_EXPIRED"),
        ):
            with self.subTest(name=name), self.assertRaisesRegex(InboxSecurityError, code):
                self.adapter.authenticate(self.request(nonce=f"nonce-{name}-12345678", **changes))
        self.adapter.authenticate(self.request(nonce="nonce-replay-12345678"))
        with self.assertRaisesRegex(InboxSecurityError, "INBOX_REPLAYED"):
            self.adapter.authenticate(self.request(nonce="nonce-replay-12345678"))

    def test_normalize_rejects_commands_unknown_fields_cross_identity_task_and_unsafe_attachments(self):
        identity = self.adapter.authenticate(self.request(nonce="nonce-normalize-1"))
        bad_bodies = (
            ({"project_id": self.project["id"], "title": "x", "goal": "y", "tool": "shell"}, "INBOX_SCHEMA_INVALID"),
            ({"project_id": "prj_other", "title": "x", "goal": "y"}, "INBOX_PROJECT_DENIED"),
            ({"project_id": self.project["id"], "title": "x", "goal": "y", "attachments": [{"ref": "C:\\secret.txt", "mime": "text/plain", "size": 1}]}, "INBOX_ATTACHMENT_INVALID"),
            ({"project_id": self.project["id"], "title": "x", "goal": "y", "attachments": [{"ref": "att_abc12345", "mime": "application/x-msdownload", "size": 1}]}, "INBOX_ATTACHMENT_INVALID"),
            ({"project_id": self.project["id"], "title": "x", "goal": "y", "attachments": [{"ref": "att_abc12345", "mime": "image/png", "size": 10_000_001}]}, "INBOX_ATTACHMENT_INVALID"),
            ({"project_id": self.project["id"], "title": "x", "goal": "y", "attachments": [{"ref": "att_abc12345", "mime": "image/png", "size": 100}]}, "INBOX_ATTACHMENT_DENIED"),
        )
        for body, code in bad_bodies:
            with self.subTest(code=code), self.assertRaisesRegex(InboxSecurityError, code):
                self.adapter.normalize(self.request(body=body), identity)

        other = self.store.create_project("other", Path(self.temp.name) / "other")
        task = self.store.create_task(CreateTask(other["id"], "x", "y", ()))
        with self.assertRaisesRegex(InboxSecurityError, "INBOX_TASK_DENIED"):
            self.adapter.normalize(self.request(body={"project_id": self.project["id"], "task_id": task["id"], "title": "x", "goal": "y"}), identity)

    def test_attachment_metadata_is_server_trusted_and_client_mismatch_is_rejected(self):
        calls = []
        adapter = LocalPWAInboxAdapter(
            inbox=self.inbox, allowed_origin="https://xiaoshe.test", sessions=(self.session,), clock=lambda: NOW,
            attachment_metadata=lambda identity, project, ref: calls.append((identity, project, ref)) or
                AttachmentMetadata(ref, "image/png", 100, "a" * 64),
        )
        request = self.request(nonce="nonce-attachment-1", body={
            "project_id": self.project["id"], "title": "x", "goal": "y",
            "attachments": [{"ref": "att_allowed123", "mime": "image/png", "size": 100}],
        })
        identity = adapter.authenticate(request)
        intent = adapter.normalize(request, identity)
        self.assertEqual("att_allowed123", intent.attachments[0].ref)
        self.assertEqual("a" * 64, intent.attachments[0].sha256)
        self.assertEqual([(self.session.identity_id, self.project["id"], "att_allowed123")], calls)
        for field, value in (("mime", "image/jpeg"), ("size", 99), ("sha256", "b" * 64)):
            body = dict(request.body)
            body["attachments"] = [dict(request.body["attachments"][0], **{field: value})]
            with self.subTest(field=field), self.assertRaisesRegex(InboxSecurityError, "INBOX_ATTACHMENT_MISMATCH"):
                adapter.normalize(self.request(body=body), identity)

    def test_duplicate_is_durable_and_conflict_is_rejected_across_restart(self):
        first = self.submit(self.request(nonce="nonce-submit-1"))
        self.assertEqual("accepted", first.status)
        self.assertFalse(first.duplicate)

        restarted = LocalPWAInboxAdapter(
            inbox=TaskInbox(TaskStore(self.store.db_path)),
            allowed_origin="https://xiaoshe.test", sessions=(self.session,), clock=lambda: NOW,
        )
        request = self.request(nonce="nonce-submit-2")
        identity = restarted.authenticate(request)
        intent = restarted.normalize(request, identity)
        receipt = restarted.submit(intent, restarted.deduplicate(intent))
        self.assertTrue(receipt.duplicate)
        self.assertEqual(first.receipt_id, receipt.receipt_id)

        conflicting = self.request(nonce="nonce-submit-3", body={
            "project_id": self.project["id"], "title": "不同", "goal": "不同",
        })
        identity = restarted.authenticate(conflicting)
        intent = restarted.normalize(conflicting, identity)
        with self.assertRaisesRegex(InboxSecurityError, "INBOX_IDEMPOTENCY_CONFLICT"):
            restarted.deduplicate(intent)

    def test_concurrent_duplicate_sync_creates_one_intent_and_one_receipt(self):
        barrier = threading.Barrier(8)
        receipts = []
        errors = []

        def worker(index):
            try:
                adapter = LocalPWAInboxAdapter(
                    inbox=TaskInbox(TaskStore(self.store.db_path)), allowed_origin="https://xiaoshe.test",
                    sessions=(self.session,), clock=lambda: NOW,
                )
                request = self.request(nonce=f"nonce-concurrent-{index}")
                identity = adapter.authenticate(request)
                intent = adapter.normalize(request, identity)
                barrier.wait()
                receipts.append(adapter.submit(intent, adapter.deduplicate(intent)))
            except Exception as exc:  # surfaced in the parent assertion
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(index,)) for index in range(8)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual([], errors)
        self.assertEqual(1, len({receipt.receipt_id for receipt in receipts}))
        self.assertEqual(1, sum(not receipt.duplicate for receipt in receipts))
        self.assertEqual(1, self.inbox.pending_intent_count())

    def test_receipt_and_repr_do_not_echo_tokens_or_user_body(self):
        receipt = self.submit(self.request(nonce="nonce-redact-1", body={
            "project_id": self.project["id"], "title": "<img src=x onerror=alert(1)>", "goal": "private text",
        }))
        public = repr(receipt) + repr(self.session)
        for secret in ("bearer-secret", "csrf-secret", "private text", "<img"):
            self.assertNotIn(secret, public)
        self.assertEqual("accepted", receipt.status)


if __name__ == "__main__":
    unittest.main()
