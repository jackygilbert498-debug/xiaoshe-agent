"""P3 v1 · 渲染腿：无头浏览器把工作区内 HTML 渲染成截图 + DOM，供"照稿写码自验"。

心法沿用「循环属于模型，机制属于我们」：这里只负责"渲染 + 取截图/DOM + 廉价硬信号"，
判优与迭代由上层闭环编排。铁律：
- 只渲染 **ROOT 内 file://**、拒 http(s)（远程渲染属 P4，避免变成 SSRF 面）。
- 浏览器命令经**可注入 runner**（真机才 shell out；离线 TDD 注入假 runner）。
- 固定 `--force-device-scale-factor=1`：逻辑像素=物理像素，坐标不脱靶（跨平台/HiDPI 一致）。
- 廉价硬信号（退出码 / DOM 关键字 / 近空白）先粗筛，全绿才值得花一发 Kimi 判优（省按次计费）。
截图字节走 vision 管道（落 blob、发送时尾部 materialize），本模块不碰 base64、不进 history。
"""
from __future__ import annotations

import base64
import functools
import http.server
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass, field

from . import permission

_REMOTE_RE = re.compile(r"^(https?|ftp)://", re.I)

# JS 布局审计（A12 戊·「零幻觉第一道门」）：注进页面 onload 跑，量出确定性的布局硬故障——
# 横向溢出 / 点击目标 <24px / 裂图 / 文字被截断 + §4.5.1 新增 对齐错位/拥挤/遮挡
# （DesignBench 实证缺陷分布前三类：对齐 42.2%/拥挤 18.7%/遮挡 18.1%；「缺图」=既有 broken_images，不重复）——
# 把结果 base64 写进哨兵 div（免疫 http charset）。
# 纯几何测量、不调视觉模型：花一发 Kimi 判优前先粗筛，逮出模型看图也未必注意到的像素级破裂。
# 新三类阈值经真机校准，误报率优先（宁可漏不可滥报）：
# - 对齐：同容器 ≥3 可见兄弟的边缘坐标众数簇（≥60% 且 ≥2 个）之外、偏差 2–30px 者——<2px 是取整噪声、>30px 视为有意布局。
# - 拥挤：相邻块级文本盒紧贴（gap<1px）且面向侧无 padding/border；纵向还须行高 <1.15（行高 normal≈1.2
#   自带呼吸感 → 默认列表/段落天然豁免，校准用例钉死）。
# - 遮挡：文本元素 5 采样点（中心+四象限）被外来上层元素盖 ≥3 点且 ≥60%，上层须不透明背景——
#   fixed 头部只盖顶部边缘/角标 → 采样点多数可见不报；透明点击捕获层 → 不算遮挡；
#   整屏蒙层与 role=dialog/aria-modal 弹窗 → 有意状态（红队校准逮到的误报形态），豁免。
#
# 对抗审查硬化：哨兵 id 带**每次随机 nonce**（页面猜不到 → 无法静态伪造喂假结果/注入，见 render.py 红队 MED）；
# 脚本 append 前先删掉页面里任何 __layout_audit_ 前缀节点（防静态伪造）；解析按 nonce 精确匹配 + 长度上限 + 宽异常收口。
_BODY_CLOSE_RE = re.compile(rb"</body>", re.I)   # 字节级：非 UTF-8 页面不重编码，避免渲染乱码（红队 LOW）
_MAX_SENTINEL_B64 = 200_000                       # 哨兵 base64 长度上限：防超大/深嵌 JSON DoS（红队 LOW）


