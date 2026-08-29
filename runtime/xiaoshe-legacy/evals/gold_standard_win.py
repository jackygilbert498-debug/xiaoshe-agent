#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一「裁剪-重问」子系统 · Windows 真机金标准驱动脚本（可重复跑）。
换机手册 v10「回 Windows 机要做的事」第 ③ 项；结构/验收点/证据落档照 evals/gold_standard_mac.py。

金标准一（子系统功能链）：look 整屏 → zoom 计算器数字键盘区 → 子视口编号表必须有「5」（来源如实记录）
→ pick「5」「2」→ 显示屏必须依次出现 5、52。
金标准二（CE 闭环回归）：pick 计算器的 CE/C 键 → 显示屏归零。
平台现实（2026-07-23 真机探针矩阵钉死）：spec 原文「zoom 后 OCR 必须认出 5」是 Mac/Vision 语义——
本机 WinRT OCR（en/zh-Hans 双引擎）对计算器键盘/显示屏的孤立数字字形系统性丢弃（1×/2×/3×、深/浅色、
反色、二值化、加白边、单行裁切恒 0 词；字母「CE」与图标文本内嵌数字却认）。故 Win 侧 5 的验收由 UIA
框源承接（任务书已预期「UIA 可能本来就不漏」），OCR 认出与否作为病根探针数据记录，不作通过判据。

设计要点：
- 全程只通过 harness.tools 的 _look/_zoom/_pick 驱动（runner 全不注入 = 真跑真机链路），
  ctx 用最小可用 dict（session_id 供 vision.put_image 落编号图；视口注册表由工具自动挂 ctx）。
- 点击坐标一律来自子系统编号表（视口建表时换算好的屏幕物理坐标），脚本不手写点击坐标。
- zoom 用 mark_no 路径：选 look 编号表里计算器的「数字键盘」Group 标记（Win 计算器 UIA 暴露按键分组，
  相当于 Mac 的窗口「组」），其屏幕框外扩 1.5 倍正好罩住整个数字键盘。
- CE/C 键（「清除条目」「清除」）在数字键盘区上方一行、不进 zoom 子视口 → 从**根视口**编号表 pick
  （视口坐标链同源，仍是子系统 pick，不手写坐标）。
- 显示屏权威读数：UIA AutomationId=CalculatorResults 的 Name（形如「显示为 52」，PowerShell
  System.Windows.Automation 查，仅作验收读数、不属于被测子系统）；显示屏区域截图 ×3 放大重 OCR 作旁证
  （小 crop 孤立单字符会被 OCR 漏——正是本子系统治的病根，验证端同样放大）。
- 病根探针记录：整屏 look 编号表里有没有「5」、来源 uia 还是 ocr；整屏 OCR 词表里有没有「5」
  （look 编号表截断前 40 个时 OCR 词进不了表，故整屏 OCR 词表单独直查一次，纯诊断不驱动点击）。
- 聚焦：先试 observe.focus_window（本机实测被前台锁拒，5/5 失败），回落「点计算器标题栏可见部分」
  真实输入激活（破前台锁）；每个 pick 批次前校验计算器仍是最前，不在则重新点标题栏。
- 证据：编号图（vision 管道）/显示屏截图落 docs/验收/裁剪重问-Win金标准-截图/（.gitignore 已加，含屏幕隐私不入 git），
  全程日志同目录。

