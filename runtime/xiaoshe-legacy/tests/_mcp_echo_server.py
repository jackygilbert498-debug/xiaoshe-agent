"""测试夹具：一个极简 stdio MCP server，只暴露一个 echo 工具。

不是测试文件（下划线开头，不被 unittest 收集）。给 test_stage4 当"外部 MCP server"用，
自包含、不依赖星见/总台。说 MCP 的最小方言：initialize / tools/list / tools/call。
"""
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


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
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "echo", "version": "0.1"},
        }})
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [{
            "name": "echo",
            "description": "回显你给的文本",
            "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        }]}})
    elif method == "tools/call":
        params = msg.get("params", {})
        args = params.get("arguments", {})
        if params.get("name") == "echo":
            text = str(args.get("text", ""))
            if text == "__error__":  # 供测试触发 isError 分支
                send({"jsonrpc": "2.0", "id": mid, "result": {
                    "content": [{"type": "text", "text": "故意报错"}], "isError": True}})
            else:
                send({"jsonrpc": "2.0", "id": mid, "result": {
                    "content": [{"type": "text", "text": "echo: " + text}]}})
        else:
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": "unknown tool"}], "isError": True}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found"}})
