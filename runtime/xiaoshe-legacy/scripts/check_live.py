"""活服务契约校验：起 serve（假模型）→ validate_contract.py --server --token → 退出码透传。
用法：python scripts/check_live.py [port]
"""
from __future__ import annotations

import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from harness import ui_server  # noqa: E402
from smoke_serve import fake_model_fn  # noqa: E402  复用 smoke 的假模型（不调真 API）


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 17890
    t = threading.Thread(target=ui_server.serve_main,
                         args=(["--port", str(port), "--no-browser", "--no-mcp"],),
                         kwargs={"model_fn": fake_model_fn}, daemon=True)
    t.start()
    tf = ROOT / ".state" / "ui_token"
    token = None
    for _ in range(100):
        time.sleep(0.1)
        if tf.exists() and ui_server.active_server().get("httpd"):
            token = tf.read_text(encoding="utf-8").strip()
            break
    if not token:
        print("服务未就绪")
        return 2
    try:
        r = subprocess.run(
            [sys.executable, "tests/ui_contract/validate_contract.py",
             "--server", f"http://127.0.0.1:{port}", "--token", token],
            cwd=ROOT, capture_output=True, text=True, timeout=60)
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        return r.returncode
    finally:
        srv = ui_server.active_server().get("httpd")
        if srv:
            srv.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
