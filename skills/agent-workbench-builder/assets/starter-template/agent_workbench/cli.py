"""Command-line entry point with approval denied by default."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from .core import AgentError, run_agent


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    approval = parser.add_mutually_exclusive_group()
    approval.add_argument("--approve", action="store_true")
    approval.add_argument("--deny", action="store_true")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--work-dir", type=Path, default=Path("work"))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        request = json.loads(args.input.read_text(encoding="utf-8"))
        result = run_agent(
            request,
            approved=bool(args.approve),
            run_id=args.run_id,
            state_dir=args.work_dir / "state",
            output_dir=args.work_dir / "output",
            receipt_dir=args.work_dir / "receipts",
        )
    except (OSError, json.JSONDecodeError, AgentError) as exc:
        if isinstance(exc, AgentError):
            error = exc.as_dict()
        else:
            error = {
                "code": "INPUT_UNREADABLE",
                "message": str(exc),
                "recovery": "Check the input path and JSON syntax before retrying.",
            }
        print(json.dumps({"status": "error", "error": error}, ensure_ascii=False, sort_keys=True))
        return 3
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
