"""P3 v2 / P2d · 平台能力层：装眼睛前探两道 macOS TCC 权限 + Windows DPI 前置。

铁律（P2d 验收锚）：未授权要给**结构化引导**、绝不静默失败、绝不假装成功。真机才跑系统命令，
离线 TDD 注入假探针（runner）+ 平台名（plat）。截图/AX 是**两道独立 TCC**：屏幕录制 vs 辅助功能。
"""
from __future__ import annotations

import re
import subprocess
import sys
import tempfile

CAP_GUIDE = ("屏幕录制未授权：系统设置 → 隐私与安全性 → 屏幕录制，勾选你的终端（或 Python），"
             "然后彻底退出并重开终端再试。（未授权时截图通道自动降级，不影响 AX 树/浏览器渲染。）")
AX_GUIDE = ("辅助功能未授权：系统设置 → 隐私与安全性 → 辅助功能，勾选你的终端（或 Python），"
            "然后重开终端再试。（未授权时 AX 树通道降级为仅截图/OCR。）")


def _run(argv, runner):
    if runner is not None:
        return runner(argv)
    try:
        p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=20)
        return (p.returncode, p.stdout, p.stderr)
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return (127, "", str(e))


def ax_unavailable_guide(plat=None) -> str:
    """AX/UIA 元素树拿不到东西时的**平台感知**引导（别在 Windows/Linux 上说 mac 的"辅助功能"，对抗审查修复）。"""
    plat = plat or sys.platform
    if plat == "darwin":
        return "拿不到界面元素——" + AX_GUIDE
    if plat == "win32":
        return "UIA 拿不到窗口元素（前台窗口可能没有可访问元素，或该 app 未适配 UIA）。"
    return "此平台暂不支持 AX/UIA 元素树通道（目前仅 macOS / Windows）。"


def screen_capture_status(runner=None, plat=None):
    """截屏（屏幕录制 TCC）是否可用。返回 (ok, 引导语)；ok=True 时引导语为空。"""
    plat = plat or sys.platform
    if plat != "darwin":
        return (True, "")   # Windows System.Drawing / 其它平台截屏不走 macOS TCC
    fd, tmp = tempfile.mkstemp(suffix=".png")
    import os
    os.close(fd)
    try:
        rc, _out, err = _run(["screencapture", "-x", "-t", "png", tmp], runner)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    if rc == 0 and "could not create image" not in (err or "").lower():
        return (True, "")
    return (False, CAP_GUIDE)


def accessibility_status(runner=None, plat=None):
    """AX 可访问性树（辅助功能 TCC）是否可用。返回 (ok, 引导语)。

    探针必须用**真需要辅助功能权限**的操作——读 `UI elements`（对抗审查修复）。原来的 `count of processes`
    只需 Automation（控制 System Events）授权、不碰 Accessibility TCC，Automation 已授权而辅助功能被拒时会假成功，
    与 observe.capture_ax 真正依赖的 `UI elements` 不一致。
    """
    plat = plat or sys.platform
    if plat != "darwin":
        return (True, "")   # Windows UIA 零授权；其它平台此处不设限
    rc, _out, err = _run(["osascript", "-e",
        'tell application "System Events" to tell (first application process whose frontmost is true) '
        'to return (count of UI elements of front window)'], runner)
    low = (err or "").lower()
    if rc == 0 and "-1719" not in low and "not allowed" not in low:
        return (True, "")
    return (False, AX_GUIDE)


def set_dpi_aware(plat=None) -> bool:
    """Windows：SetProcessDPIAware() 前置（否则截图逻辑像素 vs UIA 物理像素差 2× 全脱靶）。
    非 Windows 无操作。返回是否真的设置成功。绝不因缺 API 崩掉。"""
    plat = plat or sys.platform
    if plat != "win32":
        return False
    try:
        import ctypes
        return bool(ctypes.windll.user32.SetProcessDPIAware())
    except Exception:
        return False


# ── 屏幕执行层尺寸（统一「裁剪-重问」P2：根视口 scale = 截图像素宽 ÷ 本尺寸宽，实测不假设）──
# ⚠ 必须取**主屏**（screencapture 默认只截主显示器）：2026-07-22 真机实证——双显器机上
# Finder「bounds of window of desktop」返回的是**全显器并集**（5120x1440），而主屏截图只有 2560x1440，
# 拿并集当分母会测出 scale=0.5 全错；NSScreen.mainScreen 才与截图/AX/点击同指主屏。
_MAC_SCREEN_SIZE_JXA = ('ObjC.import("AppKit");var f=$.NSScreen.mainScreen.frame;'
                        'f.size.width+","+f.size.height')

# 与 observe._WIN_DPI_AWARE_PS 同款自设 DPI 感知（observe 反向 import 本模块，无法直接复用，注释指向正主）：
# 不 DPI 感知时 PrimaryScreen.Bounds 返回缩放后逻辑尺寸，与物理像素截图差倍率 → scale 测错。
_WIN_SCREEN_SIZE_PS = ("Add-Type -MemberDefinition "
                       "'[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();' "
                       "-Name D -Namespace W 2>$null;[W.D]::SetProcessDPIAware() | Out-Null;"
                       "Add-Type -AssemblyName System.Windows.Forms;"
                       "$b=[Windows.Forms.Screen]::PrimaryScreen.Bounds;Write-Output \"$($b.Width),$($b.Height)\"")


def screen_logical_size(runner=None, plat=None):
    """**主屏**执行层尺寸 (w,h)：Mac=逻辑点（NSScreen.mainScreen，JXA）、Win=DPI 感知后物理像素。
    供根视口实测 scale = 截图像素宽 ÷ 本尺寸宽（Mac Retina=2、Win=1，spec §Mac 适配）。
    拿不到/输出坏 → None（调用方 scale 回退 1.0 并如实说明）。可注入 runner 离线 TDD。"""
    plat = plat or sys.platform
    if plat == "darwin":
        argv = ["osascript", "-l", "JavaScript", "-e", _MAC_SCREEN_SIZE_JXA]
    elif plat == "win32":
        argv = ["powershell", "-NoProfile", "-Command", _WIN_SCREEN_SIZE_PS]
    else:
        return None
    rc, out, _err = _run(argv, runner)
    if rc != 0:
        return None
    nums = [int(round(float(n))) for n in re.findall(r"-?\d+(?:\.\d+)?", out or "")]   # 两平台输出同为 "width,height"
    if len(nums) < 2:
        return None
    w, h = nums[0], nums[1]
    return (w, h) if w > 0 and h > 0 else None
