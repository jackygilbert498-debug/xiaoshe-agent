"""联调走查：serve_demo + Playwright 真浏览器全链路截图。
用法：python scripts/walkthrough.py [out_dir]
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "walkthrough"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 17895


def main() -> int:
    srv = subprocess.Popen([sys.executable, "scripts/serve_demo.py", "--port", str(PORT)],
                           cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        token = None
        for _ in range(60):
            time.sleep(0.5)
            tf = ROOT / ".state" / "ui_token"
            if tf.exists():
                token = tf.read_text(encoding="utf-8").strip()
                break
        if not token:
            print("FAIL: 服务未就绪")
            return 1
        url = f"http://127.0.0.1:{PORT}/?token={token}"
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(args=["--no-sandbox"])
            except Exception:
                browser = pw.chromium.launch(channel="chrome", args=["--no-sandbox"])  # 未装 chromium 时用系统 Chrome
            page = browser.new_page(viewport={"width": 1600, "height": 1000})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(url)
            page.wait_for_timeout(2500)
            page.screenshot(path=OUT / "01-connected.png")

            # 发「待办」→ 工具卡双行 + 右栏面板联动
            page.click("#composer-input")
            page.fill("#composer-input", "待办")
            page.keyboard.press("Enter")
            page.wait_for_timeout(2500)
            page.screenshot(path=OUT / "02-toolcard-panel.png")

            # 发「写文件」→ 审批卡（三态：待定）
            page.fill("#composer-input", "写文件")
            page.keyboard.press("Enter")
            page.wait_for_timeout(2500)
            page.screenshot(path=OUT / "03-approval.png")

            # 按 y → 已决灰显 + 工具卡成功
            page.keyboard.press("y")
            page.wait_for_timeout(2500)
            page.screenshot(path=OUT / "04-approved.png")

            # ⌘K 面板
            page.keyboard.press("Control+k")
            page.wait_for_timeout(600)
            page.screenshot(path=OUT / "05-palette.png")
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)

            # 观测台（空态文案）
            page.evaluate("window.XS?.observatory?.toggle?.()")
            page.wait_for_timeout(600)
            page.screenshot(path=OUT / "06-observatory-empty.png")
            page.evaluate("window.XS?.observatory?.close?.()")

            # 记忆 tab（终审 F2 回归：真实数据渲染，非骨架屏）+ 系统 tab（F3）
            page.click(".itab[data-panel='p-mem']")
            page.wait_for_timeout(1200)
            page.screenshot(path=OUT / "08-mem-tab.png")
            page.click(".itab[data-panel='p-sys']")
            page.wait_for_timeout(800)
            page.screenshot(path=OUT / "09-sys-tab.png")
            page.click(".itab[data-panel='p-state']")
            page.wait_for_timeout(400)

            # 墨玉主题
            page.evaluate("window.XS?.theme?.setTheme?.('ink-jade')")
            page.wait_for_timeout(600)
            page.screenshot(path=OUT / "07-ink-jade.png")

            print("console errors:", errors if errors else "无")
            browser.close()
        print("走查完成，截图目录:", OUT)
        return 0
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=8)
        except subprocess.TimeoutExpired:
            srv.kill()


if __name__ == "__main__":
    raise SystemExit(main())