跑法：cd /c/Users/example/Desktop/ke && PYTHONIOENCODING=utf-8 py -3 evals/gold_standard_win.py
注意：点击是真鼠标。本机桌面左条 x<425 无窗口遮挡、计算器宽 666 放 (120,200) 会盖住 Kimi Code Web 窗口
左边一条（置前即完整可见，不动它）；点击全部落在计算器窗口内（实际点击的 5/2/CE 三键中心 x=374<425，
恒在可见区）。跑完计算器留在原处（不关闭）。
"""
import base64
import os
import re
import shutil
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from harness import imaging, observe, tools, vision  # noqa: E402

EVID_DIR = os.path.join(REPO, "docs", "验收", "裁剪重问-Win金标准-截图")
os.makedirs(EVID_DIR, exist_ok=True)

CALC_POS = (120, 200)          # 主屏左侧桌面区（本机 3120x2080 物理像素，x<425 无窗口遮挡，实测探针选定）
CALC_TITLES = ("计算器", "Calculator")   # UWP 计算器窗口标题候选（中文机实测「计算器」）
SID = "goldstd-win-" + time.strftime("%Y%m%d-%H%M%S")
ctx = {"session_id": SID}      # 最小可用 ctx：runner 全不注入 = 真跑；注册表工具自动挂

_log_lines = []


def rec(s=""):
    """打印并留档一行证据。"""
    print(s, flush=True)
    _log_lines.append(str(s))


def ps(script):
    """跑一段 PowerShell（与 Mac 版走 osascript 同哲学：系统能力全部 shell out，零第三方依赖）。"""
    return subprocess.run(["powershell", "-NoProfile", "-Command", script],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)


# 计算器窗口/显示屏查询脚本：UIA RootElement 子级里按标题子串找窗口 → BoundingRectangle（DPI 感知后=物理像素，
# 与截图/UIA/click 同系，不发明换算）→ 后代里找 AutomationId=CalculatorResults 的显示屏元素。
# 名字走 base64 回传（防竖线/换行歧义，照 observe 行协议先例）。输出：WIN|x|y|w|h|b64(name) + DISP|x|y|w|h|b64(name)。
def _calc_query_ps(title_b64):
    return ("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n"
            "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();' "
            "-Name D -Namespace W 2>$null;[W.D]::SetProcessDPIAware() | Out-Null\n"
            "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes 2>$null\n"
            f"$t=([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{title_b64}'))).ToLower()\n"
            "$root=[System.Windows.Automation.AutomationElement]::RootElement\n"
            "$wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)\n"
            "$tgt=$null\n"
            "foreach($w in $wins){ try{ $n=$w.Current.Name; if($n -and $n.ToLower().Contains($t)){ $tgt=$w; break } }catch{} }\n"
            "if(-not $tgt){ Write-Output 'ERR|没找到计算器窗口'; return }\n"
            "$b=$tgt.Current.BoundingRectangle\n"
            "$nb=[System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$tgt.Current.Name))\n"
            "Write-Output ('WIN|'+[int]$b.X+'|'+[int]$b.Y+'|'+[int]$b.Width+'|'+[int]$b.Height+'|'+$nb)\n"
            "$cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'CalculatorResults')\n"
            "$disp=$tgt.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$cond)\n"
            "if($disp){ $db=$disp.Current.BoundingRectangle\n"
            "  $dn=[System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$disp.Current.Name))\n"
            "  Write-Output ('DISP|'+[int]$db.X+'|'+[int]$db.Y+'|'+[int]$db.Width+'|'+[int]$db.Height+'|'+$dn)\n"
            "}else{ Write-Output 'DISP|none' }\n")


def _b64dec(s):
    return base64.b64decode(s).decode("utf-8", "replace")


def calc_query():
    """实时查计算器窗口框 + 显示屏元素框/名字（验证区域由此推导，不手写）。找不到窗口 → None。"""
    for title in CALC_TITLES:
        b64 = base64.b64encode(title.encode("utf-8")).decode("ascii")
        p = ps(_calc_query_ps(b64))
        win = re.search(r"WIN\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(\S+)", p.stdout or "")
        if not win:
            continue
        q = {"win": tuple(int(win.group(i)) for i in (1, 2, 3, 4)), "win_name": _b64dec(win.group(5)),
             "disp": None, "disp_name": None}
        disp = re.search(r"DISP\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(\S+)", p.stdout or "")
        if disp:
            q["disp"] = tuple(int(disp.group(i)) for i in (1, 2, 3, 4))
            q["disp_name"] = _b64dec(disp.group(5))
        return q
    return None


def move_calculator():
    """把计算器挪到 CALC_POS（SetWindowPos，SWP_NOSIZE|SWP_NOACTIVATE；只挪被测窗口、不动用户其它窗口）。"""
    b64 = base64.b64encode(CALC_TITLES[0].encode("utf-8")).decode("ascii")
    script = _calc_query_ps(b64) + (
        "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetWindowPos("
        "System.IntPtr h,System.IntPtr after,int x,int y,int cx,int cy,uint f);' -Name M -Namespace W 2>$null\n"
        "$h=[System.IntPtr]$tgt.Current.NativeWindowHandle\n"
        f"[W.M]::SetWindowPos($h,[System.IntPtr]::Zero,{CALC_POS[0]},{CALC_POS[1]},0,0,0x0001 -bor 0x0004) | Out-Null\n")
    p = ps(script)
    rec(f"[准备] SetWindowPos 挪到 {CALC_POS}：{(p.stderr or '').strip()[:80] or 'ok'}")


def calc_is_front():
    """当前最前窗口是不是计算器：capture_ax 枚举的是最前窗口后代树，里面有「数字键盘」分组即是。"""
    els = observe.element_table(observe.capture_ax())
    return any(e["name"] == "数字键盘" for e in els)


def activate_calculator():
    """把计算器带到最前：先试 focus_window（本机实测被前台锁拒），回落「点标题栏可见部分」真实输入激活。
    点击点 = 窗口左上角 +(180,15)（标题栏空白处，本机 x<425 恒可见；单击标题栏无副作用）。"""
    ok, info = observe.focus_window(CALC_TITLES[0])
    rec(f"[聚焦] focus_window({CALC_TITLES[0]})：{ok} {info}")
    if ok:
        return True
    q = calc_query()
    if not q:
        rec("[聚焦] 查不到计算器窗口，激活失败")
        return False
    x, y = q["win"][0] + 180, q["win"][1] + 15
    cok, cerr = observe.click_xy(x, y)
    rec(f"[聚焦] 点计算器标题栏可见部分 ({x},{y}) 激活：{cok} {cerr}")
    time.sleep(0.8)
    return calc_is_front()


def prepare_calculator():
    """起计算器（没开才起）→ 等窗口 → 挪位 → 置前（最多 3 轮）。"""
    if not any(any(t in w for t in CALC_TITLES) for w in observe.list_windows()):
        subprocess.Popen(["powershell", "-NoProfile", "-Command", "Start-Process calc"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        rec("[准备] 计算器没在跑，Start-Process calc 拉起")
    for _ in range(20):
        if calc_query():
            break
        time.sleep(0.5)
    q = calc_query()
    rec(f"[准备] 计算器窗口：{q['win'] if q else None} 标题 {q['win_name'] if q else None!r}")
    move_calculator()
    time.sleep(0.5)
    for attempt in range(1, 4):
        if activate_calculator() and calc_is_front():
            rec(f"[准备] 计算器已到最前（第 {attempt} 轮）")
            return True
        rec(f"[准备] 第 {attempt} 轮置前未确认，重试")
        time.sleep(1.0)
    rec("!! 3 轮都没把计算器置前，中止")
    return False


_MARK_RE = re.compile(r"^(\d+)\. 「(.*?)」 \((-?\d+), (-?\d+)\) \[([\w+]+)\]$", re.M)


def parse_marks(text):
    """从 look/zoom 输出里解析编号表：{编号: {label, cx, cy, src}}（src 含 uia+ocr 双源合并态）。"""
    return {int(n): {"label": lab, "cx": int(x), "cy": int(y), "src": src}
            for n, lab, x, y, src in _MARK_RE.findall(text)}


def find_mark(marks, candidates):
    """按候选 label 精确匹配找编号（候选按优先级序；中文机计算器按键名是「五」「清除条目」这类）。"""
    for want in candidates:
        for no, m in marks.items():
            if m["label"] == want:
                return no
    return None


def display_check(tag):
    """显示屏双读数：权威=UIA CalculatorResults 名字（「显示为 52」→ 52）；旁证=显示屏区域截图 ×3 放大重 OCR。
    原图与放大图都落证据目录。返回 (权威值 或 None, OCR文本 或 None)。"""
    q = calc_query()
    if not q:
        rec(f"[验证-{tag}] 查不到计算器窗口，跳过")
        return None, None
    val = None
    if q["disp_name"]:
        nums = re.findall(r"-?\d+(?:,\d{3})*(?:\.\d+)?", q["disp_name"])
        val = nums[-1].replace(",", "") if nums else None
    rec(f"[验证-{tag}] UIA 权威读数：{q['disp_name']!r} → 值 {val!r}")
    ocr_text = None
    if q["disp"]:
        region = q["disp"]
        png, guide = observe.capture_screenshot(region=region)
        if png:
            shot = os.path.join(EVID_DIR, f"display-{tag}.png")
            with open(shot, "wb") as f:
                f.write(png)
            w, h, rgba = imaging.decode_png(png)
            nw, nh, up = imaging.upscale(w, h, rgba, 3)      # 放大重 OCR（治病根同款思路；upscale 仅支持 2/3 倍）
            up_png = imaging.encode_png(nw, nh, up)
            shot_up = os.path.join(EVID_DIR, f"display-{tag}-x3.png")
            with open(shot_up, "wb") as f:
                f.write(up_png)
            ok, ocr_text = observe.ocr_image(shot_up)
            rec(f"[验证-{tag}] 显示屏截图 display-{tag}.png + x3 放大（region={region}），OCR：{ocr_text!r}")
            if not ok:
                ocr_text = None
        else:
            rec(f"[验证-{tag}] 显示屏截图失败：{guide[:80]}")
    return val, ocr_text


def probe_fullscreen_ocr():
    """病根探针（纯诊断，不驱动点击）：整屏截图直查 OCR 词表——当年病根就是 3120x2080 整屏 OCR 漏孤立「5」。
    look 编号表截断前 40 个时纯 OCR 词进不了表，故这里绕过编号表直查一次。"""
    png, guide = observe.capture_screenshot()
    if not png:
        rec(f"[病根探针] 整屏截图失败：{guide[:80]}")
        return
    import tempfile
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        with open(tmp, "wb") as f:
            f.write(png)
        ok, _text, words = observe.ocr_words(tmp)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    if not ok:
        rec("[病根探针] 整屏 OCR 不可用")
        return
    exact5 = [w["text"] for w in words if w["text"].strip() == "5"]
    has5 = [w["text"] for w in words if "5" in w["text"]]
    rec(f"[病根探针] 整屏 OCR 共 {len(words)} 词；词表里恰好是「5」的词：{len(exact5)} 个"
        f"{'（整屏漏识别复现）' if not exact5 else ''}；含字符 5 的词：{has5[:8]}")


def copy_vision_images():
    """把本次会话 vision 管道里的编号图（look/zoom 的 SoM 图）拷进证据目录。"""
    refs = ctx.get("_vision_pending", [])
    src_dir = os.path.join(str(vision.VISION_DIR), SID)
    copied = []
    for ref in refs:
        for ext in (".png", ".jpg"):
            src = os.path.join(src_dir, ref + ext)
            if os.path.exists(src):
                dst = os.path.join(EVID_DIR, f"{SID}-{ref}{ext}")
                shutil.copyfile(src, dst)
                copied.append(os.path.basename(dst))
    rec(f"[证据] vision 编号图落档：{copied or '（无）'}（会话 {SID}，ref={refs}）")


def _vid_of(out: str, what: str) -> str:
    """从 look/zoom 输出解析真实视口 id——look 重试后根视口是 v2/v3…，写死 v1 会操作到旧视口
    （Mac 红队真跑复现过的坑）。解析不到 → ValueError。"""
    m = re.search(rf"已建{what} (v\d+)", out)
    if not m:
        raise ValueError(f"输出里没找到{what} id：{out[:80]!r}")
    return m.group(1)


def ensure_front():
    """pick 批次前校验计算器仍最前（焦点被抢→点击会打到别的窗口），不在则重新点标题栏，最多 3 次。"""
    for _ in range(3):
        if calc_is_front():
            return True
        rec("[聚焦] 焦点被抢，重新激活计算器")
        activate_calculator()
        time.sleep(0.5)
    rec("!! 计算器无法保持最前，中止")
    return False


def main():
    rec(f"=== 裁剪-重问 Windows 真机金标准 · {time.strftime('%Y-%m-%d %H:%M:%S')} · 会话 {SID} ===")
    # 快照现场：当前打开的窗口 + 最前窗口（跑完不动用户现场，计算器留在原处）
    rec(f"[现场快照] 打开的窗口：{observe.list_windows()}")
    front = re.search(r"^WIN: (.*)$", observe.capture_ax() or "", re.M)
    rec(f"[现场快照] 最前窗口：{front.group(1) if front else '（未取到）'}")
    if not prepare_calculator():
        return 1

    # ── 第一步：look 整屏（焦点被抢导致 UIA 框源不是计算器 → 重聚焦重试）──
    marks, look_out = {}, ""
    for attempt in range(1, 4):
        if not ensure_front():
            return 1
        look_out = tools._look({}, ctx)
        rec(f"\n----- look（第 {attempt} 次）-----\n{look_out}")
        marks = parse_marks(look_out)
        if any(m["label"] == "数字键盘" for m in marks.values()):
            break
        rec("[look] 没找到计算器「数字键盘」标记（焦点被抢？），重新聚焦重试")
    else:
        rec("!! 三次 look 都没拿到计算器窗口标记，中止")
        return 1
    root_vid = _vid_of(look_out, "根视口")

    # 病根探针一：整屏 look 编号表里有没有「5」？来源是 uia 还是 ocr？
    five = [(no, m["label"], m["src"]) for no, m in marks.items() if m["label"] in ("5", "五")]
    rec(f"\n[病根探针] 整屏 look 编号表里「5/五」：{five or '没有'}")
    rec(f"[病根探针] 编号表截断到前 {len(marks)} 个时纯 OCR 词进不了表 → 整屏 OCR 词表单独直查：")
    probe_fullscreen_ocr()

    # ── 第二步：zoom「数字键盘」标记（mark_no 路径，1.5 倍外扩正好罩住全键盘）──
    # 验收点（Win 平台现实，2026-07-23 探针矩阵钉死）：子视口编号表里必须有「5」——来源如实记录。
    # spec 原文「zoom 后 OCR 必须认出 5」是 Mac/Vision 语义；本机 WinRT OCR（en/zh-Hans 双引擎）对计算器
    # 键盘/显示屏的孤立数字字形**系统性丢弃**：1×/2×/3×、深/浅色、反色、二值化、加白边、单行裁切全试过
    # 恒 0 词（同批探针里字母「CE」秒认、桌面图标文本里的数字也认）——zoom-重OCR 疗法对 WinRT 此目标无效。
    # 任务书已预期「Win 计算器按钮是 UIA 元素，UIA 可能本来就不漏」→ 验收=子视口表里有 5（来源任意），
    # OCR 认出与否作为病根探针数据如实记录。子视口没有 5 → 重聚焦重 zoom，最多 3 次。
    pad_no = find_mark(marks, ["数字键盘", "Number pad"])
    sub_id, sub_marks, sub_five = None, {}, []
    for ztry in range(1, 4):
        zoom_out = tools._zoom({"viewport_id": root_vid, "mark_no": pad_no, "k": 3}, ctx)
        rec(f"\n----- zoom({root_vid}, mark_no={pad_no}「数字键盘」, k=3)（第 {ztry} 次）-----\n{zoom_out}")
        try:
            sub_id = _vid_of(zoom_out, "子视口")
        except ValueError:
            rec("!! zoom 没产出子视口，中止")
            return 1
        sub_marks = parse_marks(zoom_out)
        five_all = [(no, mm["label"], mm["src"]) for no, mm in sub_marks.items() if mm["label"] in ("5", "五")]
        five_ocr = [no for no, lab, src in five_all if "ocr" in src]
        rec(f"\n[验收点] 子视口 {sub_id} 里「5/五」：{five_all or '没有'}"
            f"；其中 OCR 认出的（来源含 ocr）：{five_ocr or '没有（WinRT 键盘数字盲区，见探针）'}")
        sub_five = [no for no, _lab, _src in five_all]
        if sub_five:
            break
        rec("[zoom] 子视口没有「5」标记（焦点被抢？），重聚焦重试")
        if not ensure_front():
            return 1
    if not sub_five:
        rec("!! 3 次 zoom 子视口都没有「5」标记 → 金标准一失败")
        copy_vision_images()
        return 1
    no5 = sub_five[0]
    no2 = find_mark(sub_marks, ["2", "二"])
    # CE/C 在键盘区上方一行、不进本子视口 → 从根视口编号表取（同一坐标链）
    no_ce = find_mark(marks, ["清除条目", "CE"]) or find_mark(marks, ["清除", "C"])
    rec(f"[子视口] 5 的编号={no5}，2 的编号={no2}；[根视口] CE/C 的编号={no_ce}"
        f"（label={marks[no_ce]['label']!r}）" if no_ce else f"[子视口] 5={no5} 2={no2}；CE/C 没找到")
    if no2 is None or no_ce is None:
        rec("!! 凑不齐 2 / CE 键，中止")
        copy_vision_images()
        return 1

    # ── 第三步：先 pick「CE」清零（上一轮可能停在输入态，不清零 pick 5 会成 525 污染判定）──
    rec("\n----- pick「CE」（预置清零，根视口）-----")
    if not ensure_front():
        return 1
    time.sleep(0.3)
    rec(tools._pick({"viewport_id": root_vid, "mark_no": no_ce}, ctx))
    time.sleep(0.6)
    v_pre, _ = display_check("pre-clear")
    rec(f"[预置] 清零后显示屏：{v_pre!r}")

    # ── 第四步：pick「5」→ 显示屏必须出现 5（UIA 权威读数为主判据，OCR 旁证）──
    rec("\n----- pick「5」-----")
    if not ensure_front():
        return 1
    time.sleep(0.3)
    rec(tools._pick({"viewport_id": sub_id, "mark_no": no5}, ctx))
    time.sleep(0.6)
    v5, t5 = display_check("after-5")
    ok5 = (v5 == "5") or (bool(t5) and re.search(r"\b5\b", t5) is not None and "52" not in t5)
    rec(f"[金标准一·第一步] 显示屏出现 5：{'✅' if ok5 else '❌'}（UIA={v5!r}，OCR={t5!r}）")

    # ── 第五步：再 pick「2」→ 显示屏必须是 52（坐实不是碰巧）──
    rec("\n----- pick「2」-----")
    if not ensure_front():
        return 1
    time.sleep(0.3)
    rec(tools._pick({"viewport_id": sub_id, "mark_no": no2}, ctx))
    time.sleep(0.6)
    v52, t52 = display_check("after-52")
    ok52 = (v52 == "52") or (bool(t52) and "52" in t52)
    rec(f"[金标准一·第二步] 显示屏出现 52：{'✅' if ok52 else '❌'}（UIA={v52!r}，OCR={t52!r}）")

    # ── 第六步（金标准二 CE 闭环回归）：pick CE/C → 显示屏归零 ──
    rec("\n----- pick「CE/C」（根视口）-----")
    if not ensure_front():
        return 1
    time.sleep(0.3)
    rec(tools._pick({"viewport_id": root_vid, "mark_no": no_ce}, ctx))
    time.sleep(0.6)
    v0, t0 = display_check("after-ce")
    ok0 = (v0 == "0") or (bool(t0) and re.search(r"\b0\b", t0) is not None and "52" not in t0)
    rec(f"[金标准二] 显示屏归零：{'✅' if ok0 else '❌'}（UIA={v0!r}，OCR={t0!r}）")

    copy_vision_images()
    rec(f"\n=== 总结：金标准一 {'✅ 通过' if (ok5 and ok52) else '❌ 未过'}（5:{ok5} 52:{ok52}）；"
        f"金标准二 {'✅ 通过' if ok0 else '❌ 未过'} ===")
    return 0 if (ok5 and ok52 and ok0) else 1


if __name__ == "__main__":
    rc = main()
    log_path = os.path.join(EVID_DIR, f"{SID}-全程日志.txt")
    with open(log_path, "w", encoding="utf-8") as f:
        f.write("\n".join(_log_lines) + "\n")
    print(f"\n全程日志已落档：{log_path}")
    sys.exit(rc)
