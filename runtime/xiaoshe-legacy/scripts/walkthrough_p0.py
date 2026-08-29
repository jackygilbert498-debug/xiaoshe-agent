"""P0 真浏览器验收走查。

用法：py -3 scripts/walkthrough_p0.py --scenario modal|keyboard|states|receipt|first|responsive|all --out PATH
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 17897
SCENARIOS = ("modal", "keyboard", "states", "receipt", "first", "responsive")

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")


def check(name: str, ok: bool, detail="") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' — ' + str(detail) if detail else ''}", flush=True)
    if not ok:
        raise AssertionError(name)


@contextmanager
def owned_project(api, name: str):
    """创建本次走查项目，并在任意退出路径只按本次返回的精确 id 清理。"""
    project_id = None
    body_failed = False
    try:
        project = api("POST", "/api/projects", {"name": name})["project"]
        created_id = project.get("id")
        if not isinstance(created_id, str) or not created_id:
            raise RuntimeError("project create response did not include an exact id")
        project_id = created_id
        try:
            yield project
        except BaseException:
            body_failed = True
            raise
    finally:
        if project_id is not None:
            try:
                deleted = api("POST", "/api/projects/delete", {"id": project_id})
                check("仅清理本场景项目", deleted.get("deleted") == project_id, deleted)
            except BaseException as cleanup_error:
                if body_failed:
                    print(
                        f"FAIL  本次走查项目清理失败（保留原始场景异常） — {cleanup_error}",
                        file=sys.stderr,
                        flush=True,
                    )
                else:
                    raise


def _token_signature(token_file: Path):
    try:
        return token_file.stat().st_mtime_ns, token_file.read_text(encoding="utf-8").strip()
    except (FileNotFoundError, OSError):
        return None


def _authenticated_ready(token: str) -> bool:
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/api/state",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=0.5) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def start_server():
    token_file = ROOT / ".state" / "ui_token"
    previous_token = _token_signature(token_file)
    proc = subprocess.Popen(
        [sys.executable, "scripts/serve_demo.py", "--port", str(PORT), "--no-browser"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    ownership_transferred = False
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"P0 走查服务提前退出（退出码 {proc.returncode}）")
            signature = _token_signature(token_file)
            if signature and signature != previous_token:
                token = signature[1]
                if token and _authenticated_ready(token):
                    ownership_transferred = True
                    return proc, token
            time.sleep(0.25)
        raise RuntimeError(f"P0 走查服务未就绪：{PORT} 端口未通过新 token 的鉴权健康检查")
    finally:
        if not ownership_transferred:
            stop_server(proc)


def stop_server(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def modal_scenario(page, out: Path):
    trigger = page.locator("#btn-palette")
    trigger.click()
    check("modal 打开后焦点在 modal 内", page.evaluate(
        "document.querySelector('#modal-root').contains(document.activeElement)"))
    for _ in range(24):
        page.keyboard.press("Tab")
        check("Tab 不逃出 modal", page.evaluate(
            "document.querySelector('#modal-root').contains(document.activeElement)"))
    page.keyboard.press("Escape")
    check("Esc 关闭命令面板", page.locator("#modal-root > *").count() == 0)
    check("关闭后焦点归还触发器", page.evaluate(
        "document.activeElement === document.querySelector('#btn-palette')"))

    page.locator("#btn-autonomy").click()
    check("自主确认框打开", page.locator(".confirm-box").is_visible())
    page.keyboard.press("Escape")
    check("自主确认框 Esc 可关", page.locator(".confirm-box").count() == 0)
    check("确认框关闭焦点归还", page.evaluate(
        "document.activeElement === document.querySelector('#btn-autonomy')"))
    page.screenshot(path=out / "modal-contract.png")


def keyboard_scenario(page, out: Path):
    stamp = str(time.time_ns())[-10:]
    seed_texts = (f"键盘走查会话一-{stamp}", f"键盘走查会话二-{stamp}")
    project_name = f"键盘走查项目-{stamp}"

    def api(method: str, path: str, body=None):
        return page.evaluate("""async ({method, path, body}) => {
          const token = window.XS.net.getToken();
          const response = await fetch(path, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(body == null ? {} : {"Content-Type": "application/json"}),
            },
            body: body == null ? undefined : JSON.stringify(body),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status}`);
          return data;
        }""", {"method": method, "path": path, "body": body})

    def switch_after_idle():
        result = page.evaluate("""async () => {
          const token = window.XS.net.getToken();
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const response = await fetch('/api/sessions/new', {
              method: 'POST',
              headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
              body: '{}',
            });
            const data = await response.json();
            if (!response.ok) throw new Error(`seed session failed: ${response.status}`);
            if (data.switched === true && data.sid) return data;
            if (data.switched !== false) throw new Error(`unexpected switch response: ${JSON.stringify(data)}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error('demo turn did not become idle before session switch');
        }""")
        check("会话造数等待空闲并真实切换", result.get("switched") is True and bool(result.get("sid")), result)
        page.wait_for_selector("#composer-input:not([disabled])")

    # 造两份本场景专属档案；等待真实 assistant 回执，再以 switched=true 作为空闲/切换凭据。
    for text in seed_texts:
        before = page.locator(".msg.assistant").count()
        page.fill("#composer-input", text)
        page.keyboard.press("Enter")
        page.wait_for_function(
            "(count) => document.querySelectorAll('.msg.assistant').length > count",
            arg=before,
            timeout=15000,
        )
        switch_after_idle()

    first_cmd = page.locator(".side-foot .cmd").first
    check("侧栏首命令是原生 button", first_cmd.evaluate("node => node.tagName === 'BUTTON'"))
    first_cmd.focus()
    check("侧栏命令可取得程序化焦点", page.evaluate(
        "document.activeElement === document.querySelector('.side-foot .cmd')"))
    page.evaluate("""() => {
      window.__p0SidebarClicks = 0;
      document.querySelector('.side-foot .cmd').addEventListener(
        'click', () => { window.__p0SidebarClicks += 1; }, {once: true});
    }""")
    page.keyboard.press("Enter")
    check("侧栏命令 Enter 合成 click/dispatch", page.evaluate("window.__p0SidebarClicks === 1"))

    # 项目 prompt 必须是共享中文 modal；Esc 取消不得创建项目。
    project_ids_before = [p["id"] for p in api("GET", "/api/projects").get("projects", [])]
    page.locator("#btn-new-project").click()
    check("项目新建使用共享中文 modal", page.locator(".confirm-box .confirm-title", has_text="新建项目").is_visible())
    page.keyboard.press("Escape")
    page.wait_for_function("document.querySelector('#modal-root').children.length === 0")
    project_ids_after = [p["id"] for p in api("GET", "/api/projects").get("projects", [])]
    check("项目 prompt Esc 取消不执行创建", project_ids_after == project_ids_before)

    # 只创建并操作本次项目；context manager 保证任意后续失败都按返回的精确 id 清理。
    with owned_project(api, project_name):
        switch_after_idle()
        page.wait_for_function(
            "(name) => [...document.querySelectorAll('.proj-name')].some((node) => node.textContent === name)",
            arg=project_name,
        )
        owned_session = page.locator(".sess", has_text=seed_texts[0]).first
        move_trigger = owned_session.locator(".sess-move")
        sid = move_trigger.get_attribute("data-sid")
        move_trigger.click()
        menu_items = owned_session.locator(".sess-menu [role='menuitem']")
        check("项目移动菜单项使用 menuitem", menu_items.count() >= 1)
        check("项目移动菜单打开后聚焦首项", menu_items.first.evaluate("node => document.activeElement === node"))
        page.keyboard.press("Escape")
        check("项目移动菜单 Esc 关闭", owned_session.locator(".sess-menu").count() == 0)
        check("项目移动菜单 Esc 归还匹配触发器", page.evaluate(
            "sid => document.activeElement === document.querySelector(`.sess-move[data-sid='${sid}']`)", sid))
        page.locator(f".sess-move[data-sid='{sid}']").click()
        check("项目移动菜单可再次打开", page.locator(".sess-menu").count() == 1)
        page.locator("#chat-title").click()
        check("项目移动菜单外点关闭", page.locator(".sess-menu").count() == 0)

        # palette 破坏性动作使用共享确认框；Esc 后 token 不变，证明没有执行重置。
        token_before = page.evaluate("window.XS.net.getToken()")
        page.locator("#btn-palette").click()
        page.locator(".pal-item", has_text="重置配对 token").click()
        check("palette 破坏性确认使用共享中文 modal", page.locator(
            ".confirm-box .confirm-title", has_text="重置配对 token").is_visible())
        page.keyboard.press("Escape")
        page.wait_for_function("document.querySelector('#modal-root').children.length === 0")
        check("palette 确认 Esc 取消不执行重置", page.evaluate(
            "token => window.XS.net.getToken() === token", token_before))
        check("palette 确认取消后焦点归还稳定入口", page.evaluate(
            "document.activeElement === document.querySelector('#btn-palette')"))

        # 恢复抽屉必须由 REST 驱动，并使用原生 option button + roving tabindex。
        page.locator("#btn-palette").click()
        with page.expect_request(lambda request: request.method == "GET" and request.url.endswith("/api/sessions")):
            page.locator(".pal-item", has_text="恢复存档").click()
        page.wait_for_selector("button.pal-item[role='option']")
        rows = page.locator("button.pal-item[role='option']")
        check("恢复抽屉来自 REST 且有两份场景档案", rows.count() >= 2 and all(
            page.locator("button.pal-item[role='option']", has_text=text).count() == 1 for text in seed_texts))
        check("恢复抽屉 option 全为原生 button", rows.evaluate_all(
            "nodes => nodes.every((node) => node.tagName === 'BUTTON')"))
        check("恢复抽屉恰有一个 tabindex=0", page.locator(
            "button.pal-item[role='option'][tabindex='0']").count() == 1)
        first = rows.first
        second = rows.nth(1)
        first.focus()
        page.keyboard.press("ArrowDown")
        check("恢复抽屉 ArrowDown roving focus", second.evaluate(
            "node => document.activeElement === node") and page.locator(
            "button.pal-item[role='option'][tabindex='0']").count() == 1)
        page.keyboard.press("ArrowUp")
        check("恢复抽屉 ArrowUp roving focus", first.evaluate(
            "node => document.activeElement === node") and page.locator(
            "button.pal-item[role='option'][tabindex='0']").count() == 1)
        page.keyboard.press("Escape")
        check("恢复抽屉共享 modal Esc 关闭", page.locator("#modal-root > *").count() == 0)
        check("恢复抽屉关闭后焦点归还稳定入口", page.evaluate(
            "document.activeElement === document.querySelector('#btn-palette')"))

        # 再开抽屉，Enter 必须发真实 resume，且仅 resumed=true 才关闭。
        page.locator("#btn-palette").click()
        page.locator(".pal-item", has_text="恢复存档").click()
        target = page.locator("button.pal-item[role='option']", has_text=seed_texts[1])
        target.focus()
        with page.expect_response(lambda response: response.request.method == "POST"
                                  and response.url.endswith("/api/sessions/resume")) as response_info:
            page.keyboard.press("Enter")
        resume_data = response_info.value.json()
        check("恢复抽屉 Enter 真实恢复成功", resume_data.get("resumed") is True, resume_data)
        page.wait_for_function("document.querySelector('#modal-root').children.length === 0")
        page.wait_for_function("(text) => document.body.innerText.includes(text)", arg=seed_texts[1])
        page.screenshot(path=out / "keyboard-contract.png")


def states_scenario(page, out: Path):
    review_failures = []

    def review_check(name: str, ok: bool, detail=""):
        print(f"{'PASS' if ok else 'FAIL'}  {name}{' — ' + str(detail) if detail else ''}", flush=True)
        if not ok:
            review_failures.append(name)

    def fail_json(route):
        route.fulfill(
            status=500,
            content_type="application/json",
            body='{"error":{"code":"forced","message":"走查注入失败","hint":"点重试"}}',
        )

    failed_routes = (
        "**/api/sessions",
        "**/api/projects",
        "**/api/memory/layers",
        "**/api/skills/pending",
    )
    for pattern in failed_routes:
        page.route(pattern, fail_json)
    page.reload(wait_until="domcontentloaded")
    try:
        page.wait_for_function("""() =>
          document.querySelector('#sess-list .p-error')
          && document.querySelectorAll('#p-mem .p-error').length === 3
          && document.querySelectorAll('#p-mem .skel').length === 0
        """, timeout=5000)
    except Exception:
        pass

    session_error = page.locator("#sess-list .p-error")
    check(
        "会话列表失败不是旧态或空态",
        session_error.is_visible()
        and page.locator("#sess-list .sess").count() == 0
        and "暂无历史会话" not in page.locator("#sess-list").inner_text(),
    )
    page.locator(".itab[data-panel='p-mem']").click()
    try:
        page.wait_for_function("""() =>
          document.querySelectorAll('#p-mem .p-error').length === 3
          && document.querySelectorAll('#p-mem .skel').length === 0
        """, timeout=5000)
    except Exception:
        pass
    memory_error_count = page.locator("#p-mem .p-error").count()
    memory_skeleton_count = page.locator("#p-mem .skel").count()
    check(
        "记忆三段分源失败且不永久骨架",
        memory_error_count == 3 and memory_skeleton_count == 0,
        {
            "errors": memory_error_count,
            "skeletons": memory_skeleton_count,
            "text": page.locator("#p-mem").inner_text(),
        },
    )
    page.screenshot(path=out / "states-errors.png")

    for pattern in failed_routes:
        page.unroute(pattern, fail_json)
    page.locator("#sess-list .retry").click()
    page.locator("#p-mem .retry").first.click()
    page.wait_for_function("""() =>
      document.querySelectorAll('#sess-list .p-error, #sess-list .skel').length === 0
      && document.querySelectorAll('#p-mem .p-error, #p-mem .skel').length === 0
    """)
    check("会话真实重试恢复", page.locator("#sess-list .p-error").count() == 0)
    check("记忆真实重试恢复", page.locator("#p-mem .p-error").count() == 0)

    # Review regression 1：编辑后的较旧 memRefresh 不得覆盖较新的共享刷新。
    # POST 在页面层返回 no-op，绝不修改真实 memory；只把随后第一条 layers GET 暂存为旧请求。
    held_layers = []

    def noop_memory_post(route):
        route.fulfill(status=200, content_type="application/json", body='{"ok":true}')

    def hold_first_layers(route):
        if not held_layers:
            held_layers.append(route)
            return
        route.continue_()

    page.route("**/api/memory/item", noop_memory_post)
    page.route("**/api/memory/layers", hold_first_layers)
    page.locator("#p-mem section[data-sec='memory'] .mem-add-in").fill(
        f"no-op review edit {time.time_ns()}"
    )
    with page.expect_request(lambda request: request.method == "GET"
                             and request.url.endswith("/api/memory/layers")):
        page.locator("#p-mem section[data-sec='memory'] .mem-add .mini-btn.ok").click()
    page.wait_for_timeout(50)
    check("no-op 编辑触发较旧 layers 请求", len(held_layers) == 1)
    page.locator(".itab[data-panel='p-mem']").click()
    page.wait_for_function("""() =>
      document.querySelectorAll('#p-mem .p-error, #p-mem .skel').length === 0
    """)
    held_layers[0].fulfill(
        status=500,
        content_type="application/json",
        body='{"error":{"code":"forced","message":"older memRefresh failure"}}',
    )
    page.wait_for_timeout(250)
    review_check(
        "旧 memRefresh 失败不覆盖较新共享刷新成功",
        page.locator("#p-mem .p-error").count() == 0
        and page.locator("#p-mem .skel").count() == 0,
        {
            "errors": page.locator("#p-mem .p-error").count(),
            "skeletons": page.locator("#p-mem .skel").count(),
        },
    )
    page.unroute("**/api/memory/item", noop_memory_post)
    page.unroute("**/api/memory/layers", hold_first_layers)

    # Review regression 2：startLoading 中途真实断线必须进入终态，随后重连恢复。
    held_memory_requests = []

    def hold_memory_request(route):
        held_memory_requests.append(route)

    page.route("**/api/memory/layers", hold_memory_request)
    page.route("**/api/skills/pending", hold_memory_request)
    with (
        page.expect_request(lambda request: request.url.endswith("/api/memory/layers")),
        page.expect_request(lambda request: request.url.endswith("/api/skills/pending")),
    ):
        page.locator(".itab[data-panel='p-mem']").click()
    page.wait_for_function("document.querySelectorAll('#p-mem .skel').length === 3")
    page.evaluate("""async () => {
      const net = await import('/js/net.js');
      net.disconnect();
    }""")
    page.wait_for_function("""() => {
      const input = document.querySelector('#composer-input');
      return input?.disabled && input.placeholder === '连接已断开，正在重连…';
    }""")
    check(
        "真实断线显示精确重连占位",
        page.locator("#composer-input").get_attribute("placeholder") == "连接已断开，正在重连…",
    )
    for route in held_memory_requests:
        route.abort("failed")
    page.unroute("**/api/memory/layers", hold_memory_request)
    page.unroute("**/api/skills/pending", hold_memory_request)
    page.wait_for_timeout(250)
    offline_skeletons = page.locator("#p-mem .skel").count()
    offline_terminal = (
        page.locator("#p-mem .p-disconnected").count()
        + page.locator("#p-mem .p-error").count()
    )
    review_check(
        "memory 中途断线不永久停留骨架",
        offline_skeletons == 0 and offline_terminal >= 1,
        {"skeletons": offline_skeletons, "terminal_states": offline_terminal},
    )
    page.evaluate("""async () => {
      const net = await import('/js/net.js');
      net.connect();
    }""")
    page.wait_for_function("""() => {
      const input = document.querySelector('#composer-input');
      return input && !input.disabled && input.placeholder === '交代小蛇做事…'
        && document.querySelectorAll('#p-mem .p-error, #p-mem .p-disconnected, #p-mem .skel').length === 0;
    }""")
    check(
        "重连后恢复精确输入占位并保持连接",
        not page.locator("#composer-input").is_disabled()
        and page.locator("#composer-input").get_attribute("placeholder") == "交代小蛇做事…",
    )

    attach = page.locator("#btn-attach")
    check(
        "附件入口原生诚实禁用",
        attach.is_disabled()
        and attach.get_attribute("disabled") is not None
        and attach.get_attribute("aria-disabled") == "true"
        and "暂不支持本地选图" in (attach.get_attribute("title") or ""),
    )

    def switch_fresh_session(label: str):
        result = page.evaluate("""async () => {
          const token = window.XS.net.getToken();
          const response = await fetch('/api/sessions/new', {
            method: 'POST',
            headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
            body: '{}',
          });
          const data = await response.json();
          if (!response.ok) throw new Error(`fresh session failed: ${response.status}`);
          return data;
        }""")
        check(label, result.get("switched") is True and bool(result.get("sid")), result)
        page.wait_for_function(
            "(sid) => document.querySelector('#chat-meta')?.textContent.includes(sid)",
            arg=result["sid"],
        )
        return result

    # Review regression 3：fallback 失败必须回滚 DOM/store/title。
    switch_fresh_session("失败回滚走查先真实切到新会话")

    approval_id = page.evaluate("""async () => {
      const store = await import('/js/store.js');
      const requestId = `review-resolved-${Date.now()}`;
      store.ingest({
        type: 'approval.request',
        payload: {
          request_id: requestId,
          tool: 'read_file',
          approval_key: 'review:resolved-card',
          reason: '验证发送回滚不清除无关已决审批',
          args: {path: 'review-only.txt'},
          resolved_path: 'review-only.txt',
          tainted: false,
          force_ask: false,
        },
      });
      store.ingest({
        type: 'approval.resolved',
        payload: {request_id: requestId, decision: 'n'},
      });
      return requestId;
    }""")
    page.locator(
        f'.approval.resolved[data-request-id="{approval_id}"]'
    ).wait_for()
    approval_before = page.evaluate("""async (requestId) => {
      const store = await import('/js/store.js');
      return {
        card: document.querySelectorAll(
          `.approval.resolved[data-request-id="${requestId}"]`
        ).length,
        resolved: store.resolvedApprovals().has(requestId),
      };
    }""", approval_id)
    check(
        "失败回滚前已决审批卡与 store 契约均成立",
        approval_before == {"card": 1, "resolved": True},
        approval_before,
    )

    def fail_send(route):
        route.fulfill(
            status=500,
            content_type="application/json",
            body='{"error":{"code":"forced","message":"forced send failure"}}',
        )

    page.route("**/api/send", fail_send)
    page.evaluate("""async () => {
      const net = await import('/js/net.js');
      const store = await import('/js/store.js');
      net.disconnect();
      store.setConnected(true);
    }""")
    page.wait_for_selector("#composer-input:not([disabled])")
    failed_text = f"失败标题 {str(time.time_ns())[-6:]}"
    page.fill("#composer-input", failed_text)
    with page.expect_response(lambda response: response.url.endswith("/api/send")):
        page.keyboard.press("Enter")
    page.wait_for_function(
        "(text) => ![...document.querySelectorAll('.msg.user')].some((node) => node.textContent.includes(text))",
        arg=failed_text,
    )
    failed_send_state = page.evaluate("""async ({text, approvalId}) => {
      const store = await import('/js/store.js');
      return {
        optimistic: store.messages().filter((message) =>
          message.role === 'user' && message.content === text && message._optimistic).length,
        title: document.querySelector('#chat-title')?.textContent,
        dom: [...document.querySelectorAll('.msg.user')].filter((node) =>
          node.textContent.includes(text)).length,
        approvalCard: document.querySelectorAll(
          `.approval.resolved[data-request-id="${approvalId}"]`
        ).length,
        approvalResolved: store.resolvedApprovals().has(approvalId),
      };
    }""", {"text": failed_text, "approvalId": approval_id})
    review_check(
        "fallback 失败回滚 DOM、store、标题且保留无关已决审批",
        failed_send_state == {
            "optimistic": 0,
            "title": "新会话",
            "dom": 0,
            "approvalCard": 1,
            "approvalResolved": True,
        },
        failed_send_state,
    )
    page.unroute("**/api/send", fail_send)
    page.evaluate("""async () => {
      const net = await import('/js/net.js');
      net.connect();
    }""")
    page.wait_for_function("""() => {
      const input = document.querySelector('#composer-input');
      return input && !input.disabled && input.placeholder === '交代小蛇做事…';
    }""")

    switch_fresh_session("标题走查先真实切到新会话")
    approval_after_switch = page.evaluate("""async (requestId) => {
      const store = await import('/js/store.js');
      return {
        card: document.querySelectorAll(
          `.approval[data-request-id="${requestId}"]`
        ).length,
        resolved: store.resolvedApprovals().has(requestId),
      };
    }""", approval_id)
    review_check(
        "新会话不继承上一会话已决审批",
        approval_after_switch == {"card": 0, "resolved": False},
        approval_after_switch,
    )
    stamp = str(time.time_ns())[-6:]
    raw_title = f"标题  走查 {stamp}"
    expected_title = f"标题 走查 {stamp}"
    page.fill("#composer-input", raw_title)
    page.keyboard.press("Enter")
    page.wait_for_function(
        """async (text) => {
          const store = await import('/js/store.js');
          return store.messages().some((message) =>
            message.role === 'user' && message.content === text && !message._optimistic);
        }""",
        arg=raw_title,
    )
    page.locator(".msg.user", has_text=raw_title).wait_for()
    check("标题等于首条真实用户任务", page.locator("#chat-title").inner_text() == expected_title)
    check("states 最终保持连接", page.evaluate("""async () => {
      const store = await import('/js/store.js');
      return store.get().connected && !document.querySelector('#composer-input').disabled;
    }"""))
    page.screenshot(path=out / "states-contract.png")
    if review_failures:
        raise AssertionError("review regressions: " + "；".join(review_failures))


def receipt_scenario(page, out: Path):
    honest_title = "查看本会话可召回的图片/长文本（压缩前完整历史没有恢复引用）"
    success_text = "recall 回执已到，见消息流"
    offline_text = "未连接，命令未发送"

    # 不让之前场景的 toast 队列污染回执/断线断言。
    page.locator("#toast-root .toast").wait_for(state="detached", timeout=15000)
    page.evaluate("""async () => {
      const store = await import('/js/store.js');
      store.ingest({
        v: 1,
        seq: 9901,
        ts: new Date().toISOString(),
        type: 'compaction.event',
        sid: 'p0',
        payload: {
          kind: 'auto_compact',
          before: {msgs: 50, chars: 150000},
          after: {msgs: 10, chars: 30000},
          cleared: null,
          depth: 0,
        },
      });
    }""")

    recall = page.locator(".cmp-recall").last
    recall.wait_for()
    recall_node = recall.element_handle()
    recall_title = recall.get_attribute("title")
    system_before = page.evaluate("""async () => {
      const store = await import('/js/store.js');
      return store.messages().filter((message) => message.role === 'system').length;
    }""")
    click_snapshot = recall.evaluate("""button => {
      button.click();
      return {
        disabled: button.disabled,
        ariaBusy: button.getAttribute('aria-busy'),
      };
    }""")
    check(
        "recall 点击同步进入 pending",
        click_snapshot == {"disabled": True, "ariaBusy": "true"},
        click_snapshot,
    )
    check("压缩条 recall title 语义诚实", recall_title == honest_title)

    page.wait_for_function("""async (before) => {
      const store = await import('/js/store.js');
      return store.messages().filter((message) => message.role === 'system').length > before;
    }""", arg=system_before, timeout=2000)
    receipt = page.evaluate("""async () => {
      const store = await import('/js/store.js');
      return store.messages().filter((message) => message.role === 'system').at(-1);
    }""")
    receipt_content = str(receipt.get("content") or "")
    check(
        "recall 真实 system message.append 进入 store",
        any(term in receipt_content for term in ("本会话", "匹配", "已排队重看", "引用")),
        receipt_content,
    )
    system_bar = page.locator(".sysbar .sysbar-text").last
    system_bar.wait_for(state="attached", timeout=2000)
    check("recall 真实回执进入消息流", system_bar.text_content() == receipt_content)
    success = page.locator("#toast-root .toast", has_text=success_text)
    success.wait_for(timeout=2000)
    check("recall 成功提示由回执触发", success.inner_text() == success_text)
    check("成功提示不伪称恢复历史", "已召回压缩前内容" not in success.inner_text())
    check(
        "recall 成功后按钮恢复",
        recall_node.evaluate(
            "button => !button.disabled && button.getAttribute('aria-busy') === null"),
    )
    page.screenshot(path=out / "receipt-contract.png")

    # 必须等上一条成功 toast 完全退出，再独立验证 offline 分支。
    page.locator("#toast-root .toast").wait_for(state="detached", timeout=5000)
    page.evaluate("""async () => {
      const net = await import('/js/net.js');
      net.disconnect();
    }""")
    page.wait_for_selector("#composer-input:disabled")
    check(
        "offline recall 时连接已断开",
        page.locator("#composer-input").get_attribute("placeholder") == "连接已断开，正在重连…",
    )
    page.evaluate("""async () => {
      const store = await import('/js/store.js');
      store.ingest({
        v: 1,
        seq: 9902,
        ts: new Date().toISOString(),
        type: 'compaction.event',
        sid: 'p0',
        payload: {
          kind: 'auto_compact',
          before: {msgs: 50, chars: 150000},
          after: {msgs: 10, chars: 30000},
          cleared: null,
          depth: 0,
        },
      });
    }""")
    offline_recall = page.locator(".cmp-recall").last
    offline_recall.wait_for()
    offline_recall_node = offline_recall.element_handle()
    offline_system_before = page.evaluate("""async () => {
      const store = await import('/js/store.js');
      return store.messages().filter((message) => message.role === 'system').length;
    }""")
    offline_recall.click()
    offline = page.locator("#toast-root .toast", has_text=offline_text)
    offline.wait_for(timeout=2000)
    check("offline recall 精确拒绝", offline.inner_text() == offline_text)
    check("offline recall 不出现成功提示", page.locator(
        "#toast-root .toast", has_text=success_text).count() == 0)
    check(
        "offline recall 后按钮恢复",
        offline_recall_node.evaluate(
            "button => !button.disabled && button.getAttribute('aria-busy') === null"),
    )
    page.wait_for_timeout(100)
    offline_system_after = page.evaluate("""async () => {
      const store = await import('/js/store.js');
      return store.messages().filter((message) => message.role === 'system').length;
    }""")
    check("offline recall 没有伪造 system 回执", offline_system_after == offline_system_before)

    page.evaluate("""async () => {
      const net = await import('/js/net.js');
      net.connect();
    }""")
    page.wait_for_selector("#composer-input:not([disabled])", timeout=10000)
    check(
        "receipt 重连后输入态恢复",
        page.locator("#composer-input").get_attribute("placeholder") == "交代小蛇做事…",
    )
    check("receipt 场景结束时真实已重连", page.evaluate("""async () => {
      const store = await import('/js/store.js');
      return store.get().connected;
    }"""))


def first_scenario(page, out: Path):
    expected_sets = {
        ("整理桌面上的文件", "读一张图说说里面有什么", "把这段话改成周报语气"),
        ("检查这个项目现在能不能运行", "帮我找出最近失败的测试", "把今天的改动整理成清单"),
        ("看看屏幕上哪里值得优化", "比较两个方案的取舍", "把这份资料整理成交接说明"),
    }

    def switch_fresh_session(label: str):
        previous_sid = page.evaluate("""async () => {
          const store = await import('/js/store.js');
          return store.get().sid;
        }""")
        result = page.evaluate("""async () => {
          const token = window.XS.net.getToken();
          const response = await fetch('/api/sessions/new', {
            method: 'POST',
            headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
            body: '{}',
          });
          const data = await response.json();
          if (!response.ok) throw new Error(`fresh session failed: ${response.status}`);
          return data;
        }""")
        check(
            label,
            result.get("switched") is True
            and bool(result.get("sid"))
            and result.get("sid") != previous_sid,
            {"previous": previous_sid, "result": result},
        )
        page.wait_for_function("""async ({sid}) => {
          const store = await import('/js/store.js');
          return store.get().sid === sid
            && !store.messages().some((message) => (message.role || 'system') === 'user')
            && document.querySelector('#chat-meta')?.textContent.includes(sid)
            && document.querySelectorAll('.stage-chips .chip').length === 3;
        }""", arg={"sid": result["sid"]})
        return result["sid"]

    def suggestion_group():
        return tuple(page.locator(".stage-chips .chip").all_text_contents())

    sids = [switch_fresh_session("first 走查真实切到无用户空会话")]
    first_group = suggestion_group()
    check("空态显示 3 个建议 chip", len(first_group) == 3, first_group)
    chips = page.locator(".stage-chips .chip")
    check(
        "建议 chip 是原生 button",
        chips.evaluate_all("nodes => nodes.every((node) => node.tagName === 'BUTTON' && node.type === 'button')"),
    )

    page.evaluate("""async () => {
      const store = await import('/js/store.js');
      const sid = store.get().sid;
      store.ingest({
        v: 1,
        seq: 0,
        ts: new Date().toISOString(),
        type: 'message.append',
        sid,
        payload: {
          msg_id: `p0-system-${Date.now()}`,
          role: 'system',
          content: 'first 走查同 sid 空态重建',
          ts: new Date().toISOString(),
        },
      });
    }""")
    page.wait_for_function("""() =>
      document.querySelector('.sysfold')
      && document.querySelectorAll('.stage-chips .chip').length === 3
    """)
    check("同 sid system event 重建建议组稳定", suggestion_group() == first_group)

    groups = [first_group]
    for index in range(3):
        sids.append(switch_fresh_session(f"first 走查真实切换 fresh sid {index + 2}"))
        groups.append(suggestion_group())
    check("4 个 fresh sid 彼此不同", len(set(sids)) == 4, sids)
    check("每组 3 条建议互不重复", all(len(group) == len(set(group)) == 3 for group in groups), groups)
    check("前三个 fresh sid 精确覆盖三组建议", set(groups[:3]) == expected_sets, groups[:3])
    check("4 个连续 fresh sid 形成 A/B/C/A", groups[3] == groups[0], groups)

    chip = page.locator(".stage-chips .chip").first
    chip_text = chip.inner_text()
    page.evaluate("""() => {
      window.__p0SuggestionInputs = 0;
      document.querySelector('#composer-input').addEventListener('input', (event) => {
        if (event.bubbles) window.__p0SuggestionInputs += 1;
      });
    }""")
    chip.click()
    page.wait_for_function("""(text) => {
      const input = document.querySelector('#composer-input');
      return input?.value === text
        && document.activeElement === input
        && window.__p0SuggestionInputs === 1
        && !document.querySelector('#btn-send')?.disabled;
    }""", arg=chip_text)
    click_state = page.evaluate("""async (text) => {
      const store = await import('/js/store.js');
      return {
        domUsers: [...document.querySelectorAll('.msg.user')]
          .filter((node) => node.textContent.includes(text)).length,
        storeUsers: store.messages().filter((message) =>
          message.role === 'user' && message.content === text).length,
        optimistic: store.messages().filter((message) => message._optimistic).length,
      };
    }""", chip_text)
    check(
        "chip 只填入、派发 input 并聚焦，不自动发送",
        click_state == {"domUsers": 0, "storeUsers": 0, "optimistic": 0},
        click_state,
    )
    page.wait_for_timeout(250)
    delayed_send_state = page.evaluate("""async (text) => {
      const store = await import('/js/store.js');
      return {
        domUsers: [...document.querySelectorAll('.msg.user')]
          .filter((node) => node.textContent.includes(text)).length,
        storeUsers: store.messages().filter((message) =>
          message.role === 'user' && message.content === text).length,
        optimistic: store.messages().filter((message) => message._optimistic).length,
      };
    }""", chip_text)
    check("chip 短时后仍未产生 DOM/store 用户消息", delayed_send_state == click_state, delayed_send_state)

    page.fill("#composer-input", "长文本" * 300)
    height = page.locator("#composer-input").evaluate("""node => ({
      actual: node.getBoundingClientRect().height,
      max: Number.parseFloat(getComputedStyle(node).maxHeight),
      scroll: node.scrollHeight,
    })""")
    check("composer computed maxHeight 约为 120px", 119 <= height["max"] <= 121, height)
    check("composer 实际高度不越 CSS 上限", height["actual"] <= height["max"] + 1, height)
    check("composer 长文本真实溢出可滚动", height["scroll"] > height["actual"] + 1, height)
    check("first 场景结束保持连接", page.evaluate("""async () => {
      const store = await import('/js/store.js');
      return store.get().connected && !document.querySelector('#composer-input').disabled;
    }"""))
    page.screenshot(path=out / "first-contract.png")


def responsive_scenario(page, out: Path):
    """窄窗 inspector、collapsed 网格与双主题空态的真浏览器契约。"""
    original_theme = page.evaluate("""() => ({
      stored: localStorage.getItem('xs-theme'),
      current: window.XS.theme.currentTheme(),
    })""")

    def switch_fresh_session():
        result = page.evaluate("""async () => {
          const token = window.XS.net.getToken();
          const response = await fetch('/api/sessions/new', {
            method: 'POST',
            headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
            body: '{}',
          });
          const data = await response.json();
          if (!response.ok) throw new Error(`fresh session failed: ${response.status}`);
          return data;
        }""")
        check(
            "responsive 真实切到 fresh sid",
            result.get("switched") is True and bool(result.get("sid")),
            result,
        )
        page.wait_for_function("""async (sid) => {
          const store = await import('/js/store.js');
          return store.get().sid === sid
            && store.get().connected
            && !store.messages().some((message) => (message.role || 'system') === 'user')
            && document.querySelector('#chat-meta')?.textContent.includes(sid)
            && document.querySelector('.stage-ghost');
        }""", arg=result["sid"])

    def set_collapsed_classes(side: bool, inspector: bool):
        page.evaluate("""({side, inspector}) => {
          const main = document.querySelector('.main');
          main.classList.toggle('side-collapsed', side);
          main.classList.toggle('insp-collapsed', inspector);
        }""", {"side": side, "inspector": inspector})

    def assert_collapsed_widths(width: int):
        page.set_viewport_size({"width": width, "height": 900})
        for side, inspector in ((False, False), (True, False), (False, True), (True, True)):
            set_collapsed_classes(side, inspector)
            page.wait_for_timeout(50)
            sizes = page.evaluate("""() => {
              const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
              const main = rect('.main');
              const side = rect('#side');
              const chat = rect('#chat-area');
              return {
                main: main.width,
                side: side.width,
                chat: chat.width,
                columns: getComputedStyle(document.querySelector('.main')).gridTemplateColumns,
              };
            }""")
            combo = f"side={side},insp={inspector}"
            if width == 1000:
                check(
                    f"1000px {combo} 无 292px 幽灵列",
                    abs(sizes["main"] - sizes["side"] - sizes["chat"]) < 4
                    and 206 <= sizes["side"] <= 214,
                    sizes,
                )
            else:
                check(
                    f"720px {combo} 仅保留 chat 单列",
                    abs(sizes["main"] - sizes["chat"]) < 4
                    and sizes["side"] == 0,
                    sizes,
                )
        set_collapsed_classes(False, False)

    def set_theme(name: str):
        applied = page.evaluate("name => window.XS.theme.setTheme(name)", name)
        check(f"主题 API 设置 {name}", applied == name, applied)
        page.wait_for_function(
            "name => window.XS.theme.currentTheme() === name",
            arg=name,
        )

    try:
        switch_fresh_session()

        page.set_viewport_size({"width": 1600, "height": 900})
        wide = page.evaluate("""() => ({
          side: document.querySelector('#side').getBoundingClientRect().width,
          chat: document.querySelector('#chat-area').getBoundingClientRect().width,
          inspector: document.querySelector('#insp').getBoundingClientRect().width,
        })""")
        check(
            "1600px 桌面三列完整",
            228 <= wide["side"] <= 236
            and wide["chat"] > 900
            and 288 <= wide["inspector"] <= 296,
            wide,
        )
        inspector_toggle = page.locator("#btn-inspector")
        check(
            "1600px 状态面板入口存在且隐藏",
            inspector_toggle.count() == 1 and not inspector_toggle.is_visible(),
        )

        assert_collapsed_widths(1000)
        check(
            "1000px 状态面板入口语义可达",
            inspector_toggle.is_visible()
            and inspector_toggle.get_attribute("type") == "button"
            and inspector_toggle.get_attribute("aria-controls") == "insp"
            and inspector_toggle.get_attribute("aria-expanded") == "false"
            and "状态面板" in inspector_toggle.inner_text()
            and bool(inspector_toggle.get_attribute("title")),
        )

        # 从真实桌面 collapsed 状态进入窄窗，overlay 仍必须恢复完整 tabs/body。
        page.set_viewport_size({"width": 1600, "height": 900})
        page.locator("#insp-collapse").click()
        check(
            "桌面 inspector 折叠仍生效",
            page.locator("#insp").evaluate("node => node.classList.contains('collapsed')")
            and page.locator(".main").evaluate("node => node.classList.contains('insp-collapsed')"),
        )
        page.set_viewport_size({"width": 1000, "height": 900})
        inspector_toggle.click()
        check(
            "窄窗可打开状态 overlay 且 ARIA 同步",
            page.locator("#insp.mobile-open").is_visible()
            and inspector_toggle.get_attribute("aria-expanded") == "true",
        )
        page.locator(".itab[data-panel='p-mem']").click()
        check(
            "desktop collapsed 转窄窗后记忆 tab/body 完整可达",
            page.locator(".insp-head").is_visible()
            and page.locator(".insp-body").is_visible()
            and page.locator("#p-mem").is_visible(),
        )
        collapsed_before_close = page.evaluate("""() => ({
          insp: document.querySelector('#insp').classList.contains('collapsed'),
          main: document.querySelector('.main').classList.contains('insp-collapsed'),
        })""")
        page.locator("#insp-collapse").click()
        check(
            "窄窗 collapse 只关闭 overlay 且保持桌面折叠记忆",
            not page.locator("#insp").evaluate("node => node.classList.contains('mobile-open')")
            and inspector_toggle.get_attribute("aria-expanded") == "false"
            and page.evaluate("""before => ({
              insp: document.querySelector('#insp').classList.contains('collapsed'),
              main: document.querySelector('.main').classList.contains('insp-collapsed'),
            }).insp === before.insp && ({
              insp: document.querySelector('#insp').classList.contains('collapsed'),
              main: document.querySelector('.main').classList.contains('insp-collapsed'),
            }).main === before.main""", collapsed_before_close),
        )
        page.locator("#composer-input").focus()
        page.keyboard.press("Escape")
        check(
            "overlay 已关时 Esc 不劫持焦点",
            page.evaluate("document.activeElement === document.querySelector('#composer-input')"),
        )

        inspector_toggle.click()
        page.keyboard.press("Escape")
        check(
            "Esc 关闭 overlay、同步 ARIA 并归还焦点",
            not page.locator("#insp").evaluate("node => node.classList.contains('mobile-open')")
            and inspector_toggle.get_attribute("aria-expanded") == "false"
            and inspector_toggle.evaluate("node => document.activeElement === node"),
        )

        inspector_toggle.click()
        page.set_viewport_size({"width": 1600, "height": 900})
        check(
            "resize 回桌面自动清 overlay 与 ARIA",
            not page.locator("#insp").evaluate("node => node.classList.contains('mobile-open')")
            and inspector_toggle.get_attribute("aria-expanded") == "false"
            and not inspector_toggle.is_visible(),
        )
        page.locator("#insp-collapse").click()
        check(
            "resize 后桌面 inspector 可正常展开",
            not page.locator("#insp").evaluate("node => node.classList.contains('collapsed')")
            and not page.locator(".main").evaluate("node => node.classList.contains('insp-collapsed')"),
        )

        assert_collapsed_widths(720)
        check("720px 状态面板入口仍可见", inspector_toggle.is_visible())
        inspector_toggle.click()
        page.locator(".itab[data-panel='p-mem']").click()
        check(
            "720px overlay 记忆面板完整可达",
            page.locator("#insp.mobile-open").is_visible()
            and page.locator("#p-mem").is_visible()
            and inspector_toggle.get_attribute("aria-expanded") == "true",
        )
        page.locator("#insp-collapse").click()
        check(
            "720px 关闭后无 overlay 或 collapsed 残留",
            not page.locator("#insp").evaluate(
                "node => node.classList.contains('mobile-open') || node.classList.contains('collapsed')")
            and not page.locator(".main").evaluate("node => node.classList.contains('insp-collapsed')")
            and inspector_toggle.get_attribute("aria-expanded") == "false",
        )

        set_theme("warm")
        light_opacity = page.locator(".stage-ghost").evaluate(
            "node => getComputedStyle(node).opacity")
        check("亮主题 computed ghost opacity=.10", light_opacity == "0.1", light_opacity)
        set_theme("ink-jade")
        dark_opacity = page.locator(".stage-ghost").evaluate(
            "node => getComputedStyle(node).opacity")
        check("暗主题 computed ghost opacity=.06", dark_opacity == "0.06", dark_opacity)

        for theme_name, label in (("warm", "light"), ("ink-jade", "dark")):
            set_theme(theme_name)
            for width in (1600, 1000, 720):
                page.set_viewport_size({"width": width, "height": 900})
                set_collapsed_classes(False, False)
                page.screenshot(path=out / f"responsive-{width}-{label}.png")

        check("responsive 场景结束保持真实连接", page.evaluate("""async () => {
          const store = await import('/js/store.js');
          return store.get().connected && !document.querySelector('#composer-input').disabled;
        }"""))
    finally:
        page.evaluate("""original => {
          window.XS.theme.applyTheme(original.current);
          if (original.stored === null) localStorage.removeItem('xs-theme');
          else localStorage.setItem('xs-theme', original.stored);
        }""", original_theme)
        check(
            "responsive 恢复原主题偏好",
            page.evaluate("""original =>
              window.XS.theme.currentTheme() === original.current
              && localStorage.getItem('xs-theme') === original.stored
            """, original_theme),
        )


def run_scenario(name: str, page, out: Path) -> None:
    if name == "modal":
        modal_scenario(page, out)
        return
    if name == "keyboard":
        keyboard_scenario(page, out)
        return
    if name == "states":
        states_scenario(page, out)
        return
    if name == "receipt":
        receipt_scenario(page, out)
        return
    if name == "first":
        first_scenario(page, out)
        return
    if name == "responsive":
        responsive_scenario(page, out)
        return
    raise RuntimeError(f"P0 场景尚未实现：{name}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="P0 真浏览器验收走查")
    parser.add_argument("--scenario", required=True, choices=(*SCENARIOS, "all"))
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)

    proc = None
    try:
        proc, token = start_server()
        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(args=["--no-sandbox"])
            except Exception:
                browser = pw.chromium.launch(channel="chrome", args=["--no-sandbox"])
            try:
                page = browser.new_page(viewport={"width": 1600, "height": 1000})
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"http://127.0.0.1:{PORT}/?token={token}", wait_until="domcontentloaded")
                page.wait_for_selector("#btn-palette")
                page.wait_for_timeout(1200)

                selected = SCENARIOS if args.scenario == "all" else (args.scenario,)
                for name in selected:
                    run_scenario(name, page, args.out)
                    check(f"{name} 场景无未捕获页面错误", not errors, " | ".join(errors))
            finally:
                browser.close()
        print(f"P0 走查完成：{args.out}", flush=True)
        return 0
    except Exception as exc:
        print(f"FAIL  P0 走查失败 — {exc}", flush=True)
        return 1
    finally:
        stop_server(proc)


if __name__ == "__main__":
    raise SystemExit(main())
