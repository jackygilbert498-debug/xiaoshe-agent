"""测试夹具：一个 stdio MCP server，故意暴露两个净化后会撞成同一 pref 的工具名。

不是测试文件（下划线开头）。用来验证 connect() 对 `_safe_ns` 撞名做去重、不静默覆盖/误路由。
两个原始工具名 "a b" 与 "a_b" 经 _safe_ns 都变成 "a_b"。
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

_NAMES = ["a b", "a_b"]


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
            "serverInfo": {"name": "collide", "version": "0.1"}}})
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [
            {"name": n, "description": f"工具 {n}",
             "inputSchema": {"type": "object", "properties": {}}} for n in _NAMES]}})
    elif method == "tools/call":
        params = msg.get("params", {})
        # 回显被调用的原始工具名，供测试确认路由到了正确的那一个
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "content": [{"type": "text", "text": "called:" + str(params.get("name"))}]}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found"}})
