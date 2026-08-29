"""本地演示/开发用服务：假模型驱动，不烧 API——用户可真实体验界面全链路。
用法：python scripts/serve_demo.py [--port 7788]，然后浏览器打开打印的带 token URL。

假模型剧本（按用户输入触发不同事件路径）：
- 含「写文件」→ 调 write_file 写 demo-note.txt（触发审批卡：ask 路径，y/n/a/p 都可体验）
- 含「跑命令」→ 调 run_command echo（触发审批，command 类指纹）
- 含「待办」→ 调 update_todos（allow 路径：工具卡双行状态 + state.patch）
- 其他 → 直接回一段中文文本（体验消息流/贴底/窗口化）
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from harness import ui_server  # noqa: E402


def _assistant(text=None, tool_calls=None):
    msg = {"role": "assistant", "content": text or ""}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return msg


def demo_model_fn(messages, tools=None, **kw):
    """按最后一轮 user 文本出剧本；tool 结果回来后收尾。"""
    last = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    prev_tool = next((m for m in reversed(messages) if m.get("role") == "tool"), None)
    if prev_tool is not None and (last is None or messages.index(prev_tool) > messages.index(last)):
        return _assistant(f"已执行完：{prev_tool.get('content', '')[:80]}\n还要继续吗？")
    text = (last or {}).get("content", "")
    if "写文件" in text:
        return _assistant(tool_calls=[{"id": "call_demo_1", "type": "function", "function": {
            "name": "write_file",
            "arguments": '{"path": "demo-note.txt", "content": "小蛇界面演示：审批卡 y/n/a/p 四键都在这张卡上试。\\n"}'}}])
    if "跑命令" in text:
        return _assistant(tool_calls=[{"id": "call_demo_2", "type": "function", "function": {
            "name": "run_command", "arguments": '{"command": "echo 小蛇演示命令"}'}}])
    if "待办" in text:
        return _assistant(tool_calls=[{"id": "call_demo_3", "type": "function", "function": {
            "name": "update_todos",
            "arguments": '{"todos": [{"content": "体验消息流", "status": "completed"}, '
                                     '{"content": "体验审批四键", "status": "in_progress"}, '
                                     '{"content": "打开蛇眼观测台", "status": "pending"}]}'}}])
    return _assistant(
        "收到。「小蛇界面」演示服务模式（假模型，不烧 API）：\n"
        "- 发「写文件」体验审批卡（y/n/a/p + 规范化路径）\n"
        "- 发「跑命令」体验 command 类指纹审批\n"
        "- 发「待办」体验工具卡双行状态与右侧面板联动\n"
        "- ⌘K 看两组命令；右上角 ◉ 开蛇眼观测台；左下角切主题")


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--no-browser" not in args:
        args = args + ["--no-browser"]     # 容器里没浏览器，URL 由用户自己开
    ui_server.serve_main(args, model_fn=demo_model_fn)
