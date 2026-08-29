"""Validate deterministic, checked-in documentation without modifying it."""
from __future__ import annotations

import sys
from collections.abc import Callable
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from harness.capabilities import build_core_capability_registry, render_runtime_capabilities


GENERATED_DOCUMENTS: dict[Path, Callable[[], str]] = {
    ROOT / "docs" / "runtime-capabilities.md": lambda: render_runtime_capabilities(
        build_core_capability_registry()),
}


def main() -> int:
    stale: list[Path] = []
    for path, render in GENERATED_DOCUMENTS.items():
        try:
            actual = path.read_text(encoding="utf-8")
        except OSError:
            stale.append(path)
            continue
        if actual != render():
            stale.append(path)
    if stale:
        for path in stale:
            print(f"stale generated document: {path.relative_to(ROOT)}", file=sys.stderr)
        return 1
    print(f"validated {len(GENERATED_DOCUMENTS)} generated document(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
