#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一「裁剪-重问」子系统 P4 后半 · Mac 真机金标准驱动脚本（可重复跑）。

金标准一（治病根）：look 整屏 → zoom 计算器数字键盘区 → pick 「5」「2」→ 显示屏必须依次出现 5、52。
金标准二（CE 闭环回归）：pick 计算器的 AC/C 键 → 显示屏归零。

设计要点：
- 全程只通过 harness.tools 的 _look/_zoom/_pick 驱动（runner 都不注入 = 真跑真机链路），
  ctx 用最小可用 dict（session_id 供 vision.put_image 落编号图；视口注册表由工具自动挂 ctx）。
- 点击坐标一律来自子系统自己的坐标链（视口编号表里建视口时就换算好的屏幕坐标），脚本不手写点击坐标。
- zoom 用 mark_no 路径（按编号周边自动裁剪，模型零算术）：选 look 编号表里计算器窗口的「组」标记，
  其屏幕框外扩 1.5 倍正好罩住整个计算器（含数字键盘区）。
- 显示屏验证：截图显示屏区域（窗口位置实时从 AX 查询，非手写）→ OCR 读数。
- 证据：每步输出全文 + 编号图/显示屏截图落 docs/验收/裁剪重问-Mac金标准-截图/，汇总日志同目录。

跑法：cd /Users/example/Desktop/小蛇 && python3 evals/gold_standard_mac.py
注意：点击是真鼠标。脚本只点计算器窗口内的键；会把计算器挪到主屏右上桌面区（无窗口遮挡处），
不动用户其它窗口。跑完计算器留在原处（不 quit）。
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from harness import imaging, observe, tools, vision  # noqa: E402

EVID_DIR = os.path.join(REPO, "docs", "验收", "裁剪重问-Mac金标准-截图")
os.makedirs(EVID_DIR, exist_ok=True)

CALC_POS = (2320, 60)      # 主屏右上桌面区（无窗口遮挡；主屏 2560x1440 逻辑点）
CALC_SIZE = (230, 408)     # 基本款计算器窗口尺寸（实测）
SID = "goldstd-mac-" + time.strftime("%Y%m%d-%H%M%S")
ctx = {"session_id": SID}  # 最小可用 ctx：runner 全不注入 = 真跑；注册表工具自动挂

_log_lines = []


def rec(s=""):
    """打印并留档一行证据。"""
    print(s, flush=True)
    _log_lines.append(str(s))


def sh(argv):
    return subprocess.run(argv, capture_output=True, text=True, timeout=30)


def calc_window_pos():
    """实时从 AX 查计算器窗口左上角（逻辑点）——验证截图区域由此推导，不手写。"""
    p = sh(["osascript", "-e",
            'tell application "System Events" to tell process "Calculator" to get position of window 1'])
    nums = re.findall(r"-?\d+", p.stdout or "")
    return (int(nums[0]), int(nums[1])) if len(nums) >= 2 else None


def prepare_calculator():
    """起计算器 → 取消最小化 → 挪到已知桌面位 → 置前。"""
    sh(["open", "-a", "Calculator"])
    time.sleep(1.5)
    r = sh(["osascript", "-e",
            'tell application "System Events" to tell process "Calculator"\n'
            '  set value of attribute "AXMinimized" of window 1 to false\n'
            f'  set position of window 1 to {{{CALC_POS[0]}, {CALC_POS[1]}}}\n'
            '  set frontmost to true\n'
            'end tell'])
    time.sleep(0.8)
    rec(f"[准备] open+取消最小化+挪到 {CALC_POS}+置前：rc={r.returncode} {r.stderr.strip()[:120]}")
    ok, info = observe.focus_window("Calculator")
    rec(f"[准备] focus_window(Calculator)：{ok} {info}")


_MARK_RE = re.compile(r"^(\d+)\. 「(.*?)」 \((-?\d+), (-?\d+)\) \[(\w+)\]$", re.M)


def parse_marks(text):
    """从 look/zoom 输出里解析编号表：{编号: {label, cx, cy, src}}。"""
    return {int(n): {"label": lab, "cx": int(x), "cy": int(y), "src": src}
            for n, lab, x, y, src in _MARK_RE.findall(text)}


def find_mark(marks, label, exact=True):
    """按 label 找编号（精确优先；AC 键可能被 OCR 成 C/AC 两种，调用方传候选）。"""
    for no, m in marks.items():
        if (m["label"] == label) if exact else (label in m["label"]):
            return no
    return None


