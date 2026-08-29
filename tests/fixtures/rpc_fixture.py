#!/usr/bin/env python3
"""Deterministic JSONL peer for BridgeClient lifecycle tests."""
import json
import os
import sys
import time


for raw in sys.stdin:
    request = json.loads(raw)
    method = request["method"]
    if method == "invalid":
        print("not-json", flush=True)
        continue
    if method == "crash":
        print("fixture crash", file=sys.stderr, flush=True)
        raise SystemExit(7)
    if method == "sleep":
        time.sleep(10)
    if method == "env":
        result = {
            "has_deepseek_key": "DEEPSEEK_API_KEY" in os.environ,
            "has_test_token": "XIAOSHE_TEST_TOKEN" in os.environ,
            "python_utf8": os.environ.get("PYTHONUTF8", ""),
        }
    elif method == "encoding":
        result = {
            "stdin": sys.stdin.encoding,
            "stdout": sys.stdout.encoding,
            "utf8_mode": sys.flags.utf8_mode,
            "text": "小蛇",
        }
    else:
        result = request.get("params", {})
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
