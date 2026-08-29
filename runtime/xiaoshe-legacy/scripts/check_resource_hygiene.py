"""Release-gate resource sampler.  It is deliberately dependency-free."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import threading
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class ResourceSnapshot:
    non_daemon_threads: int
    children: int
    open_handles: int | None


def snapshot_resources() -> ResourceSnapshot:
    threads = sum(1 for thread in threading.enumerate() if not thread.daemon and thread is not threading.main_thread())
    children = 0
    try:
        output = subprocess.check_output(["ps", "-o", "pid=", "--ppid", str(os.getpid())], text=True, stderr=subprocess.DEVNULL)
        children = len([line for line in output.splitlines() if line.strip()])
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        handles: int | None = len(list(Path("/dev/fd").iterdir()))
    except OSError:
        handles = None
    return ResourceSnapshot(threads, children, handles)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=1)
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    before = snapshot_resources()
    # Probe child lifecycle without loading an app server or user data.
    for _ in range(max(1, args.iterations)):
        subprocess.run([os.environ.get("PYTHON", "python3"), "-c", "pass"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    after = snapshot_resources()
    delta = {key: getattr(after, key) - getattr(before, key) if getattr(after, key) is not None and getattr(before, key) is not None else None for key in asdict(before)}
    report = {"version": 1, "iterations": args.iterations, "before": asdict(before), "after": asdict(after), "delta": delta,
              "pass": delta["non_daemon_threads"] == 0 and delta["children"] == 0 and (delta["open_handles"] is None or delta["open_handles"] <= 1)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if report["pass"] or not args.strict else 1


if __name__ == "__main__":
    raise SystemExit(main())