def display_ocr(tag):
    """截计算器显示屏区域 → 放大 3 倍 → OCR 读数（小 crop 孤立单字符会被 OCR 引擎漏识——
    正是本子系统治的那个病根，验证端同样放大重 OCR）。区域 = 窗口实时位置 + 固定内偏移（实测校准）。
    原图与放大图都落证据目录。返回 (OCR文本 或 None)。
    实测：本机 Vision OCR 对白-on-深灰「0」稳定漏识（zoom 重 OCR 里也从未出现过 0 键），
    故「归零」判定以下方剪贴板读数为准、OCR 只作旁证。"""
    pos = calc_window_pos()
    if not pos:
        rec(f"[验证-{tag}] 拿不到计算器窗口位置，跳过")
        return None
    wx, wy = pos
    # 显示屏=窗口内容区顶部（标题栏 52px + 历史行约 33px 之下，高 50px；实测自 calc_ok.png 校准）
    region = (wx, wy + 85, CALC_SIZE[0], 50)
    png, guide = observe.capture_screenshot(region=region)
    if not png:
        rec(f"[验证-{tag}] 显示屏截图失败：{guide[:80]}")
        return None
    shot = os.path.join(EVID_DIR, f"display-{tag}.png")
    with open(shot, "wb") as f:
        f.write(png)
    w, h, rgba = imaging.decode_png(png)
    nw, nh, up = imaging.upscale(w, h, rgba, 3)          # 放大重 OCR（治病根同款思路；upscale 仅支持 2/3 倍）
    up_png = imaging.encode_png(nw, nh, up)
    shot_up = os.path.join(EVID_DIR, f"display-{tag}-x3.png")
    with open(shot_up, "wb") as f:
        f.write(up_png)
    ok, text = observe.ocr_image(shot_up)
    rec(f"[验证-{tag}] 显示屏截图 display-{tag}.png + x3 放大（region={region}），OCR：{text!r}")
    return text if ok else None


def display_value(tag):
    """权威读数：Calculator 的 Cmd+C 会把显示屏值拷进剪贴板 → pbpaste 读出。
    （harness send_keys 的 mac 修饰键表 ^%=control/option、无 command，故这里直接 osascript——
    仅作验收读数，不属于被测子系统。）"""
    sh(["osascript", "-e",
        'tell application "System Events" to set frontmost of (first process whose name is "Calculator") to true'])
    time.sleep(0.4)
    sh(["osascript", "-e", 'tell application "System Events" to keystroke "c" using command down'])
    time.sleep(0.4)
    p = subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=10)
    val = (p.stdout or "").strip()
    rec(f"[验证-{tag}] Cmd+C 剪贴板读数：{val!r}")
    return val


def copy_vision_images():
    """把本次会话 vision 管道里的编号图（look/zoom 的 SoM 图）拷进证据目录。"""
    refs = ctx.get("_vision_pending", [])
    src_dir = os.path.join(vision.VISION_DIR, SID)
    copied = []
    for ref in refs:
        for ext in (".png", ".jpg"):
            src = os.path.join(src_dir, ref + ext)
            if os.path.exists(src):
                dst = os.path.join(EVID_DIR, f"{SID}-{ref}{ext}")
                shutil.copyfile(src, dst)
                copied.append(os.path.basename(dst))
    rec(f"[证据] vision 编号图落档：{copied or '（无）'}（会话 {SID}，ref={refs}）")


def _root_vid(look_out: str) -> str:
    """从 look 输出解析真实根视口 id——look 重试后根视口是 v2/v3…，zoom 写死 v1 会放大到旧视口的
    错误窗口（2026-07-22 红队真跑复现：会话 goldstd-mac-20260722-224950 金标准一假失败）。解析不到 → ValueError。"""
    m = re.search(r"已建根视口 (v\d+)", look_out)
    if not m:
        raise ValueError(f"look 输出里没找到根视口 id：{look_out[:80]!r}")
    return m.group(1)


