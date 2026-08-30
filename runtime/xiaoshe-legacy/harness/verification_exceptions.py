"""已知失败是有期限的审计例外，绝不是把失败涂绿。"""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime
from fnmatch import fnmatchcase

class KnownFailureError(ValueError): pass

@dataclass(frozen=True)
class KnownFailureException:
 check_id: str; profile_checksum: str; fingerprint: str; baseline_verification_id: str; reason: str; actor: str; expires_at: str; affected_globs: tuple[str,...]=()

class KnownFailureService:
 def create(self, *, check: dict, baseline: dict | None, reason: str, actor: str, expires_at: str, affected_globs=()) -> KnownFailureException:
  if not baseline or baseline.get('status') not in {'failed','error'}: raise KnownFailureError('KNOWN_FAILURE_BASELINE_REQUIRED')
  if not reason.strip() or not actor.strip(): raise KnownFailureError('KNOWN_FAILURE_REASON_REQUIRED')
  if expires_at <= datetime.now().astimezone().isoformat(): raise KnownFailureError('KNOWN_FAILURE_EXPIRY_INVALID')
  return KnownFailureException(str(check['check_id']),str(check['profile_checksum']),str(check['fingerprint']),str(baseline['verification_id']),reason.strip(),actor.strip(),expires_at,tuple(affected_globs))
 def applies(self, item: KnownFailureException, *, check_id: str, profile_checksum: str, fingerprint: str, changed_paths=()) -> bool:
  if item.expires_at <= datetime.now().astimezone().isoformat() or (item.check_id,item.profile_checksum,item.fingerprint)!=(check_id,profile_checksum,fingerprint): return False
  return not any(any(fnmatchcase(path,glob) for glob in item.affected_globs) for path in changed_paths)
