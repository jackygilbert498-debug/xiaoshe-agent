"""真模型联调走查：run.py serve（真 Kimi）+ Playwright 以用户方式全链路验证。
用法：python scripts/walkthrough_live.py [out_dir] [--port N]
步骤：连接 → 发消息等真回复 → 待办工具卡 → 写文件审批卡按 y → 验证文件真落盘。
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else ROOT.parent / "walkthrough_live"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 17896
NOTE = ROOT / "live-test-note.txt"


SEL_TXT = "#stream .msg.assistant:not(:has(.msg-tools))"   # 纯文本回复（工具调用消息不算收尾）


def text_reply_count(page) -> int:
    return page.evaluate(f"document.querySelectorAll('{SEL_TXT}').length")


def wait_text_reply(page, prev: int, timeout: float = 180.0) -> bool:
    """等新的纯文本 assistant 回复（整轮真正收尾；工具卡消息不触发）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if text_reply_count(page) > prev:
            time.sleep(1.5)
            return True
        time.sleep(1.0)
    return False


def wait_approval_or_reply(page, prev: int, timeout: float = 150.0):
    """等审批卡（轮停在等人）或纯文本回复。返回 'approval' / 'reply' / None。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.evaluate("!!document.querySelector('.approval')"):
            return "approval"
        if text_reply_count(page) > prev:
            return "reply"
        time.sleep(1.0)
    return None


def main() -> int:
    if NOTE.exists():
        NOTE.unlink()
    srv = subprocess.Popen([sys.executable, "run.py", "serve", "--port", str(PORT), "--no-browser"],
                           cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        token = None
        for _ in range(120):
            time.sleep(0.5)
            tf = ROOT / ".state" / "ui_token"
            if tf.exists():
                token = tf.read_text(encoding="utf-8").strip()
                break
        if not token:
            print("FAIL: 服务未就绪")
            return 1
        url = f"http://127.0.0.1:{PORT}/?token={token}"
        results: list[str] = []
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(args=["--no-sandbox"])
            except Exception:
                browser = pw.chromium.launch(channel="chrome", args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1600, "height": 1000})
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(url)
            page.wait_for_timeout(3000)
            connected = page.evaluate("document.getElementById('live-text')?.textContent || ''")
            results.append(f"连接状态: {connected!r} {'OK' if '未连接' not in connected else 'FAIL'}")
            page.screenshot(path=OUT / "L1-connected.png")

            # 1) 用户发消息 → 真模型回复
            page.wait_for_selector("#composer-input:not([disabled])", timeout=45000)   # 等 WS 连上解锁输入框
            n0 = text_reply_count(page)
            page.click("#composer-input")
            page.fill("#composer-input", "你好，用一句话介绍你自己。")
            page.keyboard.press("Enter")
            ok = wait_text_reply(page, n0)
            results.append(f"真模型回复: {'OK' if ok else 'FAIL(180s 无回复)'}")
            page.screenshot(path=OUT / "L2-chat.png")

            # 2) 待办工具（allow 路径：工具卡 + 右栏联动）
            n0 = text_reply_count(page)
            page.fill("#composer-input", "调用 update_todos 工具，建两个待办：吃早餐、写日报。")
            page.keyboard.press("Enter")
            ok = wait_text_reply(page, n0, 180)
            todos = page.evaluate("(document.getElementById('p-state')||{}).innerText?.includes('吃早餐') || false")
            results.append(f"待办工具+面板: {'OK' if ok and todos else f'FAIL(ok={ok},todos={todos})'}")
            page.screenshot(path=OUT / "L3-todos.png")

            # 3) 写文件 → 审批卡 → 按 y → 文件真落盘
            n0 = text_reply_count(page)
            page.fill("#composer-input", "调用 write_file 工具写文件 live-test-note.txt，内容：你好。")
            page.keyboard.press("Enter")
            got = wait_approval_or_reply(page, n0)
            page.screenshot(path=OUT / "L4-approval.png")
            card = got == "approval"
            if card:
                page.click(".approval .ap-btn")   # 用户方式：点「y 批准一次」（键盘 y 会打进输入框）
                wait_text_reply(page, n0, 180)
                time.sleep(2)
            disk = NOTE.exists() and "你好" in NOTE.read_text(encoding="utf-8", errors="replace")
            results.append(f"审批卡: {'OK' if card else f'FAIL(got={got})'}；按 y 后文件落盘: {'OK' if disk else 'FAIL'}")
            page.screenshot(path=OUT / "L5-approved.png")

            results.append(f"console 错误: {errors if errors else '无'}")
            browser.close()
        print("\n".join(results))
        print("走查完成，截图目录:", OUT)
        return 0 if all("FAIL" not in r for r in results) else 1
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=8)
        except subprocess.TimeoutExpired:
            srv.kill()
        if NOTE.exists():
            NOTE.unlink()


if __name__ == "__main__":
    raise SystemExit(main())