def _audit_script(nonce: str) -> bytes:
    """构造带 nonce 的审计脚本（字节）。nonce 令哨兵 id 不可被页面静态伪造。"""
    sid = f"__layout_audit_{nonce}__"
    js = (
        '<script>window.addEventListener("load",function(){try{'
        f'var SID={json.dumps(sid)};'
        'var old=document.querySelectorAll("[id^=\\"__layout_audit_\\"]");for(var q=0;q<old.length;q++)old[q].remove();'
        'var vw=window.innerWidth,vh=window.innerHeight,de=document.documentElement;'
        'var out={vw:vw,vh:vh,overflow_x:de.scrollWidth>vw+2,tiny_targets:[],broken_images:[],clipped:[],misaligned:[],crowded:[],occluded:[]};'
        'var ck=document.querySelectorAll("a[href],button,input,select,textarea,[role=button],[onclick]");'
        'for(var i=0;i<ck.length&&out.tiny_targets.length<20;i++){var el=ck[i],r=el.getBoundingClientRect(),st=getComputedStyle(el);'
        'if((r.width===0&&r.height===0)||st.display==="none"||st.visibility==="hidden")continue;'
        'if(r.width<24||r.height<24)out.tiny_targets.push({tag:el.tagName.toLowerCase(),w:Math.round(r.width),h:Math.round(r.height)});}'
        'var im=document.querySelectorAll("img");'
        'for(var j=0;j<im.length&&out.broken_images.length<50;j++){if(im[j].complete&&im[j].naturalWidth===0)out.broken_images.push(1);}'
        'var all=document.querySelectorAll("*");'
        'for(var k=0;k<all.length&&out.clipped.length<50;k++){var e=all[k],cs=getComputedStyle(e);'
        'if((cs.overflow==="hidden"||cs.overflowX==="hidden")&&e.scrollWidth>e.clientWidth+2&&e.clientWidth>0)out.clipped.push(1);}'
        # ---- §4.5.1 新三类：对齐/拥挤/遮挡（纯 DOM 几何判定，误报率优先） ----
        'function VIS(el){var r=el.getBoundingClientRect(),st=getComputedStyle(el);'
        'return r.width>2&&r.height>2&&st.display!=="none"&&st.visibility!=="hidden";}'
        'function TXT(el){var n=el.childNodes;for(var i=0;i<n.length;i++){if(n[i].nodeType===3&&/\\S/.test(n[i].textContent))return true;}return false;}'
        'function MODE(a){var m={},best=0,bc=0;for(var i=0;i<a.length;i++){var k=Math.round(a[i]);m[k]=(m[k]||0)+1;if(m[k]>bc){bc=m[k];best=k;}}return[best,bc];}'
        'var BLOCK={block:1,"inline-block":1,flex:1,"inline-flex":1,grid:1,"inline-grid":1,"list-item":1,"table-cell":1};'
        'var par=document.querySelectorAll("body *");'
        'for(var pi=0;pi<par.length;pi++){'
        'var ch=par[pi].children;if(ch.length<3)continue;'
        'var kids=[],bad=false;'
        'for(var ci=0;ci<ch.length;ci++){var kd=ch[ci],kst=getComputedStyle(kd);'
        'if(kst.position==="absolute"||kst.position==="fixed"){bad=true;break;}'
        'if(VIS(kd))kids.push([kd,kst]);}'
        'if(bad||kids.length<3)continue;'
        'var xs=[],ys=[];'
        'for(var ci=0;ci<kids.length;ci++){var kr=kids[ci][0].getBoundingClientRect();xs.push(kr.left);ys.push(kr.top);}'
        'var mx=MODE(xs),my=MODE(ys);'
        'for(var ci=0;ci<kids.length&&out.misaligned.length<20;ci++){'
        'var dx=Math.abs(Math.round(xs[ci])-mx[0]),dy=Math.abs(Math.round(ys[ci])-my[0]);'
        'if((mx[1]>=2&&mx[1]>=kids.length*0.6&&dx>=2&&dx<=30)||(my[1]>=2&&my[1]>=kids.length*0.6&&dy>=2&&dy<=30)){'
        'out.misaligned.push({tag:kids[ci][0].tagName.toLowerCase(),d:Math.max(dx,dy)});}}'
        'var tk=[];'
        'for(var ci=0;ci<kids.length;ci++){if(TXT(kids[ci][0])&&BLOCK[kids[ci][1].display])tk.push(kids[ci]);}'
        'for(var ti=0;ti+1<tk.length&&out.crowded.length<20;ti++){'
        'var a=tk[ti],b=tk[ti+1],ra=a[0].getBoundingClientRect(),rb=b[0].getBoundingClientRect();'
        'var ox=Math.min(ra.right,rb.right)-Math.max(ra.left,rb.left),oy=Math.min(ra.bottom,rb.bottom)-Math.max(ra.top,rb.top);'
        'var gy=rb.top-ra.bottom,gx=rb.left-ra.right;'
        'if(ox>2&&gy>=-1&&gy<1&&parseFloat(a[1].paddingBottom)===0&&parseFloat(b[1].paddingTop)===0'
        '&&parseFloat(a[1].borderBottomWidth)===0&&parseFloat(b[1].borderTopWidth)===0'
        '&&parseFloat(a[1].lineHeight)<parseFloat(a[1].fontSize)*1.15&&parseFloat(b[1].lineHeight)<parseFloat(b[1].fontSize)*1.15){'
        'out.crowded.push({tag:b[0].tagName.toLowerCase(),gap:Math.round(gy*10)/10});continue;}'
        'if(oy>2&&gx>=-1&&gx<1&&parseFloat(a[1].paddingRight)===0&&parseFloat(b[1].paddingLeft)===0'
        '&&parseFloat(a[1].borderRightWidth)===0&&parseFloat(b[1].borderLeftWidth)===0){'
        'out.crowded.push({tag:b[0].tagName.toLowerCase(),gap:Math.round(gx*10)/10});}}'
        '}'
        'var els=document.querySelectorAll("body *");'
        'function SKIPCOV(tp){var s=getComputedStyle(tp);'
        'if(s.position==="fixed"||s.position==="absolute"){var tr=tp.getBoundingClientRect();'
        'if(tr.width>=vw*0.9&&tr.height>=vh*0.9)return true;}'
        'var e=tp;while(e){if(e.getAttribute&&(e.getAttribute("role")==="dialog"||e.getAttribute("aria-modal")==="true"))return true;e=e.parentElement;}'
        'return false;}'
        'for(var oi=0;oi<els.length&&out.occluded.length<20;oi++){'
        'var oe=els[oi];if(!TXT(oe)||!VIS(oe))continue;'
        'var orc=oe.getBoundingClientRect();'
        'var FR=[[0.5,0.5],[0.25,0.25],[0.75,0.25],[0.25,0.75],[0.75,0.75]],cov=0,tot=0,coverer=null;'
        'for(var fi=0;fi<5;fi++){var fx=orc.left+orc.width*FR[fi][0],fy=orc.top+orc.height*FR[fi][1];'
        'if(fx<0||fy<0||fx>=vw||fy>=vh)continue;tot++;'
        'var tp=document.elementFromPoint(fx,fy);'
        'if(tp&&tp!==oe&&!oe.contains(tp)&&!SKIPCOV(tp)){cov++;coverer=tp;}}'
        'if(tot>0&&cov>=3&&cov>=tot*0.6&&coverer){'
        'var cst=getComputedStyle(coverer),cbg=cst.backgroundColor;'
        'var opa=/^rgb\\(/.test(cbg)||(/^rgba\\(/.test(cbg)&&!/,\\s*0(\\.0+)?\\s*\\)$/.test(cbg));'
        'if(opa||cst.backgroundImage!=="none"){'
        'out.occluded.push({tag:oe.tagName.toLowerCase(),pct:Math.round(cov/tot*100)});}}'
        '}'
        'var d=document.createElement("div");d.id=SID;d.setAttribute("data-b64",btoa(unescape(encodeURIComponent(JSON.stringify(out)))));document.body.appendChild(d);'
        '}catch(err){var d2=document.createElement("div");d2.id=SID;d2.setAttribute("data-b64",btoa(unescape(encodeURIComponent(JSON.stringify({error:String(err).slice(0,120)})))));(document.body||document.documentElement).appendChild(d2);}});</script>'
    )
    return js.encode("utf-8")

