"""Non-forgeable provenance wrappers for MCP and other external payloads."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class TaintedValue:
    value: Any
    trust: str
    provenance: str


class SourceTaint:
    EXTERNAL_UNTRUSTED = "external_untrusted"

    def from_mcp(self, server: str, payload: Any) -> TaintedValue:
        # Never accept a server-provided `trusted` claim: provenance belongs to
        # the local connection, not to untrusted response content.
        return TaintedValue(payload, self.EXTERNAL_UNTRUSTED, f"mcp:{server}")

    def wrap(self, source: str, payload: Any) -> TaintedValue:
        return TaintedValue(payload, self.EXTERNAL_UNTRUSTED, source)