def main():
    rec(f"=== 裁剪-重问 Mac 真机金标准 · {time.strftime('%Y-%m-%d %H:%M:%S')} · 会话 {SID} ===")
    # 快照用户剪贴板（纯文本部分）：验证要用 Cmd+C 读计算器显示值，跑完恢复，不弄脏用户现场
    clip0 = subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=10).stdout
    rec(f"[准备] 已快照剪贴板（{len(clip0)} 字符，跑完恢复）")
    prepare_calculator()

    # ── 第一步：look 整屏（焦点可能被其它 app 抢走导致 AX 框源不是计算器 → 重试）──
    marks = {}
    look_out = ""
    for attempt in range(1, 4):
        look_out = tools._look({}, ctx)
        rec(f"\n----- look（第 {attempt} 次）-----\n{look_out}")
        marks = parse_marks(look_out)
        grp = [no for no, m in marks.items() if m["label"] == "组" and m["cx"] > 2000]
        if grp:
            break
        rec(f"[look] 没找到计算器窗口「组」标记（焦点被抢？），重新聚焦重试")
        observe.focus_window("Calculator")
        time.sleep(0.5)
    else:
        rec("!! 三次 look 都没拿到计算器窗口标记，中止")
        return 1

    # 病根探针：整屏编号表里有没有「5」？来源是谁？
    five = [no for no, m in marks.items() if m["label"] == "5"]
    five_src = [marks[no]["src"] for no in five]
    rec(f"\n[病根探针] 整屏 look 编号表里「5」：{'有，编号 ' + str(five) + ' 来源 ' + str(five_src) if five else '没有（整屏漏识别复现）'}")

    # ── 第二步：zoom 计算器窗口标记（mark_no 路径，1.5 倍外扩正好罩住全键盘）──
    # Vision OCR 对稀疏孤立数字有运气成分（同一区域两次跑认出的数字集合会差一两个），
    # 模型实战遇此就是「看不清继续 zoom 迭代收窄」——这里照做：重 zoom 重 OCR，最多 3 次。
    grp_no = [no for no, m in marks.items() if m["label"] == "组" and m["cx"] > 2000][0]
    root_vid = _root_vid(look_out)   # 用本次成功 look 的真实根视口 id（重试后不是 v1）
    sub_id, sub_marks, sub_five = None, {}, []
    for ztry in range(1, 4):
        zoom_out = tools._zoom({"viewport_id": root_vid, "mark_no": grp_no, "k": 3}, ctx)
        rec(f"\n----- zoom({root_vid}, mark_no={grp_no}「组」, k=3)（第 {ztry} 次）-----\n{zoom_out}")
        m = re.search(r"已建子视口 (v\d+)", zoom_out)
        if not m:
            rec("!! zoom 没产出子视口，中止")
            return 1
        sub_id = m.group(1)
        sub_marks = parse_marks(zoom_out)
        # 验收点：放大后重 OCR 必须认出「5」
        sub_five = [no for no, mm in sub_marks.items() if mm["label"] == "5"]
        rec(f"\n[验收点] 子视口 {sub_id} 里「5」：{'有，编号 ' + str(sub_five) + ' 来源 ' + str([sub_marks[no]['src'] for no in sub_five]) if sub_five else '没有，继续 zoom 重试'}")
        if sub_five:
            break
    if not sub_five:
        rec("!! 3 次 zoom 重 OCR 都没认出「5」→ 金标准一失败")
        copy_vision_images()
        return 1
    no5 = sub_five[0]
    no2 = find_mark(sub_marks, "2")
    no_ac = find_mark(sub_marks, "AC") or find_mark(sub_marks, "C")
    rec(f"[子视口] 2 的编号={no2}，AC/C 的编号={no_ac}")
    if no2 is None or no_ac is None:
        rec("!! 子视口里凑不齐 2 / AC 键，中止")
        copy_vision_images()
        return 1

    # ── 第三步：先 pick「AC/C」清零（上一轮可能停在输入态，不清零 pick 5 会成 525 污染判定）──
    rec("\n----- pick「AC/C」（预置清零）-----")
    time.sleep(0.5)
    rec(tools._pick({"viewport_id": sub_id, "mark_no": no_ac}, ctx))
    time.sleep(0.6)
    v_pre = display_value("pre-clear")
    display_ocr("pre-clear")
    rec(f"[预置] 清零后显示屏：剪贴板={v_pre!r}")

    # ── 第四步：pick「5」→ 显示屏必须出现 5（剪贴板读数为主判据，OCR 旁证）──
    rec("\n----- pick「5」-----")
    time.sleep(0.5)
    rec(tools._pick({"viewport_id": sub_id, "mark_no": no5}, ctx))
    time.sleep(0.6)
    v5 = display_value("after-5")
    t5 = display_ocr("after-5")
    ok5 = (v5 == "5") or (bool(t5) and re.search(r"\b5\b", t5.strip()) is not None and "52" not in t5)
    rec(f"[金标准一·第一步] 显示屏出现 5：{'✅' if ok5 else '❌'}（剪贴板={v5!r}，OCR={t5!r}）")

    # ── 第五步：再 pick「2」→ 显示屏必须是 52（坐实不是碰巧）──
    rec("\n----- pick「2」-----")
    time.sleep(0.5)
    rec(tools._pick({"viewport_id": sub_id, "mark_no": no2}, ctx))
    time.sleep(0.6)
    v52 = display_value("after-52")
    t52 = display_ocr("after-52")
    ok52 = (v52 == "52") or (bool(t52) and "52" in t52)
    rec(f"[金标准一·第二步] 显示屏出现 52：{'✅' if ok52 else '❌'}（剪贴板={v52!r}，OCR={t52!r}）")

    # ── 第六步（金标准二 CE 闭环回归）：pick AC/C → 显示屏归零 ──
    rec("\n----- pick「AC/C」-----")
    time.sleep(0.5)
    rec(tools._pick({"viewport_id": sub_id, "mark_no": no_ac}, ctx))
    time.sleep(0.6)
    v0 = display_value("after-ac")
    t0 = display_ocr("after-ac")
    ok0 = (v0 == "0") or (bool(t0) and re.search(r"\b0\b", t0.strip()) is not None and "52" not in t0)
    rec(f"[金标准二] 显示屏归零：{'✅' if ok0 else '❌'}（剪贴板={v0!r}，OCR={t0!r}）")

    copy_vision_images()
    # 恢复用户剪贴板（若快照到的是文本）
    if clip0:
        subprocess.run(["pbcopy"], input=clip0, text=True, timeout=10)
        rec("[收尾] 剪贴板已恢复为开跑前内容")
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
