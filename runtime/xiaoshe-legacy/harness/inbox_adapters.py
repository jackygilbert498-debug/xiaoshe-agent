"""Authenticated, bounded adapters that can only accept Task intents.

Adapters terminate untrusted ingress at a durable inbox receipt.  They do not
run tools, start a RuntimeSession, approve a plan, or claim an outcome.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Callable, Mapping, Protocol, Sequence
from urllib.parse import urlsplit

from .task_inbox import TaskInbox

_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$")
_REF = re.compile(r"^att_[A-Za-z0-9_-]{8,120}$")
_SAFE_MIME = frozenset({"image/png", "image/jpeg", "image/webp", "text/plain", "application/pdf"})
_BODY_FIELDS = frozenset({"project_id", "task_id", "title", "goal", "acceptance", "attachments"})
_MAX_ATTACHMENT_BYTES = 10_000_000
_MAX_ATTACHMENTS = 8


class InboxSecurityError(ValueError):
    """Stable public classification without echoing untrusted input."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _utc(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise InboxSecurityError("INBOX_TOKEN_EXPIRED")
    return value.astimezone(UTC)


def _bounded_text(value: object, *, minimum: int, maximum: int) -> str:
    if not isinstance(value, str):
        raise InboxSecurityError("INBOX_SCHEMA_INVALID")
    result = value.strip()
    if not minimum <= len(result) <= maximum or any(ord(char) < 32 and char not in "\n\t" for char in result):
        raise InboxSecurityError("INBOX_SCHEMA_INVALID")
    return result


@dataclass(frozen=True, repr=False)
class LocalInboxSession:
    identity_id: str
    bearer_digest: str
    csrf_digest: str
    expires_at: datetime
    project_ids: tuple[str, ...]

    @classmethod
    def from_tokens(cls, *, identity_id: str, bearer_token: str, csrf_token: str,
                    expires_at: datetime, project_ids: Sequence[str]) -> "LocalInboxSession":
        if not _ID.fullmatch(identity_id) or not bearer_token or not csrf_token or not project_ids:
            raise ValueError("invalid local inbox session")
        return cls(identity_id, _digest(bearer_token), _digest(csrf_token), _utc(expires_at), tuple(project_ids))

    def __repr__(self) -> str:
        return f"LocalInboxSession(identity_id={self.identity_id!r}, expires_at={self.expires_at.isoformat()!r})"


@dataclass(frozen=True, repr=False)
class InboxRequest:
    origin: str
    host: str
    fetch_site: str
    bearer_token: str
    csrf_token: str
    request_nonce: str
    issued_at: datetime
    idempotency_key: str
    body: Mapping[str, object]

    def __repr__(self) -> str:
        return "InboxRequest(<redacted>)"

@dataclass(frozen=True, repr=False)
class AuthenticatedInboxRequest:
    origin: str
    host: str
    fetch_site: str
    idempotency_key: str
    body: Mapping[str, object]


@dataclass(frozen=True)
class InboxIdentity:
    identity_id: str
    project_ids: tuple[str, ...]


@dataclass(frozen=True)
class AttachmentRef:
    ref: str
    mime: str
    size: int
    sha256: str

@dataclass(frozen=True)
class AttachmentMetadata:
    ref: str
    mime: str
    size: int
    sha256: str


@dataclass(frozen=True, repr=False)
class TaskIntent:
    identity_id: str
    project_id: str
    task_id: str | None
    title: str
    goal: str
    acceptance: tuple[str, ...]
    attachments: tuple[AttachmentRef, ...]
    idempotency_key: str
    fingerprint: str
    source: str = "local_pwa"
    trust: str = "authenticated_local"

    def durable_value(self) -> dict:
        return {
            "v": 1, "identity_id": self.identity_id, "project_id": self.project_id,
            "task_id": self.task_id, "title": self.title, "goal": self.goal,
            "acceptance": list(self.acceptance),
            "attachments": [item.__dict__ for item in self.attachments],
            "source": self.source, "trust": self.trust,
        }

    def __repr__(self) -> str:
        return f"TaskIntent(identity_id={self.identity_id!r}, project_id={self.project_id!r}, fingerprint={self.fingerprint!r})"


@dataclass(frozen=True)
class DeduplicationResult:
    state: str
    receipt_id: str | None = None


@dataclass(frozen=True)
class InboxReceipt:
    receipt_id: str
    status: str
    duplicate: bool
    created_at: str


