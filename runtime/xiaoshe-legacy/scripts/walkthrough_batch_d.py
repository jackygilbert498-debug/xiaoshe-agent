"""UI 批次 D 走查：模型切换下拉 + 会话级自主模式（假模型不烧 API，Chrome headless 真浏览器）。

断言链（DOM/行为双断言，逐步 PASS/FAIL 输出，截图留证）：
  1. 连接后模型 pill 显示默认模型；自主横幅隐藏
  2. 点自主开关 → 弹确认框（文案含 ask 自动放行 / deny 照拦）→ 确认 → 横幅常驻显示
  3. 自主中发「写文件」→ ask 级不弹审批卡、文件真落盘（自动放行）
  4. 自主中发「偷密钥」（write_file .env）→ deny 硬护栏照拦：.env 零改动、denied_calls+1、同样不弹卡
  5. 全程 .state/approvals.json 零改动（自主放行不落盘）
  6. 点横幅切回 → 横幅隐藏 → 再发「写文件」→ 审批卡恢复弹出 → 按 n 结案
  7. 点模型 pill → 下拉两候选 → 切 k2-thinking → pill 更新 + GET /api/models current 更新

用法：python scripts/walkthrough_batch_d.py [out_dir]   （需 playwright + 本机 Chrome）
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "walkthrough-d"
OUT.mkdir(parents=True, exist_ok=True)
PORT = 17896                      # 临时端口；7788 是用户在用的界面服务，不碰

NOTE_FILE = ROOT / "walkthrough-d-note.txt"
ENV_FILE = ROOT / ".env"
APPROVALS_FILE = ROOT / ".state" / "approvals.json"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  —— ' + str(detail)[:160]) if detail else ''}", flush=True)
    return ok


# ---------------------------------------------------------------- 假模型剧本

def _assistant(text=None, tool_calls=None):
    msg = {"role": "assistant", "content": text or ""}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return msg


def demo_model_fn(messages, tools=None, **kw):
    # 按下标取最后一条 user/tool（dict 等值比较会把两条同文本 user 折叠成同一条——先按下标定位）
    last_i = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=None)
    tool_i = max((i for i, m in enumerate(messages) if m.get("role") == "tool"), default=None)
    if tool_i is not None and (last_i is None or tool_i > last_i):
        return _assistant(f"已执行完：{messages[tool_i].get('content', '')[:80]}")
    text = messages[last_i].get("content", "") if last_i is not None else ""
    if "偷密钥" in text:
        return _assistant(tool_calls=[{"id": "call_deny", "type": "function", "function": {
            "name": "write_file", "arguments": '{"path": ".env", "content": " stolen"}'}}])
    if "写文件" in text:
        return _assistant(tool_calls=[{"id": "call_write", "type": "function", "function": {
            "name": "write_file",
            "arguments": '{"path": "walkthrough-d-note.txt", "content": "批次D走查：ask 级动作。\\n"}'}}])
    return _assistant("批次D走查假模型：发「写文件」=ask 级，发「偷密钥」=deny 级。")


def start_server():
    os.environ["XS_MODELS"] = "k2-thinking"     # 造双候选，走下拉开枝
    from harness import ui_server
    t = threading.Thread(target=ui_server.serve_main,
                         args=(["--port", str(PORT), "--no-browser", "--no-mcp"],),
                         kwargs={"model_fn": demo_model_fn}, daemon=True)
    t.start()
    tf = ROOT / ".state" / "ui_token"
    for _ in range(80):
        time.sleep(0.25)
        if tf.exists():
            return tf.read_text(encoding="utf-8").strip()
    raise RuntimeError("服务未就绪")


def main() -> int:
    token = start_server()
    url = f"http://127.0.0.1:{PORT}/?token={token}"
    env_before = ENV_FILE.read_bytes() if ENV_FILE.exists() else None
    approvals_before = APPROVALS_FILE.read_bytes() if APPROVALS_FILE.exists() else None

    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch(channel="chrome", args=["--no-sandbox"])
        except Exception:
            browser = pw.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url)
        page.wait_for_timeout(2500)

        def state():
            return page.evaluate(
                "fetch('/api/state',{headers:{Authorization:`Bearer ${window.XS.net.getToken()}`}})"
                ".then(r=>r.json())")

        def models():
            return page.evaluate(
                "fetch('/api/models',{headers:{Authorization:`Bearer ${window.XS.net.getToken()}`}})"
                ".then(r=>r.json())")

        def send(text):
            page.fill("#composer-input", text)
            page.keyboard.press("Enter")

        def wait_pred(fn, timeout=12, desc=""):
            for _ in range(int(timeout * 4)):
                if fn():
                    return True
                page.wait_for_timeout(250)
            return False

        # ① 连接 + 初始形态
        pill = page.text_content("#btn-model .pill-text") or ""
        check("1a 模型 pill 显示默认模型", pill.strip() == "kimi-for-coding", f"pill={pill!r}")
        check("1b 自主横幅初始隐藏", page.is_hidden("#autonomy-banner"))
        check("1c 自主开关在场且未按下",
              page.get_attribute("#btn-autonomy", "aria-pressed") == "false")

        # ② 开自主：确认框 → 确认 → 横幅常驻
        page.click("#btn-autonomy")
        page.wait_for_timeout(400)
        box_visible = page.is_visible(".confirm-box")
        body_text = page.text_content(".confirm-body") or ""
        check("2a 开启前弹确认框", box_visible)
        check("2b 确认文案说清 ask 自动放行 + deny 照拦",
              "自动放行" in body_text and "照拦" in body_text, body_text[:60])
        page.screenshot(path=OUT / "d1-confirm.png")
        page.click(".confirm-go")
        ok = wait_pred(lambda: page.is_visible("#autonomy-banner"), desc="横幅")
        check("2c 确认后常驻「自主中」横幅（整条，非小点）", ok)
        check("2d 服务端 autonomy=true", state().get("autonomy") is True)
        page.screenshot(path=OUT / "d2-autonomy-on.png")

        # ③ 自主中 ask 级：不弹卡、真执行
        denied0 = state().get("denied_calls", 0)
        send("写文件")
        ok = wait_pred(lambda: NOTE_FILE.exists())
        check("3a 自主中 ask 级动作自动放行（文件真落盘）", ok)
        check("3b 自主中不弹审批卡", page.locator(".approval").count() == 0)
        page.screenshot(path=OUT / "d3-auto-ask-passed.png")

        # ④ 自主中 deny 级：照拦不误
        send("偷密钥")
        ok = wait_pred(lambda: state().get("denied_calls", 0) > denied0)
        env_after = ENV_FILE.read_bytes() if ENV_FILE.exists() else None
        check("4a 自主中 deny 级照拦（denied_calls +1）", ok)
        check("4b .env 零改动（硬护栏不可绕）", env_after == env_before)
        check("4c deny 也不弹审批卡（硬拒不问）", page.locator(".approval").count() == 0)
        page.screenshot(path=OUT / "d4-deny-blocked.png")

        # ⑤ 不落盘：approvals.json 零改动
        approvals_after = APPROVALS_FILE.read_bytes() if APPROVALS_FILE.exists() else None
        check("5 自主全程 .state/approvals.json 零改动", approvals_after == approvals_before)

        # ⑥ 切回：审批卡恢复
        page.click("#autonomy-banner")
        ok = wait_pred(lambda: page.is_hidden("#autonomy-banner"))
        check("6a 点横幅切回，横幅即隐", ok)
        NOTE_FILE.unlink(missing_ok=True)
        send("写文件")
        ok = wait_pred(lambda: page.locator(".approval").count() > 0)
        check("6b 切回后 ask 恢复弹审批卡", ok)
        page.screenshot(path=OUT / "d5-approval-back.png")
        if ok:
            page.locator(".ap-btn[data-decision='n']").last.click()   # textarea 仍聚焦，全局键 n 会进输入框——点卡片按钮
            wait_pred(lambda: page.locator(".approval.resolved").count() > 0)
            check("6c 点 n 结案（审批通道活着）",
                  page.locator(".approval.resolved").count() > 0)

        # ⑦ 模型下拉
        page.click("#btn-model")
        page.wait_for_timeout(300)
        items = page.locator(".model-item").all_text_contents()
        check("7a 模型下拉弹出两候选", page.is_visible("#model-menu") and len(items) == 2,
              f"items={items}")
        page.screenshot(path=OUT / "d6-model-menu.png")
        page.locator(".model-item", has_text="k2-thinking").click()
        ok = wait_pred(lambda: (page.text_content("#btn-model .pill-text") or "").strip()
                       == "k2-thinking")
        check("7b 切换后 pill 显示 k2-thinking", ok)
        check("7c GET /api/models current=k2-thinking（会话级）",
              models().get("current") == "k2-thinking")
        check("7d default 仍是 .env 默认（重启回默认）",
              models().get("default") == "kimi-for-coding")
        page.screenshot(path=OUT / "d7-model-switched.png")

        check("8 页面零 JS 异常", not errors, errors[:2])
        browser.close()

    NOTE_FILE.unlink(missing_ok=True)
    failed = [n for n, ok, _ in results if not ok]
    print(f"\n== 走查结果: {len(results) - len(failed)}/{len(results)} PASS；截图在 {OUT}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
