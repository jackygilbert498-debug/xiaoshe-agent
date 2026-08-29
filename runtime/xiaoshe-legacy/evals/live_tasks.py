"""真 Kimi（--live）验收任务：兑现总方案 P3 验收锚「照稿写码 3 轮内收敛」。

与脚本种子不同：model=真 kimi_chat、prompt=自然话，让**模型自己决定**何时 render_check、看渲染、改代码。
verify 用真渲染核验 DOM 关键文案齐全（= 照稿达标），不是看模型自称。需 .env KIMI_API_KEY + 本地代理 + Chrome。
"""
from __future__ import annotations

from unittest import mock

from harness import kimi_client, permission, render

from .core import Task

_DOC_HTML = ('<body style="font-size:52px;padding:48px;font-family:Arial,sans-serif">'
             '<h1>INVOICE</h1><p>Invoice ID: ORD-8842</p><p>Total: 1666</p>'
             '<p>Status: PAID</p></body>')


def _setup_doc_png(workdir):
    """把一张含已知英文/数字的"文档图" doc.png 渲进 workdir，供模型 read_image 读。"""
    (workdir / "doc.html").write_text(_DOC_HTML, encoding="utf-8")
    with permission.use_root(workdir):
        res = render.render("doc.html")
    (workdir / "doc.png").write_bytes(res.png)


def _verify_doc_read(ctx) -> bool:
    """模型把从图里读到的值写进了 answer.txt，核验含正确的 Invoice ID 与 Total（= 真读懂了图）。"""
    f = ctx["workdir"] / "answer.txt"
    if not f.is_file():
        return False
    txt = f.read_text(encoding="utf-8", errors="replace")
    return "ORD-8842" in txt and "1666" in txt

_P3_PROMPT = (
    "在当前目录写一个登录页面文件 login.html。要求：一个大标题写「登录」；"
    "一个用户名输入框（占位符含「用户名」）；一个密码输入框（占位符含「密码」）；"
    "一个写着「登录」的按钮。写完后，用 render_check 工具渲染 login.html 自检"
    "（keywords 传 [\"登录\",\"用户名\",\"密码\"]）；如果它报告缺关键文案，就改 login.html 再 render_check，"
    "直到关键文案齐全为止。最多改 3 轮。"
)


def _verify_login(ctx) -> bool:
    """真渲染 login.html，核验 DOM 里「登录/用户名/密码」都在 = 照稿达标（不看模型自称）。"""
    wd = ctx["workdir"]
    if not (wd / "login.html").is_file():
        return False
    with mock.patch.object(permission, "ROOT", wd):   # 把渲染根指到本任务 workdir
        try:
            res = render.render("login.html")
        except Exception:
            return False
    if not res.ok:
        return False
    ok, _missing = render.dom_has_all(res.dom, ["登录", "用户名", "密码"])
    return ok


LIVE_SEEDS = [
    Task(
        name="P3照稿写登录页自验收敛",
        prompt=_P3_PROMPT,
        allow=("write_file", "read_file", "render_check"),  # 无头下预放行这三个（render_check 默认 ask）
        make_model=lambda: kimi_client.chat,                # 真 Kimi
        verify=_verify_login,
    ),
    Task(
        name="P3读图像文档",
        prompt=("用 read_image 读一下当前目录的 doc.png 这张发货单图片，"
                "找出里面的 Invoice ID 和 Total，把这两个值写进 answer.txt（一行一个）。"),
        allow=("read_image", "write_file"),
        make_model=lambda: kimi_client.chat,
        setup=_setup_doc_png,
        verify=_verify_doc_read,
    ),
]