class InboxAdapter(Protocol):
    name: str
    def authenticate(self, request: InboxRequest) -> InboxIdentity: ...
    def normalize(self, request: InboxRequest, identity: InboxIdentity) -> TaskIntent: ...
    def deduplicate(self, intent: TaskIntent) -> DeduplicationResult: ...
    def submit(self, intent: TaskIntent, deduplication: DeduplicationResult) -> InboxReceipt: ...


class LocalPWAInboxAdapter:
    name = "local_pwa"

    def __init__(self, *, inbox: TaskInbox, allowed_origin: str,
                 sessions: Sequence[LocalInboxSession],
                 clock: Callable[[], datetime] | None = None,
                 attachment_metadata: Callable[[str, str, str], AttachmentMetadata | None] | None = None):
        parsed = urlsplit(allowed_origin)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path not in {"", "/"}:
            raise ValueError("allowed_origin must be an origin")
        self.inbox = inbox
        self.allowed_origin = f"{parsed.scheme}://{parsed.netloc}"
        self.allowed_host = parsed.netloc
        self.sessions = tuple(sessions)
        self.clock = clock or (lambda: datetime.now(UTC))
        self.attachment_metadata = attachment_metadata or (lambda identity, project, ref: None)

    def authenticate(self, request: InboxRequest) -> InboxIdentity:
        if request.origin != self.allowed_origin:
            raise InboxSecurityError("INBOX_ORIGIN_DENIED")
        if request.host != self.allowed_host:
            raise InboxSecurityError("INBOX_HOST_DENIED")
        if request.fetch_site != "same-origin":
            raise InboxSecurityError("INBOX_CROSS_SITE")
        now, issued = _utc(self.clock()), _utc(request.issued_at)
        if abs(now - issued) > timedelta(minutes=5):
            raise InboxSecurityError("INBOX_TOKEN_EXPIRED")
        session = next((candidate for candidate in self.sessions
                        if hmac.compare_digest(candidate.bearer_digest, _digest(request.bearer_token))), None)
        if session is None:
            raise InboxSecurityError("INBOX_AUTH_DENIED")
        if now >= session.expires_at:
            raise InboxSecurityError("INBOX_TOKEN_EXPIRED")
        if not hmac.compare_digest(session.csrf_digest, _digest(request.csrf_token)):
            raise InboxSecurityError("INBOX_CSRF_DENIED")
        if not _ID.fullmatch(request.request_nonce):
            raise InboxSecurityError("INBOX_SCHEMA_INVALID")
        if not self.inbox.consume_request_nonce(session.identity_id, _digest(request.request_nonce), issued.isoformat()):
            raise InboxSecurityError("INBOX_REPLAYED")
        return InboxIdentity(session.identity_id, session.project_ids)

    def normalize(self, request: InboxRequest, identity: InboxIdentity) -> TaskIntent:
        if not isinstance(request.body, Mapping) or set(request.body) - _BODY_FIELDS:
            raise InboxSecurityError("INBOX_SCHEMA_INVALID")
        if not _ID.fullmatch(request.idempotency_key):
            raise InboxSecurityError("INBOX_SCHEMA_INVALID")
        project_id = request.body.get("project_id")
        if not isinstance(project_id, str) or project_id not in identity.project_ids:
            raise InboxSecurityError("INBOX_PROJECT_DENIED")
        task_id = request.body.get("task_id")
        if task_id is not None:
            if not isinstance(task_id, str) or not self.inbox.task_belongs_to(task_id, project_id):
                raise InboxSecurityError("INBOX_TASK_DENIED")
        title = _bounded_text(request.body.get("title"), minimum=1, maximum=160)
        goal = _bounded_text(request.body.get("goal"), minimum=1, maximum=4000)
        raw_acceptance = request.body.get("acceptance", ())
        if not isinstance(raw_acceptance, (list, tuple)) or len(raw_acceptance) > 20:
            raise InboxSecurityError("INBOX_SCHEMA_INVALID")
        acceptance = tuple(_bounded_text(item, minimum=1, maximum=500) for item in raw_acceptance)
        raw_attachments = request.body.get("attachments", ())
        if not isinstance(raw_attachments, (list, tuple)) or len(raw_attachments) > _MAX_ATTACHMENTS:
            raise InboxSecurityError("INBOX_ATTACHMENT_INVALID")
        attachments = []
        for raw in raw_attachments:
            if not isinstance(raw, Mapping) or set(raw) - {"ref", "mime", "size", "sha256"} or "ref" not in raw:
                raise InboxSecurityError("INBOX_ATTACHMENT_INVALID")
            ref = raw.get("ref")
            if not isinstance(ref, str) or not _REF.fullmatch(ref):
                raise InboxSecurityError("INBOX_ATTACHMENT_INVALID")
            if ("mime" in raw and raw["mime"] not in _SAFE_MIME) or (
                "size" in raw and (not isinstance(raw["size"], int) or isinstance(raw["size"], bool)
                                   or not 0 < raw["size"] <= _MAX_ATTACHMENT_BYTES)
            ) or ("sha256" in raw and (not isinstance(raw["sha256"], str)
                                       or not re.fullmatch(r"[0-9a-f]{64}", raw["sha256"]))):
                raise InboxSecurityError("INBOX_ATTACHMENT_INVALID")
            metadata = self.attachment_metadata(identity.identity_id, project_id, ref)
            if metadata is None:
                raise InboxSecurityError("INBOX_ATTACHMENT_DENIED")
            if (not isinstance(metadata, AttachmentMetadata) or metadata.ref != ref or metadata.mime not in _SAFE_MIME
                    or not isinstance(metadata.size, int) or isinstance(metadata.size, bool)
                    or not 0 < metadata.size <= _MAX_ATTACHMENT_BYTES
                    or not re.fullmatch(r"[0-9a-f]{64}", metadata.sha256)):
                raise InboxSecurityError("INBOX_ATTACHMENT_INVALID")
            for field in ("mime", "size", "sha256"):
                if field in raw and raw[field] != getattr(metadata, field):
                    raise InboxSecurityError("INBOX_ATTACHMENT_MISMATCH")
            attachments.append(AttachmentRef(ref, metadata.mime, metadata.size, metadata.sha256))
        canonical = json.dumps({
            "identity_id": identity.identity_id, "project_id": project_id, "task_id": task_id,
            "title": title, "goal": goal, "acceptance": acceptance,
            "attachments": [item.__dict__ for item in attachments],
        }, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return TaskIntent(identity.identity_id, project_id, task_id, title, goal, acceptance,
                          tuple(attachments), request.idempotency_key, _digest(canonical))

    def deduplicate(self, intent: TaskIntent) -> DeduplicationResult:
        existing = self.inbox.find_intent(intent.identity_id, intent.idempotency_key)
        if existing is None:
            return DeduplicationResult("new")
        if existing["fingerprint"] != intent.fingerprint:
            raise InboxSecurityError("INBOX_IDEMPOTENCY_CONFLICT")
        return DeduplicationResult("duplicate", existing["receipt_id"])

    def submit(self, intent: TaskIntent, deduplication: DeduplicationResult) -> InboxReceipt:
        if deduplication.state == "duplicate" and deduplication.receipt_id:
            row = self.inbox.find_intent(intent.identity_id, intent.idempotency_key)
            if row is None or row["fingerprint"] != intent.fingerprint:
                raise InboxSecurityError("INBOX_IDEMPOTENCY_CONFLICT")
            return InboxReceipt(row["receipt_id"], row["status"], True, row["created_at"])
        try:
            row, duplicate = self.inbox.accept_intent(
                identity_id=intent.identity_id, project_id=intent.project_id, task_id=intent.task_id,
                idempotency_key=intent.idempotency_key, fingerprint=intent.fingerprint,
                intent=intent.durable_value(),
            )
        except ValueError as error:
            if str(error) == "INBOX_IDEMPOTENCY_CONFLICT":
                raise InboxSecurityError(str(error)) from None
            raise
        return InboxReceipt(row["receipt_id"], row["status"], duplicate, row["created_at"])

class AuthenticatedLocalInboxAdapter(LocalPWAInboxAdapter):
    name = "authenticated_local"

    def __init__(self, *, inbox: TaskInbox, identity_id: str, project_ids: Sequence[str]):
        self.inbox = inbox
        self.identity = InboxIdentity(identity_id, tuple(project_ids))
        self.attachment_metadata = lambda identity, project, ref: None

    def authenticate(self, request: AuthenticatedInboxRequest) -> InboxIdentity:
        parsed = urlsplit(request.origin)
        if parsed.scheme not in {"http", "https"} or parsed.netloc != request.host:
            raise InboxSecurityError("INBOX_ORIGIN_DENIED")
        if request.fetch_site != "same-origin":
            raise InboxSecurityError("INBOX_CROSS_SITE")
        return self.identity