# 常见无头浏览器可执行名/路径（Chrome/Edge/Chromium 同族参数）；探测顺序=优先级。
_BROWSER_CANDIDATES = (
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome",
    "microsoft-edge", "msedge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)


def _windows_browser_candidates() -> list:
    """Windows 标准安装路径（按 ProgramFiles/LocalAppData 环境变量动态拼，处理任意盘符）——
    修真 gap：原候选只有 PATH 名 + Mac .app，Windows 上 Chrome/Edge 不在 PATH → render 整能力在 Win 死。"""
    out = []
    for env in ("ProgramFiles", "ProgramFiles(x86)", "LocalAppData"):
        base = os.environ.get(env)
        if not base:
            continue
        out.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
        out.append(os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"))
        out.append(os.path.join(base, "Chromium", "Application", "chrome.exe"))
    return out


def resolve_html(path_str: str):
    """把渲染入参解析成 ROOT 内的本地文件路径：拒 http(s)、过 safe_path 沙箱、须存在。返回 Path。"""
    if _REMOTE_RE.match(str(path_str).strip()):
        raise ValueError("render 只渲染工作区内本地文件，不接 http(s)（远程渲染属 P4）")
    p = permission.safe_path(str(path_str))  # 越界/敏感 → PathError
    if not p.exists():
        raise FileNotFoundError(f"要渲染的文件不存在：{p}")
    if not p.is_file():
        raise IsADirectoryError(f"不是文件：{p}")
    return p


def build_render_argv(browser: str, html_path: str, out_png: str,
                      width: int = 1600, height: int = 1000) -> list:
    """构建无头浏览器渲染命令（Chrome/Edge 同族参数）。逻辑像素=物理像素，长边 ≤1600 与压图预算对齐。"""
    return [
        browser,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        f"--screenshot={out_png}",
        f"--window-size={width},{height}",
        "--force-device-scale-factor=1",
        str(html_path),
    ]


def dom_has_all(dom: str, keywords) -> tuple:
    """廉价 DOM 硬信号：规格里该出现的关键文案是否都在渲染出的 DOM 里。返回 (是否全在, 缺失清单)。"""
    text = dom or ""
    missing = [k for k in (keywords or []) if k and str(k) not in text]
    return (not missing, missing)


def build_dom_argv(browser: str, html_path: str, width: int = 1600, height: int = 1000) -> list:
    """--dump-dom 也钉**同截图视口**（红队 MED：审计几何量与 1600px 截图必须同一视口，否则响应式溢出/小按钮误判）。"""
    return [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            f"--window-size={width},{height}", "--force-device-scale-factor=1",
            "--dump-dom", str(html_path)]


def detect_browser():
    """探测本机可用的无头浏览器；找不到 → RuntimeError（引导用户装 Chrome/Edge），绝不静默坏掉。

    候选 = PATH 名（Linux/PATH 上的）+ Mac .app 绝对路径 + Windows 标准安装路径（env 动态拼）。"""
    for c in list(_BROWSER_CANDIDATES) + _windows_browser_candidates():
        if os.path.isabs(c):
            if os.path.exists(c):
                return c
        elif shutil.which(c):
            return c
    raise RuntimeError("没找到可用的无头浏览器（Chrome/Edge/Chromium）——请安装其一后再用渲染自验。")


def _real_runner(argv):
    """真机 shell out 浏览器；返回 (exit_code, stdout, stderr)。60s 看门狗防卡死。"""
    try:
        p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60)
        return (p.returncode, p.stdout, p.stderr)
    except subprocess.TimeoutExpired:
        return (124, "", "渲染超时（>60s）")
    except (OSError, ValueError) as e:
        return (127, "", f"启动浏览器失败：{e}")


@dataclass
class RenderResult:
    ok: bool
    exit_code: int
    stderr: str = ""
    png: bytes = b""
    dom: str = ""
    audit: dict | None = None   # JS 布局审计结果（audit=True 时；None=未审/老浏览器抓不到哨兵）


def _inject_audit(html_bytes: bytes, nonce: str) -> bytes:
    """把带 nonce 的审计脚本**字节级**注进 </body> 前（无则追加尾部）——不 decode/re-encode，
    保原页面编码不变（非 UTF-8 页面照样正确渲染，红队 LOW）。仅用于临时副本，不碰用户原文件。"""
    script = _audit_script(nonce)
    m = _BODY_CLOSE_RE.search(html_bytes or b"")
    if m:
        return html_bytes[:m.start()] + script + html_bytes[m.start():]
    return (html_bytes or b"") + script


def parse_audit(dom: str, nonce: str) -> dict | None:
    """从 --dump-dom 里按 nonce 精确抠出哨兵（base64→JSON）。抓不到/超长/解析失败返 None。

    按 nonce 匹配（页面伪造的其它 __layout_audit_* 匹配不上）；取**末个**（我们的恒在 body 末尾）；
    base64 长度上限防 DoS；宽异常收口（含 MemoryError/RecursionError）——审计失败绝不阻断渲染。"""
    if not nonce:
        return None
    pat = re.compile(r'id="__layout_audit_' + re.escape(nonce) + r'__"[^>]*data-b64="([A-Za-z0-9+/=]{0,%d})"' % _MAX_SENTINEL_B64)
    matches = pat.findall(dom or "")
    if not matches:
        return None
    try:
        data = json.loads(base64.b64decode(matches[-1]).decode("utf-8"))
        return data if isinstance(data, dict) else None
    except (ValueError, json.JSONDecodeError, MemoryError, RecursionError):
        return None


def _si(x) -> int:
    return int(x) if isinstance(x, (int, float)) else 0


def audit_summary(audit: dict | None) -> str:
    """把审计结果压成一行给模型看的硬信号。**只报结构性计数、绝不回显页面自由文本**（红队 MED：
    src/txt 是页面可控串，回显=二阶注入通道；nonce 已防伪造，但仍不给自由文本落脚点）。"""
    if audit is None:
        return "布局硬信号：未取到（浏览器太老或页面异常）。"
    if audit.get("error"):
        return f"布局硬信号：审计脚本出错（{' '.join(str(audit['error']).split())[:80]}）。"
    probs = []
    if audit.get("overflow_x"):
        probs.append("页面横向溢出（响应式可能破了）")
    tt = audit.get("tiny_targets") or []
    if tt:
        t0 = tt[0] if isinstance(tt[0], dict) else {}
        tag = re.sub(r"[^a-z0-9-]", "", str(t0.get("tag", ""))[:16])   # 标签名消毒（只留标签字符），非自由文本
        probs.append(f"{len(tt)} 个点击目标 <24px（最小如 {tag or '?'} {_si(t0.get('w'))}×{_si(t0.get('h'))}）")
    bi = audit.get("broken_images") or []
    if bi:
        probs.append(f"{len(bi)} 张裂图")            # 不回显 src（页面可控自由文本）
    cl = audit.get("clipped") or []
    if cl:
        probs.append(f"{len(cl)} 处文字被容器截断")
    mi = audit.get("misaligned") or []               # §4.5.1 对齐：兄弟边缘错位 2–30px
    if mi:
        t0 = mi[0] if isinstance(mi[0], dict) else {}
        tag = re.sub(r"[^a-z0-9-]", "", str(t0.get("tag", ""))[:16])
        probs.append(f"{len(mi)} 处兄弟元素边缘错位（疑似对齐破了，如 {tag or '?'} 偏 {_si(t0.get('d'))}px）")
    cr = audit.get("crowded") or []                  # §4.5.1 拥挤：文本盒紧贴零间距（纵向还须行高压榨）
    if cr:
        probs.append(f"{len(cr)} 处文本块紧贴零间距（拥挤）")
    oc = audit.get("occluded") or []                 # §4.5.1 遮挡：文字被不透明上层大面积盖住
    if oc:
        t0 = oc[0] if isinstance(oc[0], dict) else {}
        tag = re.sub(r"[^a-z0-9-]", "", str(t0.get("tag", ""))[:16])
        probs.append(f"{len(oc)} 处文字被上层元素盖住（疑似遮挡，如 {tag or '?'} 约 {_si(t0.get('pct'))}% 采样点被盖）")
    return "布局硬信号：" + ("；".join(probs) + "——先修这些再看整体像不像。" if probs
                            else "无明显布局故障（溢出/裂图/小按钮/截断/对齐/拥挤/遮挡）。")


class _RootServer:
    """把 ROOT 挂成 127.0.0.1 上一个临时 http 服务器（随机端口），渲染完即关。

    安全要点（对抗审查 HIGH 修复）：改用 http 源渲染而非 file://——浏览器不允许 http 页面加载 file:// 子资源
    （scheme 安全边界），彻底堵住模型在自撰 HTML 里塞 `<iframe src="file:///etc/passwd">` 外泄任意本地文件；
    相对子资源经 SimpleHTTPRequestHandler 约束在 ROOT 内、`..` 穿越被其 translate_path 拦掉。
    """
    def __init__(self, root):
        handler = functools.partial(_QuietHandler, directory=str(root))
        self._httpd = http.server.HTTPServer(("127.0.0.1", 0), handler)
        self.port = self._httpd.server_address[1]
        self._t = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._t.start()

    def close(self):
        try:
            self._httpd.shutdown()
            self._httpd.server_close()
        except Exception:
            pass


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # 别把每个请求打到 stderr 污染输出
        pass


def render(path_str, ctx=None, runner=None, browser=None, width: int = 1600, height: int = 1000,
           audit: bool = False) -> RenderResult:
    """把工作区内 HTML 渲染成截图字节 + DOM。真机 shell out（可注入 runner 便于离线 TDD）。

    模型只能给 ROOT 内本地文件路径（拒 http(s)）；内部改经 **127.0.0.1 临时 http 服务器**加载（不用 file://），
    从根上堵住 file:// 子资源外泄任意本地文件（对抗审查 HIGH）。截图字节由调用方塞进 vision 管道（不碰 base64）。
    ok = 退出码 0 且真的截到了非空图。
    audit=True：渲染一份**注了审计脚本的临时副本**（放在原文件同目录，相对资源照常解析；审计脚本仅加隐形哨兵、
    不改观感），从 --dump-dom 抠出布局硬信号（横向溢出/小按钮/裂图/截断/对齐/拥挤/遮挡）到 RenderResult.audit。临时副本用完即删。
    """
    html = resolve_html(path_str)
    root = permission.active_root()
    browser = browser or detect_browser()
    runner = runner or _real_runner
    server = _RootServer(root)
    fd, out_png = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    audit_tmp = None       # 临时副本路径（一旦命名即登记，供 finally 清理——哪怕写了一半也要删，红队 LOW）
    do_audit = False        # 审计副本是否真写成（写失败/无审计=False，退回渲染原文件）
    nonce = uuid.uuid4().hex[:12]
    try:
        if audit:   # 注审计脚本进同目录临时副本（相对资源解析不变；用户原文件不动）
            audit_tmp = html.with_name(f".render_audit_{nonce}.html")
            try:
                audit_tmp.write_bytes(_inject_audit(html.read_bytes(), nonce))
                do_audit = True
            except OSError:
                do_audit = False   # 写不了临时副本 → 退回渲染原文件、不审，不阻断（audit_tmp 仍登记着，finally 会清残留）
        render_path = audit_tmp if do_audit else html
        rel = render_path.relative_to(root).as_posix()
        url = f"http://127.0.0.1:{server.port}/{rel}"
        rc, _out, err = runner(build_render_argv(browser, url, out_png, width, height))
        png = b""
        try:
            with open(out_png, "rb") as f:
                png = f.read()
        except OSError:
            png = b""
        rc2, dom, _err2 = runner(build_dom_argv(browser, url, width, height))   # 审计视口=截图视口（红队 MED）
        return RenderResult(ok=(rc == 0 and bool(png)), exit_code=rc, stderr=err or "",
                            png=png, dom=dom or "", audit=parse_audit(dom, nonce) if do_audit else None)
    finally:
        server.close()
        try:
            os.unlink(out_png)   # 临时截图读完即删
        except OSError:
            pass
        if audit_tmp is not None:
            try:
                audit_tmp.unlink(missing_ok=True)   # 审计副本读完即删（写一半也删，绝不泄漏进用户目录/git）
            except OSError:
                pass
