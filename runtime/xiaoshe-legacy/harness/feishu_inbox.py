"""Fail-closed Feishu webhook ingress for the common task inbox.

The adapter authenticates and normalizes a callback into a durable ``TaskIntent``.
It never runs a tool, starts a task, or turns remote text into a local approval.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import sqlite3
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Callable, Mapping, Sequence

from .inbox_adapters import (
    AttachmentMetadata,
    AttachmentRef,
    InboxReceipt,
    InboxSecurityError,
    TaskIntent,
)
from .model_secrets import SecretStore, SecretStoreError
from .task_inbox import TaskInbox

_MAX_BODY = 1 << 20
_MAX_CLOCK_SKEW = timedelta(minutes=5)
_PENDING_RECOVERY_WINDOWS = 12
_EXPIRED_RETENTION_WINDOWS = 24
_HEADER_VALUE = re.compile(r"^[\x21-\x7e]{1,256}$")
_EVENT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_:\-]{7,255}$")
_FEISHU_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_:\-]{2,255}$")
_PROJECT_ID = re.compile(r"^prj_[A-Za-z0-9_-]{8,128}$")
_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,512}$")
_ALLOWED_EVENT = "im.message.receive_v1"
_ALLOWED_CLASSIFICATIONS = frozenset({"accepted", "waiting_user", "completed", "failed", "outcome_unknown"})


@dataclass(frozen=True, repr=False)
class FeishuConfig:
    enabled: bool
    verification_token: str
    encrypt_key: str
    tenant_key: str
    app_id: str
    bot_open_id: str
    project_id: str
    allowed_senders: tuple[str, ...]
    allowed_chats: tuple[str, ...]
    timestamp_window_seconds: int = 300
    nonce_ledger_limit: int = 10_000

    def __post_init__(self) -> None:
        if not self.enabled:
            raise ValueError("disabled configuration must not be instantiated")
        if not self.verification_token or not self.encrypt_key:
            raise ValueError("missing protected Feishu credentials")
        if not all((_FEISHU_ID.fullmatch(self.tenant_key), _FEISHU_ID.fullmatch(self.app_id),
                    _FEISHU_ID.fullmatch(self.bot_open_id),
                    _PROJECT_ID.fullmatch(self.project_id), self.allowed_senders, self.allowed_chats)):
            raise ValueError("incomplete Feishu allowlist configuration")
        if any(not _FEISHU_ID.fullmatch(item) for item in (*self.allowed_senders, *self.allowed_chats)):
            raise ValueError("invalid Feishu allowlist configuration")
        if not 1 <= self.timestamp_window_seconds <= 900:
            raise ValueError("invalid Feishu timestamp window")
        if not 1 <= self.nonce_ledger_limit <= 100_000:
            raise ValueError("invalid Feishu nonce ledger limit")

    def __repr__(self) -> str:
        return "FeishuConfig(enabled=True, credentials=<redacted>, allowlists=<redacted>)"


@dataclass(frozen=True, repr=False)
class FeishuWebhookRequest:
    headers: Mapping[str, str]
    body: bytes

    def __repr__(self) -> str:
        return "FeishuWebhookRequest(<redacted>)"


@dataclass(frozen=True)
class FeishuWebhookResponse:
    status_code: int
    public_body: dict[str, object]


@dataclass(frozen=True)
class FeishuDeliveryResult:
    status: str
    attempts: int


def _csv(value: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(item.strip() for item in value.split(",") if item.strip()))


def load_feishu_config(*, getter: Callable[[str, str], str], secret_store: SecretStore) -> FeishuConfig | None:
    """Return a complete enabled config or ``None``; partial setup never opens the route."""
    if getter("FEISHU_INBOX_ENABLED", "false").strip().lower() not in {"1", "true", "yes", "on"}:
        return None
    verification_ref = getter("FEISHU_VERIFICATION_TOKEN_REF", "").strip()
    encrypt_ref = getter("FEISHU_ENCRYPT_KEY_REF", "").strip()
    if not verification_ref or not encrypt_ref:
        return None
    try:
        verification_token = secret_store.get(verification_ref)
        encrypt_key = secret_store.get(encrypt_ref)
    except (SecretStoreError, ValueError):
        return None
    values = {
        "tenant_key": getter("FEISHU_TENANT_KEY", "").strip(),
        "app_id": getter("FEISHU_APP_ID", "").strip(),
        "bot_open_id": getter("FEISHU_BOT_OPEN_ID", "").strip(),
        "project_id": getter("FEISHU_PROJECT_ID", "").strip(),
        "allowed_senders": _csv(getter("FEISHU_ALLOWED_SENDERS", "")),
        "allowed_chats": _csv(getter("FEISHU_ALLOWED_CHATS", "")),
    }
    if not verification_token or not encrypt_key or not all(values.values()):
        return None
    try:
        return FeishuConfig(
            enabled=True,
            verification_token=verification_token,
            encrypt_key=encrypt_key,
            timestamp_window_seconds=int(getter("FEISHU_TIMESTAMP_WINDOW_SECONDS", "300")),
            nonce_ledger_limit=int(getter("FEISHU_NONCE_LEDGER_LIMIT", "10000")),
            **values,
        )
    except (TypeError, ValueError):
        return None


def _header(headers: Mapping[str, str], name: str) -> str:
    value = next((str(value) for key, value in headers.items() if key.lower() == name.lower()), "")
    if not _HEADER_VALUE.fullmatch(value):
        raise InboxSecurityError("FEISHU_HEADERS_INVALID")
    return value


def _json_object(raw: bytes, code: str) -> dict:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise InboxSecurityError(code) from None
    if not isinstance(value, dict):
        raise InboxSecurityError(code)
    return value


def _constant_token(actual: object, expected: str) -> bool:
    return isinstance(actual, str) and hmac.compare_digest(actual.encode("utf-8"), expected.encode("utf-8"))


class FeishuInboxAdapter:
    name = "feishu"

    def __init__(self, *, inbox: TaskInbox, config: FeishuConfig,
                 clock: Callable[[], datetime] | None = None,
                 decryptor: Callable[[str, str], bytes] | None = None,
                 attachment_metadata: Callable[[str, str], AttachmentMetadata | None] | None = None):
        self.inbox = inbox
        self.config = config
        self.clock = clock or (lambda: datetime.now(UTC))
        self.decryptor = decryptor or decrypt_feishu_payload
        self.attachment_metadata = attachment_metadata or (lambda message_id, key: None)
        self._initialize_delivery_ledger()

    def __repr__(self) -> str:
        return "FeishuInboxAdapter(configured=<redacted>)"

    def handle(self, request: FeishuWebhookRequest) -> FeishuWebhookResponse:
        timestamp, nonce = self._verify_transport(request)
        body_digest = hashlib.sha256(request.body).hexdigest()
        outer = _json_object(request.body, "FEISHU_SCHEMA_INVALID")
        payload = self._decrypt(outer)
        token = payload.get("token")
        if token is None and isinstance(payload.get("header"), Mapping):
            token = payload["header"].get("token")
        if not _constant_token(token, self.config.verification_token):
            raise InboxSecurityError("FEISHU_TOKEN_INVALID")
        if payload.get("type") == "url_verification":
            challenge = payload.get("challenge")
            if not isinstance(challenge, str) or not 1 <= len(challenge) <= 256:
                raise InboxSecurityError("FEISHU_SCHEMA_INVALID")
            cached = self._begin_request(nonce, timestamp, body_digest)
            if cached is not None:
                return cached
            return self._complete_request(
                nonce, body_digest, FeishuWebhookResponse(200, {"challenge": challenge}))
        return self._handle_event(payload, nonce, timestamp, body_digest)

    @property
    def _namespace(self) -> str:
        return hashlib.sha256(
            (self.config.tenant_key + "\0" + self.config.app_id).encode("utf-8")
        ).hexdigest()

    @property
    def _pending_recovery_ttl_seconds(self) -> int:
        return self.config.timestamp_window_seconds * _PENDING_RECOVERY_WINDOWS

    @property
    def _pending_quota(self) -> int:
        return max(1, min(1_000, self.config.nonce_ledger_limit // 4))

    def _ledger_connection(self):
        connection = sqlite3.connect(self.inbox.store.db_path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=5000")
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def _initialize_delivery_ledger(self) -> None:
        connection = self._ledger_connection()
        try:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS feishu_callback_nonces (
                    namespace TEXT NOT NULL,
                    nonce_digest TEXT NOT NULL,
                    issued_at INTEGER NOT NULL,
                    accepted_at INTEGER NOT NULL,
                    body_digest TEXT NOT NULL DEFAULT '',
                    state TEXT NOT NULL DEFAULT 'legacy',
                    result_json TEXT,
                    PRIMARY KEY(namespace, nonce_digest)
                );
                CREATE INDEX IF NOT EXISTS feishu_callback_nonces_expiry
                    ON feishu_callback_nonces(namespace, issued_at);
                CREATE TABLE IF NOT EXISTS feishu_event_deliveries (
                    namespace TEXT NOT NULL,
                    event_digest TEXT NOT NULL,
                    message_digest TEXT NOT NULL,
                    received_at INTEGER NOT NULL,
                    PRIMARY KEY(namespace, event_digest)
                );
            """)
            columns = {
                row[1] for row in connection.execute("PRAGMA table_info(feishu_callback_nonces)")
            }
            for name, declaration in (
                ("body_digest", "TEXT NOT NULL DEFAULT ''"),
                ("state", "TEXT NOT NULL DEFAULT 'legacy'"),
                ("result_json", "TEXT"),
            ):
                if name not in columns:
                    connection.execute(
                        f"ALTER TABLE feishu_callback_nonces ADD COLUMN {name} {declaration}")
        finally:
            connection.close()

    def _prune_and_bound(self, connection: sqlite3.Connection, now: int) -> tuple[int, int]:
        cutoff = now - self.config.timestamp_window_seconds
        pending_cutoff = now - self._pending_recovery_ttl_seconds
        expired_cutoff = now - (
            self.config.timestamp_window_seconds * _EXPIRED_RETENTION_WINDOWS)
        # Pending requests get a longer recovery window than ordinary callback
        # replay data, but cannot retain capacity forever. Expired rows retain
        # only hashes/state long enough to give an explicit replay result.
        connection.execute(
            "UPDATE feishu_callback_nonces SET state='expired',result_json=NULL "
            "WHERE namespace=? AND state='pending' AND accepted_at<?",
            (self._namespace, pending_cutoff),
        )
        connection.execute(
            "DELETE FROM feishu_callback_nonces "
            "WHERE namespace=? AND state IN ('done','legacy') AND issued_at<?",
            (self._namespace, cutoff),
        )
        connection.execute(
            "DELETE FROM feishu_callback_nonces "
            "WHERE namespace=? AND state='expired' AND accepted_at<?",
            (self._namespace, expired_cutoff),
        )
        active = connection.execute(
            "SELECT COUNT(*) FROM feishu_callback_nonces "
            "WHERE namespace=? AND state!='expired'",
            (self._namespace,),
        ).fetchone()[0]
        pending = connection.execute(
            "SELECT COUNT(*) FROM feishu_callback_nonces "
            "WHERE namespace=? AND state='pending'",
            (self._namespace,),
        ).fetchone()[0]
        return active, pending

    @staticmethod
    def _decode_result(raw: str) -> FeishuWebhookResponse:
        try:
            value = json.loads(raw)
            status_code, public_body = value["status_code"], value["public_body"]
        except (TypeError, KeyError, json.JSONDecodeError):
            raise InboxSecurityError("FEISHU_REPLAY_STATE_INVALID") from None
        if not isinstance(status_code, int) or not isinstance(public_body, dict):
            raise InboxSecurityError("FEISHU_REPLAY_STATE_INVALID")
        return FeishuWebhookResponse(status_code, public_body)

    def _begin_request(self, nonce: str, timestamp: str,
                       body_digest: str) -> FeishuWebhookResponse | None:
        issued_at = int(timestamp)
        now = int(self.clock().astimezone(UTC).timestamp())
        nonce_digest = hashlib.sha256(nonce.encode("utf-8")).hexdigest()
        connection = self._ledger_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            count, pending_count = self._prune_and_bound(connection, now)
            row = connection.execute(
                "SELECT body_digest,state,result_json FROM feishu_callback_nonces "
                "WHERE namespace=? AND nonce_digest=?",
                (self._namespace, nonce_digest),
            ).fetchone()
            if row is not None:
                if not row["body_digest"] or not hmac.compare_digest(row["body_digest"], body_digest):
                    connection.execute("ROLLBACK")
                    raise InboxSecurityError("FEISHU_REPLAYED")
                connection.execute("COMMIT")
                if row["state"] == "done" and isinstance(row["result_json"], str):
                    return self._decode_result(row["result_json"])
                if row["state"] == "expired":
                    raise InboxSecurityError("FEISHU_REPLAY_EXPIRED")
                if row["state"] != "pending":
                    raise InboxSecurityError("FEISHU_REPLAY_STATE_INVALID")
                return None
            if count >= self.config.nonce_ledger_limit:
                connection.execute("ROLLBACK")
                raise InboxSecurityError("FEISHU_REPLAY_LEDGER_FULL")
            if pending_count >= self._pending_quota:
                connection.execute("ROLLBACK")
                raise InboxSecurityError("FEISHU_REPLAY_PENDING_FULL")
            connection.execute(
                "INSERT INTO feishu_callback_nonces "
                "(namespace,nonce_digest,issued_at,accepted_at,body_digest,state,result_json) "
                "VALUES (?,?,?,?,?,'pending',NULL)",
                (self._namespace, nonce_digest, issued_at, now, body_digest),
            )
            connection.execute("COMMIT")
        except sqlite3.IntegrityError:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise InboxSecurityError("FEISHU_REPLAYED") from None
        finally:
            connection.close()
        return None

    def _complete_request(self, nonce: str, body_digest: str,
                          response: FeishuWebhookResponse) -> FeishuWebhookResponse:
        nonce_digest = hashlib.sha256(nonce.encode("utf-8")).hexdigest()
        result_json = json.dumps({
            "status_code": response.status_code,
            "public_body": response.public_body,
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        connection = self._ledger_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT body_digest,state,result_json FROM feishu_callback_nonces "
                "WHERE namespace=? AND nonce_digest=?",
                (self._namespace, nonce_digest),
            ).fetchone()
            if row is None or not hmac.compare_digest(row["body_digest"], body_digest):
                connection.execute("ROLLBACK")
                raise InboxSecurityError("FEISHU_REPLAY_STATE_INVALID")
            if row["state"] == "done":
                connection.execute("COMMIT")
                return self._decode_result(row["result_json"])
            if row["state"] != "pending":
                connection.execute("ROLLBACK")
                raise InboxSecurityError("FEISHU_REPLAY_STATE_INVALID")
            connection.execute(
                "UPDATE feishu_callback_nonces SET state='done',result_json=? "
                "WHERE namespace=? AND nonce_digest=?",
                (result_json, self._namespace, nonce_digest),
            )
            connection.execute("COMMIT")
            return response
        finally:
            connection.close()

    def _record_event_delivery(self, event_id: str, message_id: str) -> None:
        event_digest = hashlib.sha256(event_id.encode("utf-8")).hexdigest()
        message_digest = hashlib.sha256(message_id.encode("utf-8")).hexdigest()
        now = int(self.clock().astimezone(UTC).timestamp())
        connection = self._ledger_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT message_digest FROM feishu_event_deliveries WHERE namespace=? AND event_digest=?",
                (self._namespace, event_digest),
            ).fetchone()
            if row is not None:
                connection.execute("COMMIT")
                if not hmac.compare_digest(row["message_digest"], message_digest):
                    raise InboxSecurityError("FEISHU_EVENT_CONFLICT")
                return
            connection.execute(
                "INSERT INTO feishu_event_deliveries VALUES (?,?,?,?)",
                (self._namespace, event_digest, message_digest, now),
            )
            connection.execute("COMMIT")
        finally:
            connection.close()

    def _verify_transport(self, request: FeishuWebhookRequest) -> tuple[str, str]:
        if not isinstance(request.body, bytes) or not 1 <= len(request.body) <= _MAX_BODY:
            raise InboxSecurityError("FEISHU_BODY_INVALID")
        timestamp = _header(request.headers, "X-Lark-Request-Timestamp")
        nonce = _header(request.headers, "X-Lark-Request-Nonce")
        signature = _header(request.headers, "X-Lark-Signature")
        try:
            issued = datetime.fromtimestamp(int(timestamp), tz=UTC)
            now = self.clock().astimezone(UTC)
        except (ValueError, TypeError, OSError):
            raise InboxSecurityError("FEISHU_TIMESTAMP_INVALID") from None
        if abs(now - issued) > timedelta(seconds=self.config.timestamp_window_seconds):
            raise InboxSecurityError("FEISHU_TIMESTAMP_INVALID")
        expected = hashlib.sha256(
            (timestamp + nonce + self.config.encrypt_key).encode("utf-8") + request.body
        ).hexdigest()
        if not hmac.compare_digest(signature.encode("ascii", "ignore"), expected.encode("ascii")):
            raise InboxSecurityError("FEISHU_SIGNATURE_INVALID")
        return timestamp, nonce

    def _decrypt(self, outer: dict) -> dict:
        if "encrypt" not in outer:
            return outer
        if set(outer) != {"encrypt"} or not isinstance(outer["encrypt"], str):
            raise InboxSecurityError("FEISHU_SCHEMA_INVALID")
        try:
            raw = self.decryptor(outer["encrypt"], self.config.encrypt_key)
            return _json_object(raw, "FEISHU_DECRYPT_INVALID")
        except InboxSecurityError:
            raise
        except Exception:
            raise InboxSecurityError("FEISHU_DECRYPT_INVALID") from None

    def _handle_event(self, payload: dict, nonce: str, timestamp: str,
                      body_digest: str) -> FeishuWebhookResponse:
        header, event = payload.get("header"), payload.get("event")
        if not isinstance(header, Mapping) or not isinstance(event, Mapping):
            raise InboxSecurityError("FEISHU_SCHEMA_INVALID")
        event_id = header.get("event_id")
        if not isinstance(event_id, str) or not _EVENT_ID.fullmatch(event_id):
            raise InboxSecurityError("FEISHU_EVENT_ID_INVALID")
        if header.get("event_type") != _ALLOWED_EVENT:
            raise InboxSecurityError("FEISHU_EVENT_UNSUPPORTED")
        if not _constant_token(header.get("tenant_key"), self.config.tenant_key):
            raise InboxSecurityError("FEISHU_TENANT_DENIED")
        if not _constant_token(header.get("app_id"), self.config.app_id):
            raise InboxSecurityError("FEISHU_APP_DENIED")
        sender, message = event.get("sender"), event.get("message")
        if not isinstance(sender, Mapping) or not isinstance(message, Mapping):
            raise InboxSecurityError("FEISHU_SCHEMA_INVALID")
        if sender.get("sender_type") == "bot":
            cached = self._begin_request(nonce, timestamp, body_digest)
            if cached is not None:
                return cached
            return self._complete_request(nonce, body_digest, FeishuWebhookResponse(
                200, {"status": "ignored", "classification": "bot_message"}))
        if sender.get("sender_type") != "user":
            raise InboxSecurityError("FEISHU_ACTOR_DENIED")
        sender_id = sender.get("sender_id")
        sender_open_id = sender_id.get("open_id") if isinstance(sender_id, Mapping) else None
        chat_id = message.get("chat_id")
        if sender_open_id not in self.config.allowed_senders or chat_id not in self.config.allowed_chats:
            raise InboxSecurityError("FEISHU_ACTOR_DENIED")
        chat_type = message.get("chat_type")
        if chat_type not in {"p2p", "group"}:
            raise InboxSecurityError("FEISHU_CHAT_INVALID")
        if chat_type == "group" and not self._mentions_bot(message.get("mentions")):
            cached = self._begin_request(nonce, timestamp, body_digest)
            if cached is not None:
                return cached
            return self._complete_request(nonce, body_digest, FeishuWebhookResponse(
                200, {"status": "ignored", "classification": "mention_required"}))
        message_id = message.get("message_id")
        if not isinstance(message_id, str) or not _FEISHU_ID.fullmatch(message_id):
            raise InboxSecurityError("FEISHU_SCHEMA_INVALID")
        self._record_event_delivery(event_id, message_id)
        intent = self._normalize_intent(sender_open_id, message)
        cached = self._begin_request(nonce, timestamp, body_digest)
        if cached is not None:
            return cached
        existing = self.inbox.find_intent(intent.identity_id, intent.idempotency_key)
        if existing is not None and existing["fingerprint"] != intent.fingerprint:
            raise InboxSecurityError("INBOX_IDEMPOTENCY_CONFLICT")
        try:
            if existing:
                receipt = InboxReceipt(existing["receipt_id"], existing["status"], True, existing["created_at"])
            else:
                row, duplicate = self.inbox.accept_intent(
                    identity_id=intent.identity_id, project_id=intent.project_id, task_id=None,
                    idempotency_key=intent.idempotency_key, fingerprint=intent.fingerprint,
                    intent=intent.durable_value(),
                )
                receipt = InboxReceipt(row["receipt_id"], row["status"], duplicate, row["created_at"])
        except ValueError as error:
            if str(error) != "INBOX_IDEMPOTENCY_CONFLICT":
                raise
            raise InboxSecurityError("INBOX_IDEMPOTENCY_CONFLICT") from None
        return self._complete_request(nonce, body_digest, FeishuWebhookResponse(200, {
            "status": receipt.status,
            "receipt_id": receipt.receipt_id,
            "duplicate": receipt.duplicate,
        }))

    def _mentions_bot(self, mentions: object) -> bool:
        if not isinstance(mentions, list):
            return False
        for mention in mentions:
            identity = mention.get("id") if isinstance(mention, Mapping) else None
            if isinstance(identity, Mapping) and _constant_token(identity.get("open_id"), self.config.bot_open_id):
                return True
        return False

    def _normalize_intent(self, sender_open_id: str, message: Mapping[str, object]) -> TaskIntent:
        message_id = message.get("message_id")
        message_type = message.get("message_type")
        content_raw = message.get("content")
        if not isinstance(message_id, str) or not _FEISHU_ID.fullmatch(message_id) or not isinstance(content_raw, str):
            raise InboxSecurityError("FEISHU_SCHEMA_INVALID")
        try:
            content = json.loads(content_raw)
        except json.JSONDecodeError:
            raise InboxSecurityError("FEISHU_SCHEMA_INVALID") from None
        if not isinstance(content, dict):
            raise InboxSecurityError("FEISHU_SCHEMA_INVALID")
        attachments: tuple[AttachmentRef, ...] = ()
        if message_type == "text":
            text = content.get("text")
            if not isinstance(text, str):
                raise InboxSecurityError("FEISHU_SCHEMA_INVALID")
            text = re.sub(r"@_user_\d+", "", text).strip()
        elif message_type in {"file", "image"}:
            key_name = "file_key" if message_type == "file" else "image_key"
            key = content.get(key_name)
            if not isinstance(key, str) or not _REF.fullmatch(key):
                raise InboxSecurityError("FEISHU_ATTACHMENT_DENIED")
            metadata = self.attachment_metadata(message_id, key)
            if not isinstance(metadata, AttachmentMetadata):
                raise InboxSecurityError("FEISHU_ATTACHMENT_DENIED")
            if (not re.fullmatch(r"att_[A-Za-z0-9_-]{8,120}", metadata.ref)
                    or metadata.mime not in {"image/png", "image/jpeg", "image/webp", "text/plain", "application/pdf"}
                    or not isinstance(metadata.size, int) or isinstance(metadata.size, bool)
                    or not 0 < metadata.size <= 10_000_000
                    or not re.fullmatch(r"[0-9a-f]{64}", metadata.sha256)):
                raise InboxSecurityError("FEISHU_ATTACHMENT_DENIED")
            attachments = (AttachmentRef(metadata.ref, metadata.mime, metadata.size, metadata.sha256),)
            text = "处理已验证的附件"
        else:
            raise InboxSecurityError("FEISHU_MESSAGE_UNSUPPORTED")
        if not text or len(text) > 4000 or any(ord(char) < 32 and char not in "\n\t" for char in text):
            raise InboxSecurityError("FEISHU_SCHEMA_INVALID")
        # Business idempotency is tenant + app + message_id. Delivery event_id
        # is deliberately excluded and retained only in the hashed audit ledger.
        identity_id = "feishu_" + hashlib.sha256(
            (self.config.tenant_key + "\0" + self.config.app_id).encode("utf-8")
        ).hexdigest()[:32]
        idempotency_key = "feishu_" + hashlib.sha256(message_id.encode("utf-8")).hexdigest()[:32]
        title = text.replace("\n", " ")[:160]
        canonical = json.dumps({
            "identity_id": identity_id,
            "project_id": self.config.project_id,
            "title": title,
            "goal": text,
            "attachments": [item.__dict__ for item in attachments],
            "sender": hashlib.sha256(sender_open_id.encode("utf-8")).hexdigest(),
            "chat": hashlib.sha256(str(message.get("chat_id")).encode("utf-8")).hexdigest(),
            "message": hashlib.sha256(message_id.encode("utf-8")).hexdigest(),
            "source": "feishu",
            "trust": "external_untrusted",
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return TaskIntent(
            identity_id, self.config.project_id, None, title, text, (), attachments,
            idempotency_key, hashlib.sha256(canonical.encode()).hexdigest(),
            source="feishu", trust="external_untrusted",
        )


class FeishuOutbound:
    """Bounded, idempotent sender for fixed public status templates only."""

    _TEXT = {
        "receipt": "任务已进入小蛇收件箱，等待本机处理。",
        "waiting": "任务正在等待本机用户处理。",
        "final": "任务已结束，请在小蛇中查看已验证结果。",
    }

    def __init__(self, *, sender: Callable[[dict, str], object],
                 sleeper: Callable[[float], None] = time.sleep, max_attempts: int = 3):
        if not 1 <= max_attempts <= 5:
            raise ValueError("max_attempts must be between 1 and 5")
        self.sender = sender
        self.sleeper = sleeper
        self.max_attempts = max_attempts

    def send(self, kind: str, *, receipt_id: str, classification: str) -> FeishuDeliveryResult:
        if kind not in self._TEXT or classification not in _ALLOWED_CLASSIFICATIONS:
            raise ValueError("unsupported outbound classification")
        public_payload = {
            "msg_type": "text",
            "content": {"text": self._TEXT[kind]},
            "classification": classification,
        }
        idempotency_key = "fsout_" + hashlib.sha256(
            (receipt_id + "\0" + kind + "\0" + classification).encode()
        ).hexdigest()[:32]
        for attempt in range(1, self.max_attempts + 1):
            try:
                self.sender(public_payload, idempotency_key)
                return FeishuDeliveryResult("sent", attempt)
            except (ConnectionError, TimeoutError, OSError):
                if attempt < self.max_attempts:
                    self.sleeper(min(0.25 * (2 ** (attempt - 1)), 1.0))
        return FeishuDeliveryResult("delivery_failed", self.max_attempts)


# AES-256-CBC fallback used for official encrypted callbacks. The decoded Feishu
# blob carries its IV in the first 16 bytes and uses PKCS#7 padding.
_SBOX = (
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
)
_INV_SBOX = tuple(_SBOX.index(value) for value in range(256))
_RCON = (0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36)


def _xor_word(a: list[int], b: list[int]) -> list[int]:
    return [x ^ y for x, y in zip(a, b)]


def _round_keys(key: bytes) -> list[list[list[int]]]:
    words = [list(key[index:index + 4]) for index in range(0, 32, 4)]
    for index in range(8, 60):
        temp = words[index - 1][:]
        if index % 8 == 0:
            temp = [_SBOX[value] for value in temp[1:] + temp[:1]]
            temp[0] ^= _RCON[index // 8]
        elif index % 8 == 4:
            temp = [_SBOX[value] for value in temp]
        words.append(_xor_word(words[index - 8], temp))
    return [[words[round_index * 4 + column] for column in range(4)] for round_index in range(15)]


def _mul(value: int, factor: int) -> int:
    result = 0
    while factor:
        if factor & 1:
            result ^= value
        value = ((value << 1) ^ (0x11b if value & 0x80 else 0)) & 0xff
        factor >>= 1
    return result


def _decrypt_block(block: bytes, keys: list[list[list[int]]]) -> bytes:
    state = [list(block[column * 4:column * 4 + 4]) for column in range(4)]

    def add_round_key(round_key):
        for column in range(4):
            state[column] = _xor_word(state[column], round_key[column])

    def inv_shift_rows():
        for row in range(1, 4):
            values = [state[column][row] for column in range(4)]
            values = values[-row:] + values[:-row]
            for column in range(4):
                state[column][row] = values[column]

    def inv_sub_bytes():
        for column in range(4):
            state[column] = [_INV_SBOX[value] for value in state[column]]

    def inv_mix_columns():
        for column in range(4):
            a, b, c, d = state[column]
            state[column] = [
                _mul(a,14)^_mul(b,11)^_mul(c,13)^_mul(d,9),
                _mul(a,9)^_mul(b,14)^_mul(c,11)^_mul(d,13),
                _mul(a,13)^_mul(b,9)^_mul(c,14)^_mul(d,11),
                _mul(a,11)^_mul(b,13)^_mul(c,9)^_mul(d,14),
            ]

    add_round_key(keys[14])
    for round_index in range(13, 0, -1):
        inv_shift_rows()
        inv_sub_bytes()
        add_round_key(keys[round_index])
        inv_mix_columns()
    inv_shift_rows()
    inv_sub_bytes()
    add_round_key(keys[0])
    return bytes(value for column in state for value in column)


def decrypt_feishu_payload(encrypted: str, encrypt_key: str) -> bytes:
    try:
        blob = base64.b64decode(encrypted, validate=True)
    except (ValueError, TypeError):
        raise InboxSecurityError("FEISHU_DECRYPT_INVALID") from None
    if len(blob) < 32 or len(blob) % 16:
        raise InboxSecurityError("FEISHU_DECRYPT_INVALID")
    key = hashlib.sha256(encrypt_key.encode("utf-8")).digest()
    keys = _round_keys(key)
    iv, ciphertext = blob[:16], blob[16:]
    plaintext = bytearray()
    previous = iv
    for offset in range(0, len(ciphertext), 16):
        block = ciphertext[offset:offset + 16]
        plaintext.extend(a ^ b for a, b in zip(_decrypt_block(block, keys), previous))
        previous = block
    padding = plaintext[-1]
    if not 1 <= padding <= 16 or plaintext[-padding:] != bytes([padding]) * padding:
        raise InboxSecurityError("FEISHU_DECRYPT_INVALID")
    return bytes(plaintext[:-padding])
