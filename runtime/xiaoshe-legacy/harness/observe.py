"""P3 v2 · 装眼睛（observe）：把界面读成"带 uid 的元素表"，给模型 grounding。

跨平台三通道（AX/UIA 树 · 截图 · OCR），本模块先落**树通道 + 归一解析**（真机已验 macOS AX 可用、
拉到真 role/name/bbox）。归一 dump 格式 `role | name | pos=x,y | size=WxH`（Mac AX / Win UIA 脚本都吐这格式）
→ 单一解析器，好离线 TDD、跨平台复用。
- ref：本次快照短号（e0/e1…），即用即弃。
- uid：role+name 内容哈希（跨快照尽力稳，供模型回指）；100% 稳的 uid 不存在——动作前须重 observe 校验（v2.3+）。
截图通道走 vision 管道（落 blob、发送尾部 materialize），本模块不碰 base64、不进 history。
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
import subprocess
import sys
import tempfile

from . import platform_caps

# UTF-8 输出前缀：默认 PowerShell 管道输出走本地码页（中文机=GBK），capture_ax 按 utf-8 读会把中文元素名读成乱码
# （真机实测：默认输出 GBK 字节、按 utf-8 解出 �）。钉死 UTF-8 输出，capture_ax 的 utf-8 读才正确。
_PS_UTF8 = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n"

# 共享枚举核（observe 与 invoke 共用，保证元素表 ref 与 $items 索引严丝对齐）：定位前台窗口 → 取整棵**后代**控件树
# （真实按钮/菜单项多嵌在容器 Pane 内，只取直属子会看不到）→ 滤掉隐藏/屏幕外（IsOffscreen）→ 过滤到「有名或已知
# 交互类型」→ 连 role/name/bbox 一并存进 $items（避免打印/点击时再读属性抛错导致两侧索引错位）。真机验过（计算器 51 后代）。
_WIN_ENUM_CORE = r'''
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes 2>$null
$fg=[System.Windows.Automation.AutomationElement]::FocusedElement
try{ $win=$fg; while($win.Current.ControlType.ProgrammaticName -ne "ControlType.Window" -and $win){ $win=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($win) } }catch{}
if(-not $win){ $win=[System.Windows.Automation.AutomationElement]::RootElement }
$isCtrl=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsControlElementProperty,$true)
$notOff=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsOffscreenProperty,$false)
$cond=New-Object System.Windows.Automation.AndCondition($isCtrl,$notOff)
$all=$win.FindAll([System.Windows.Automation.TreeScope]::Descendants,$cond)
$items=New-Object System.Collections.ArrayList
foreach($el in $all){ if($items.Count -ge 60){break}
  try{
    $r=$el.Current.ControlType.ProgrammaticName -replace "ControlType\.",""
    $nm=$el.Current.Name; if($nm){$nm=$nm -replace "[\r\n\t]+"," "}; $b=$el.Current.BoundingRectangle
    if($nm -ne "" -or $r -eq "Button" -or $r -eq "MenuItem" -or $r -eq "CheckBox" -or $r -eq "RadioButton" -or $r -eq "TabItem" -or $r -eq "ListItem" -or $r -eq "Hyperlink"){
      [void]$items.Add([pscustomobject]@{El=$el;R=$r;N=$nm;X=[int]$b.X;Y=[int]$b.Y;W=[int]$b.Width;H=[int]$b.Height})
    }
  }catch{}
}
'''

# observe 抽取脚本 = UTF-8 前缀 + 共享枚举核 + 打印 $items（真机验过，Windows 后代控件树、中文名不乱码）。
_WIN_UIA_PS = _PS_UTF8 + _WIN_ENUM_CORE + r'''
Write-Output ("WIN: "+($win.Current.Name -replace "[\r\n\t]+"," "))
foreach($it in $items){ Write-Output ("{0} | {1} | pos={2},{3} | size={4}x{5}" -f $it.R,$it.N,$it.X,$it.Y,$it.W,$it.H) }
'''

_LINE_RE = re.compile(r"^(?P<role>\S[^|]*?)\s*\|\s*(?P<rest>.*)$")
_POS_RE = re.compile(r"pos=(-?\d+),(-?\d+)")
_SIZE_RE = re.compile(r"size=(-?\d+)x(-?\d+)")   # 接受负宽/高（对抗审查 #15）：负尺寸元素也解析进表、保持与 invoke 的 $items 索引一一对齐，别静默丢行致 click 错位

# macOS AX 抽取脚本（真机验过：拉窗口直属元素的 role/name/pos/size）；Win 端有对应 UIA 脚本吐同格式。
AX_SCRIPT = r'''tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set out to "APP: " & (name of frontApp) & linefeed
  try
    set win to front window of frontApp
    set out to out & "WIN: " & (name of win) & linefeed
    set kids to UI elements of win
    set n to 0
    repeat with el in kids
      if n ≥ 40 then exit repeat
      try
        set nm to ""
        try
          set nm to name of el
        end try
        if nm is missing value or nm is "" then
          try
            set nm to description of el
          end try
        end if
        try
          set nm to nm as text
        on error
          set nm to ""
        end try
        set AppleScript's text item delimiters to {return, linefeed, tab}
        set nm to text items of nm
        set AppleScript's text item delimiters to " "
        set nm to (nm as text)
        set AppleScript's text item delimiters to ""
        set pos to position of el
        set sz to size of el
        set out to out & (role of el) & " | " & nm & " | pos=" & (item 1 of pos) & "," & (item 2 of pos) & " | size=" & (item 1 of sz) & "x" & (item 2 of sz) & linefeed
        set n to n + 1
      end try
    end repeat
  on error errMsg
    set out to out & "ERR: " & errMsg
  end try
  return out
end tell'''


def parse_elements(raw: str) -> list:
    """把归一 dump `role | name | pos=x,y | size=WxH` 解析成 [{role,name,x,y,w,h}]。

    **从右侧锚定** pos/size（取末两个 ' | ' 字段），name 是不可信界面文本、其中若含 pos=/size= 字面串也不会
    劫持真坐标（对抗审查修复）；name 含 '|'/' - ' 也完整保留。字段不足/坏行跳过、不炸。
    """
    out = []
    # 只按 \n 切记录（capture_ax 走 text=True 已把 \r\n/\r 归一成 \n）。**不用 str.splitlines()**：它的换行集比
    # 源头清洗的 [\r\n\t] 宽（还含 VT/FF/NEL/U+2028/U+2029/FS-RS），名字里放一个这类字符就能穿过清洗却被 splitlines
    # 拆断该元素记录行 → 元素被丢、后续 ref 前移、与 invoke 的 index 错位点错元素（对抗审查坐实的 HIGH）。按 \n 切则这些
    # 字符原样留在 name 里（无害），保证一元素恒一行、ref 与 invoke 严丝对齐。
    for line in (raw or "").split("\n"):
        line = line.strip()
        if not line or line.startswith(("APP:", "WIN:", "ERR:", "(")):
            continue
        parts = line.split(" | ")
        if len(parts) < 4:
            continue                      # 至少 role|name|pos|size 四段
        pos = _POS_RE.search(parts[-2])   # 末两段才是真 pos/size，只在它们上匹配
        size = _SIZE_RE.search(parts[-1])
        if not pos or not size:
            continue
        role = parts[0].strip()
        name = " | ".join(parts[1:-2]).strip()   # 中间段全是 name（保留内部分隔符）
        out.append({"role": role, "name": name,
                    "x": int(pos.group(1)), "y": int(pos.group(2)),
                    "w": int(size.group(1)), "h": int(size.group(2))})
    return out


def _uid(role: str, name: str, occ: int) -> str:
    base = hashlib.sha1(f"{role}|{name}".encode("utf-8")).hexdigest()[:6]
    return f"{base}-{occ}" if occ else base


def element_table(raw: str) -> list:
    """解析 + 赋 ref（本次快照 e0/e1…）+ uid（role+name 哈希，同名按出现序加后缀去重）。"""
    els = parse_elements(raw)
    seen: dict = {}
    for i, e in enumerate(els):
        e["ref"] = f"e{i}"
        key = (e["role"], e["name"])
        occ = seen.get(key, 0)
        seen[key] = occ + 1
        e["uid"] = _uid(e["role"], e["name"], occ)
    return els


def diff_tables(before: list, after: list) -> dict:
    """按 uid 比两次 observe 的元素表，返回 {added, removed}（动作后自动汇报"变了什么"，v3 §5 Verify）。

    uid=role+name 哈希：名字变了（如显示读数 5→55）→ 旧 uid 消失、新 uid 出现，正好体现为 removed+added，
    对模型就是"读数从 5 变成了 55"这类可读信号；纯位置移动（uid 不变）不算变化、不刷屏。
    """
    b = {e["uid"]: e for e in before}
    a = {e["uid"]: e for e in after}
    added = [e for u, e in a.items() if u not in b]
    removed = [e for u, e in b.items() if u not in a]
    return {"added": added, "removed": removed}


def capture_ax(runner=None, plat=None) -> str:
    """跑平台对应的可访问性树抽取，返回归一 dump（可注入 runner 离线 TDD）。失败回空串（调用方降级）。

    macOS = osascript(AX)；Windows = powershell(UIA 后代控件树，真机验过：计算器 43 元素/中文名不乱码)；其它平台回空串。归一格式两平台一致，
    parse_elements/element_table 复用同一解析器。
    """
    plat = plat or sys.platform
    if plat == "win32":
        script, argv = _WIN_UIA_PS, ["powershell", "-NoProfile", "-Command", _WIN_UIA_PS]
    else:  # darwin（真机）/ 或注入 runner 的测试：用 mac AX 脚本作载体
        script, argv = AX_SCRIPT, ["osascript", "-e", AX_SCRIPT]
    if runner is not None:
        return runner(script)            # 注入了 runner 就一定用它（测试的平台覆盖，与 OS 无关）
    if plat not in ("darwin", "win32"):
        return ""                        # 真机 + 不支持平台 + 无 runner → 空串降级
    try:
        p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=20)
        return p.stdout if p.returncode == 0 else ""
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return ""


# ── 编程点击（Act 段）：按 observe 元素表的 index 走无障碍接口触发默认动作，零坐标 ──
# 复用 observe 的同一枚举核 _WIN_ENUM_CORE 构建 $items（同一后代枚举/过滤），故 $items[index] 恒等于元素表 ref=index
# 的那个元素；命中后取 InvokePattern 触发（缺失退 LegacyIAccessible.DoDefaultAction）。真机验过（计算器点按钮生效）。
_WIN_INVOKE_PS_TMPL = _PS_UTF8 + _WIN_ENUM_CORE + r'''
if(__IDX__ -lt 0 -or __IDX__ -ge $items.Count){ Write-Output "ERR|index 超出范围或元素已消失（请重新 observe）" }
else{
  $it=$items[__IDX__]; $el=$it.El
  try{ $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Write-Output ("OK|{0}|{1}" -f $it.R,$it.N) }
  catch{ try{ $el.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern).DoDefaultAction(); Write-Output ("OK|{0}|{1}" -f $it.R,$it.N) }
         catch{ Write-Output ("ERR|{0} 无可点击接口(InvokePattern/DoDefaultAction 均不可用)" -f $it.N) } }
}
'''

# ⚠ 未在真 Mac 验证：mirror AX_SCRIPT 的迭代/跳过，对第 index 个成功元素 AXPress（AppleScript 1 基，故 +1 手动对齐）。
_MAC_INVOKE_AS_TMPL = r'''tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set win to front window of frontApp
  set kids to UI elements of win
  set n to 0
  repeat with el in kids
    if n ≥ 40 then exit repeat
    try
      set r to role of el
      set nm to ""
      try
        set nm to name of el
      end try
      if nm is missing value or nm is "" then
        try
          set nm to description of el
        end try
      end if
      try
        set nm to nm as text
      on error
        set nm to ""
      end try
      set AppleScript's text item delimiters to {return, linefeed, tab}
      set nm to text items of nm
      set AppleScript's text item delimiters to " "
      set nm to (nm as text)
      set AppleScript's text item delimiters to ""
      set pos to position of el
      set sz to size of el
      if n = __IDX__ then
        perform action "AXPress" of el
        return "OK|" & r & "|" & nm
      end if
      set n to n + 1
    end try
  end repeat
end tell
return "ERR|index 超出范围或元素已消失"'''


def _win_invoke_ps(index: int) -> str:
    return _WIN_INVOKE_PS_TMPL.replace("__IDX__", str(int(index)))


def _mac_invoke_as(index: int) -> str:
    return _MAC_INVOKE_AS_TMPL.replace("__IDX__", str(int(index)))


def _ps_b64(s: str) -> str:
    """把自由文本编码成 base64（纯 ASCII、无引号/元字符）——脚本里 FromBase64String 解回，彻底杜绝把文本拼进 PS 引号串。
    ASCII 单引号转义挡不住 PowerShell 分词器把 Unicode 引号同形字 U+2018/2019/201A/201B 也当定界符 → 曾致 RCE（对抗审查逮出）。"""
    return base64.b64encode((s or "").encode("utf-8")).decode("ascii")


def _win_sendkeys_ps(keys: str) -> str:
    b64 = _ps_b64(keys)   # keys 走 base64 传入、脚本内解码；绝不把自由文本拼进单引号串（防同形字逃逸 RCE）
    return (_PS_UTF8 +
            "Add-Type -AssemblyName System.Windows.Forms,UIAutomationClient,UIAutomationTypes 2>$null\n"
            "$fg=[System.Windows.Automation.AutomationElement]::FocusedElement\n"
            'try{ $win=$fg; while($win.Current.ControlType.ProgrammaticName -ne "ControlType.Window" -and $win){ $win=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($win) } }catch{}\n'
            "$wn= if($win){ $win.Current.Name }else{ '?' }\n"
            f"$k=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{b64}'))\n"
            "[System.Windows.Forms.SendKeys]::SendWait($k)\n"
            'Write-Output ("OK|"+$wn)\n')


# SendKeys 特殊键 → macOS 虚拟键码（key code）。花括号语法 {ENTER}/{TAB}/… 在 Windows 由 Forms.SendKeys 解释，
# Mac 必须显式译成 key code，否则被当字面字符逐个打（{ENTER} 打出 7 个字符而非回车、快捷键从不触发还谎报成功）。
_MAC_KEYCODES = {
    "ENTER": 36, "RETURN": 36, "TAB": 48, "ESC": 53, "ESCAPE": 53,
    "BACKSPACE": 51, "BS": 51, "BKSP": 51, "DELETE": 117, "DEL": 117,
    "SPACE": 49, "UP": 126, "DOWN": 125, "LEFT": 123, "RIGHT": 124,
    "HOME": 115, "END": 119, "PGUP": 116, "PGDN": 121,
    "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
    "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
}
# SendKeys 修饰前缀（作用于紧随其后的一个键）→ AppleScript using 修饰子句。语义按工具文档：^=Ctrl %=Alt +=Shift。
_MAC_MODS = {"^": "control down", "%": "option down", "+": "shift down"}


def _mac_keys_statements(keys: str) -> list:
    """把 SendKeys 语法串译成一串 AppleScript 语句（每键一句）：普通字符→keystroke；{ENTER}/{TAB}/{F5}…→key code；
    前缀 ^%+ 修饰下一个键→using 子句。未知 {XXX} 退化成按字面逐字打（不静默吞）；裸 \\r\\n 视作回车。每个字面字符单独转义。"""
    def esc(c):
        return c.replace("\\", "\\\\").replace('"', '\\"')
    out, mods, i, n = [], [], 0, len(keys)
    while i < n:
        ch = keys[i]
        if ch in _MAC_MODS:
            mods.append(_MAC_MODS[ch]); i += 1; continue
        using = f" using {{{', '.join(mods)}}}" if mods else ""
        if ch == "{":
            j = keys.find("}", i + 1)
            if j != -1:
                inner = keys[i + 1:j]
                name = inner.strip().upper().split(" ")[0]   # {a 5} 重复语法只取键名首段
                if name in _MAC_KEYCODES:
                    out.append(f"key code {_MAC_KEYCODES[name]}{using}")
                elif len(inner) == 1:                        # {(} {^} {+} 等转义单字符字面
                    out.append(f'keystroke "{esc(inner)}"{using}')
                else:                                        # 未知特殊键：按字面逐字打，别静默吞
                    for c in "{" + inner + "}":
                        out.append(f'keystroke "{esc(c)}"')
                mods = []; i = j + 1; continue
            # 无闭合 } → 当字面 { 处理（落到下方）
        if ch in ("\n", "\r"):
            out.append(f"key code 36{using}"); mods = []; i += 1; continue   # 裸换行→回车
        out.append(f'keystroke "{esc(ch)}"{using}'); mods = []; i += 1
    return out


def _mac_sendkeys_as(keys: str) -> str:
    """把 SendKeys 语法译成 AppleScript 逐键发送（特殊键走 key code、修饰键走 using 子句），并回读真实最前进程名。
    修复：旧码 `keystroke "整串"` 把 {ENTER}/^s 当字面字符打（回车/快捷键从不触发还谎报成功）。⚠未真机验证。"""
    lines = ['tell application "System Events"']
    lines += ["  " + s for s in _mac_keys_statements(keys)]
    lines.append('  set fp to name of first application process whose frontmost is true')
    lines.append('  return "OK|" & fp')
    lines.append('end tell')
    return "\n".join(lines)


def send_keys(keys, runner=None, plat=None):
    """向**最前窗口**发送键盘输入（SendKeys 语法），返回 (ok, 目标窗口名或错误)。可注入 runner 离线 TDD。

    Windows = System.Windows.Forms.SendKeys（真机验过：计算器 {ESC} 后按 7 → 显示 7）；
    macOS = osascript keystroke（⚠未真机验证）；其它平台不支持。键去最前窗口 → 调用方应先确保目标已聚焦。
    """
    plat = plat or sys.platform
    if plat == "win32":
        argv = ["powershell", "-NoProfile", "-Command", _win_sendkeys_ps(keys)]
    else:  # darwin（真机）/ 或注入 runner 的测试：用 mac osascript 作载体（注入 runner 一律优先于平台分发，保 CI 水密）
        argv = ["osascript", "-e", _mac_sendkeys_as(keys)]
    if runner is None and plat not in ("darwin", "win32"):
        return (False, "此平台暂不支持键盘发送（目前仅 Windows / macOS）")   # 真机 + 无 runner + 不支持平台 才降级
    try:
        if runner is not None:
            rc, out, err = runner(argv)
        else:
            p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=20)
            rc, out, err = p.returncode, p.stdout, p.stderr
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return (False, f"发送键盘子进程失败：{e}")
    if rc != 0:
        return (False, (err or "").strip() or "发送键盘子进程非零退出")
    for line in (out or "").splitlines():
        line = line.strip()
        if line.startswith("OK|"):
            return (True, line[3:])
        if line.startswith("ERR|"):
            return (False, line[4:])
    return (False, "发送键盘无明确结果")


def _win_type_text_ps(text: str) -> str:
    b64 = _ps_b64(text)   # 文本走 base64、脚本内解码；绝不拼进单引号串（防 Unicode 引号同形字逃逸 RCE，同 send_keys/focus）
    return (_PS_UTF8 +
            "Add-Type -AssemblyName System.Windows.Forms,UIAutomationClient,UIAutomationTypes 2>$null\n"
            f"$t=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{b64}'))\n"
            "$fg=[System.Windows.Automation.AutomationElement]::FocusedElement\n"
            "if(-not $fg){ Write-Output 'ERR|没有获得焦点的元素（先 click 一个输入框或 focus_window 切到目标再试）'; return }\n"
            'try{ $win=$fg; while($win.Current.ControlType.ProgrammaticName -ne "ControlType.Window" -and $win){ $win=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($win) } }catch{}\n'
            "$wn= if($win){ $win.Current.Name }else{ '?' }\n"
            # 主路：UIA ValuePattern.SetValue——零坐标、原子、无转义（标准 Edit/ComboBox 输入框走这条）
            "$vp=$null\n"
            "try{ $vp=$fg.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) }catch{}\n"
            "if($vp){\n"
            "  if($vp.Current.IsReadOnly){ Write-Output ('ERR|聚焦的元素只读，无法输入（先 click 进一个可编辑输入框再试）'); return }\n"
            "  $vp.SetValue($t)\n"
            "  Write-Output ('OK|'+$wn)\n"
            "  return\n"
            "}\n"
            # 兜底路：无 ValuePattern（多行编辑框/记事本正文常见）→ 剪贴板粘贴。对抗审查修复：
            #  (A1) 存**整份**剪贴板（不止文本：图片/文件/HTML 也要能还原）→ 覆盖前把各格式数据拷进新 DataObject，
            #       避免 GetDataObject 的活引用在 SetText 后失效；否则非文本剪贴板会被结尾 Clear() 永久清掉。
            #  (A2) 粘贴放进 try/finally → SendWait 抛异常也保证还原，不把注入文本留在用户剪贴板里。
            "$old=$null\n"
            "try{ $cur=[System.Windows.Forms.Clipboard]::GetDataObject(); if($cur){ $old=New-Object System.Windows.Forms.DataObject; foreach($f in $cur.GetFormats()){ try{ $old.SetData($f,$cur.GetData($f)) }catch{} } } }catch{}\n"
            "try{ [System.Windows.Forms.Clipboard]::SetText($t) }catch{ Write-Output ('ERR|聚焦元素不支持直接输入、剪贴板兜底也失败：'+$_.Exception.Message); return }\n"
            "try{ [System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 150 }finally{ try{ if($old){ [System.Windows.Forms.Clipboard]::SetDataObject($old,$true) }else{ [System.Windows.Forms.Clipboard]::Clear() } }catch{} }\n"
            "Write-Output ('OK|'+$wn+'|paste')\n")


def _mac_type_text_as(text: str) -> str:
    """macOS：剪贴板置文 + Cmd+V 灌长文本，回读真实最前进程名。⚠未真机验证。文本做 AppleScript 字面转义防逃逸。
    对抗审查修复：存旧剪贴板（文本）→ 置文 → 粘贴 → 还原，别每次无条件覆盖用户剪贴板（与 Windows 兜底对称）。"""
    esc = (text or "").replace("\\", "\\\\").replace('"', '\\"')
    return ('tell application "System Events"\n'
            '  set oldClip to ""\n'
            '  try\n'
            '    set oldClip to (the clipboard as text)\n'
            '  end try\n'
            f'  set the clipboard to "{esc}"\n'
            '  keystroke "v" using command down\n'
            '  delay 0.15\n'
            '  try\n'
            '    set the clipboard to oldClip\n'
            '  end try\n'
            '  set fp to name of first application process whose frontmost is true\n'
            '  return "OK|" & fp & "|paste"\n'
            'end tell')


def type_text(text, runner=None, plat=None):
    """往**当前聚焦控件**灌文本（长文本通道，补 press_keys 之外）：Windows 优先 UIA ValuePattern.SetValue
    （零坐标、原子、无逐字转义），不支持则剪贴板粘贴兜底；macOS 走剪贴板+Cmd+V（⚠未真机验证）。
    返回 (ok, 目标窗口名或错误)。可注入 runner 离线 TDD。

    文本去**聚焦控件/最前窗口** → 调用方应先 click 进目标输入框或 focus_window 切到目标；否则会打到错地方。
    """
    plat = plat or sys.platform
    if plat == "win32":
        argv = ["powershell", "-NoProfile", "-Command", _win_type_text_ps(text)]
    else:  # darwin（真机）/ 或注入 runner 的测试：注入 runner 一律优先于平台分发，保 CI 水密
        argv = ["osascript", "-e", _mac_type_text_as(text)]
    if runner is None and plat not in ("darwin", "win32"):
        return (False, "此平台暂不支持文本输入（目前仅 Windows / macOS）")
    try:
        if runner is not None:
            rc, out, err = runner(argv)
        else:
            p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=30)
            rc, out, err = p.returncode, p.stdout, p.stderr
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return (False, f"文本输入子进程失败：{e}")
    if rc != 0:
        return (False, (err or "").strip() or "文本输入子进程非零退出")
    for line in (out or "").splitlines():
        line = line.strip()
        if line.startswith("OK|"):
            name = line[3:]
            if name.endswith("|paste"):   # 只剥尾部模式标记；保留标题里的字面 '|'（对抗审查：'Doc | Editor' 不该截成 'Doc '）
                name = name[:-len("|paste")]
            return (True, name)
        if line.startswith("ERR|"):
            return (False, line[4:])
    return (False, "文本输入无明确结果")


_OCR_MAX_WORDS = 400      # 词框解析上限：整屏 OCR 可回数百词，封顶防超长输出撑上下文（截断在 Python 侧、可预期）
_OCR_PS_MAX_WORDS = 800   # PS 侧发射上限（红队 L2）：Python 的 400 只限解析，不限子进程 stdout 峰值——
                          # 恶意密集文本图可吐上万词撑缓冲，在源头就封顶（> 解析上限留余量，正常图无感）


def _win_ocr_ps(path: str, boxes: bool = False) -> str:
    b64 = _ps_b64(path)   # 图片路径走 base64、脚本内解回（防注入，同其它自由文本入口）
    # boxes：每词一行 WORD|b64(词文本)|x|y|w|h（BoundingRect=图像像素坐标；词文本走 b64 防竖线/换行歧义）
    words_emit = ("  $wc=0\n"
                  f"  foreach($line in $r.Lines){{ if($wc -ge {_OCR_PS_MAX_WORDS}){{break}}; foreach($w in $line.Words){{\n"
                  f"    if($wc -ge {_OCR_PS_MAX_WORDS}){{break}}; $wc++\n"
                  "    $tb=[System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$w.Text))\n"
                  "    $rc2=$w.BoundingRect\n"
                  "    Write-Output ('WORD|'+$tb+'|'+[int]$rc2.X+'|'+[int]$rc2.Y+'|'+[int]$rc2.Width+'|'+[int]$rc2.Height)\n"
                  "  }}\n") if boxes else ""
    return (_PS_UTF8 +
            "$ErrorActionPreference='Stop'\n"
            "try{\n"
            f"  $p=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{b64}'))\n"
            "  if(-not (Test-Path -LiteralPath $p)){ Write-Output 'ERR|图片文件不存在'; return }\n"
            "  Add-Type -AssemblyName System.Runtime.WindowsRuntime\n"
            # WinRT 异步投影：反射拿泛型 AsTask 把 IAsyncOperation<T> 转 .NET Task 再同步等（这就是当初"踩坑暂缓"的关键）
            "  $asTaskGeneric=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{ $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]\n"
            "  function Await($op,$t){ $m=$asTaskGeneric.MakeGenericMethod($t); $k=$m.Invoke($null,@($op)); [void]$k.Wait(-1); $k.Result }\n"
            "  [void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]\n"
            "  [void][Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]\n"
            "  [void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]\n"
            "  $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()\n"
            "  if(-not $engine){ Write-Output 'ERR|本机没装可用的 OCR 语言包（设置→时间和语言→语言→为已装语言添加「OCR」可选功能）'; return }\n"
            "  $file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])\n"
            "  $stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])\n"
            "  $decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])\n"
            "  $sb=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])\n"
            "  $r=Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])\n"
            + words_emit +
            # 识别文本走 base64 回传：安全承载多行/竖线/CJK，Python 端解回，杜绝解析歧义
            "  $b=[System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$r.Text))\n"
            "  Write-Output ('OK|'+$b)\n"
            "}catch{ Write-Output ('ERR|OCR 失败：'+$_.Exception.Message) }\n")


_OCR_LANGS_DEFAULT = ("zh-Hans", "en")


def _mac_ocr_swift(path: str, boxes: bool = False, langs=None) -> str:
    """macOS OCR 脚本：/usr/bin/swift + Vision（VNRecognizeTextRequest，.accurate，默认 zh-Hans+en）。

    langs 可换识别语言组（仅 Mac 侧生效；2026-07-22 真机探针：反色补跑用 ("ja",) 时 Vision 对孤立
    数字字形分类最准——zh-Hans,en 把显示屏孤立「0」判成字母 O，ja 判成 0）。langs 只收语言代码
    字符（防脚本注入；调用方只传代码常量）。
    输出对齐 Windows 行协议：boxes 模式每词一行 WORD|b64(词文本)|x|y|w|h（Vision 的归一化
    bottom-left 原点 boundingBox 换算成**图片像素、top-left 原点**坐标、取整）+ 末行 OK|b64(全文)；
    Mac 侧 WORD 行追加第 7 字段 confidence（VNRecognizeTextRequest 候选自带，0~1 三位小数，
    §4.4.3 置信度门控补跑用；Windows WinRT 无此概念仍发 6 字段，解析端双兼容）。
    错误统一 ERR|...。发射上限 _OCR_PS_MAX_WORDS=800（同 PS 侧，源头封顶防密集文本图撑缓冲）。
    跑法 `swift -e <script>`：脚本在 argv 里可审（同 powershell -Command）；swift 自带脚本编译缓存，
    稳态 ~0.4s（2026-07-22 真机实测），无需自管编译产物缓存。
    """
    langs = _OCR_LANGS_DEFAULT if langs is None else tuple(langs)
    for lang in langs:
        if not re.fullmatch(r"[A-Za-z0-9-]+", lang):
            raise ValueError(f"OCR 语言代码非法：{lang!r}")
    lang_list = ", ".join(f'"{lang}"' for lang in langs)
    b64 = _ps_b64(path)   # 图片路径走 base64、脚本内解回（防注入，同 Windows 侧 _ps_b64 先例）
    words_emit = ("    if wc < maxWords {\n"
                  "        wc += 1\n"
                  "        let bb = obs.boundingBox\n"
                  "        let px = Int((bb.minX * CGFloat(imgW)).rounded())\n"
                  "        let py = Int(((1 - bb.maxY) * CGFloat(imgH)).rounded())\n"   # bottom-left → top-left
                  "        let pw = Int((bb.width * CGFloat(imgW)).rounded())\n"
                  "        let ph = Int((bb.height * CGFloat(imgH)).rounded())\n"
                  '        let conf = String(format: "%.3f", Double(cand.confidence))\n'
                  '        print("WORD|\\(Data(cand.string.utf8).base64EncodedString())|\\(px)|\\(py)|\\(pw)|\\(ph)|\\(conf)")\n'
                  "    }\n") if boxes else ""
    return ("import Foundation\n"
            "import Vision\n"
            "import ImageIO\n"
            f"let maxWords = {_OCR_PS_MAX_WORDS}\n"
            f'guard let pd = Data(base64Encoded: "{b64}"), let path = String(data: pd, encoding: .utf8) else {{\n'
            '    print("ERR|路径解码失败"); exit(1)\n'
            "}\n"
            "guard FileManager.default.fileExists(atPath: path),\n"
            "      let data = FileManager.default.contents(atPath: path), !data.isEmpty else {\n"
            '    print("ERR|图片文件不存在或读取失败"); exit(0)\n'
            "}\n"
            "var imgW = 0, imgH = 0\n"
            "if let src = CGImageSourceCreateWithData(data as CFData, nil),\n"
            "   let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [String: Any] {\n"
            "    imgW = props[kCGImagePropertyPixelWidth as String] as? Int ?? 0\n"
            "    imgH = props[kCGImagePropertyPixelHeight as String] as? Int ?? 0\n"
            "}\n"
            "let req = VNRecognizeTextRequest()\n"
            "req.recognitionLevel = .accurate\n"
            f"req.recognitionLanguages = [{lang_list}]\n"
            "req.usesLanguageCorrection = false\n"
            "let handler = VNImageRequestHandler(data: data, options: [:])\n"
            "do {\n"
            "    try handler.perform([req])\n"
            "} catch {\n"
            '    print("ERR|OCR 失败：\\(error.localizedDescription)"); exit(0)\n'
            "}\n"
            "var texts: [String] = []\n"
            "var wc = 0\n"
            "for obs in (req.results ?? []) {\n"
            "    guard let cand = obs.topCandidates(1).first else { continue }\n"
            "    texts.append(cand.string)\n"
            + words_emit +
            "}\n"
            'print("OK|" + Data(texts.joined(separator: "\\n").utf8).base64EncodedString())\n')


def _ocr_run(path, runner, plat, boxes, langs=None):
    """跑 OCR 子进程并解析。返回 (ok, 文本或错误, words)；words=[{text,x,y,w,h}...]（boxes=False 恒空表；
    Mac 新协议多一个可选 confidence 键——有该键 = 带置信度信号，无该键 = WinRT/畸形，下游按无信号回落）。
    langs 仅 Mac 侧生效（换 Vision 识别语言组）；Windows 侧忽略（WinRT 引擎取用户配置语言，语义不变）。"""
    plat = plat or sys.platform
    if plat == "darwin":
        argv = ["/usr/bin/swift", "-e", _mac_ocr_swift(path, boxes=boxes, langs=langs)]
    else:  # win32（真机）/ 或注入 runner 的测试：注入 runner 一律优先于平台分发，保 CI 水密
        argv = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", _win_ocr_ps(path, boxes=boxes)]
    if runner is None and plat not in ("win32", "darwin"):
        return (False, f"此平台暂不支持 OCR（目前仅 Windows / macOS，当前 {plat}）", [])
    try:
        if runner is not None:
            rc, out, err = runner(argv)
        else:
            p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=(30 if plat == "darwin" else 45))
            rc, out, err = p.returncode, p.stdout, p.stderr
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return (False, f"OCR 子进程失败：{e}", [])
    if rc != 0:
        return (False, (err or "").strip() or "OCR 子进程非零退出", [])
    words = []
    for line in (out or "").splitlines():
        line = line.strip()
        if line.startswith("WORD|") and len(words) < _OCR_MAX_WORDS:
            parts = line.split("|")
            if len(parts) not in (6, 7):
                continue   # 坏行跳过（字段数不对）
            try:
                t = base64.b64decode(parts[1], validate=True).decode("utf-8", "replace")   # 严格校验：坏 b64 抛而非静默解空
                x, y, w, h = (int(parts[i]) for i in (2, 3, 4, 5))
            except Exception:
                continue   # b64/坐标坏 → 跳过该词，不崩整个结果
            wd = {"text": t, "x": x, "y": y, "w": w, "h": h}
            if len(parts) == 7:
                # 第 7 字段 = Mac Vision 逐词 confidence（§4.4.3 门控信号）。fail-soft：畸形/越界/
                # NaN/inf 不当信号、不崩、不连累词本身——词照收，只是不带 confidence 键（=无信号，
                # 下游门控据此回落现状行为）。6 字段（WinRT）不多键，下游 dict 形状一字节不动。
                try:
                    c = float(parts[6])
                    if 0.0 <= c <= 1.0:
                        wd["confidence"] = c
                except ValueError:
                    pass
            words.append(wd)
        elif line.startswith("OK|"):
            try:
                return (True, base64.b64decode(line[3:]).decode("utf-8", "replace"), words)
            except Exception:
                return (False, "OCR 输出解码失败", [])
        elif line.startswith("ERR|"):
            return (False, line[4:], [])
    return (False, "OCR 无明确结果", [])


def ocr_image(path, runner=None, plat=None):
    """OCR 识别图片里的文字（Windows = Windows.Media.Ocr / WinRT；macOS = Vision / VNRecognizeTextRequest；零依赖），返回 (ok, 识别文本或错误)。可注入 runner 离线 TDD。

    补 a11y 树（observe）看不到的画布/游戏/扫描件/纯图片文本。识别文本=**不可信视觉数据**（视觉注入面）。
    CJK 识别结果字间常带空格（WinRT 行为），属正常。
    """
    ok, text, _words = _ocr_run(path, runner, plat, boxes=False)
    return (ok, text)


def ocr_words(path, runner=None, plat=None, langs=None):
    """OCR 带词框：返回 (ok, 全文或错误, words)，words=[{text,x,y,w,h}...]（BoundingRect=**该图片的像素坐标**）。

    对整屏截图（物理分辨率）做 OCR 时，词框中心可直接作 click_at 的屏幕坐标——这是「看得见点不了」
    （UIA 树没有元素的自绘界面）的补全。langs 仅 Mac 侧生效（换 Vision 识别语言组，如反色补跑用
    ("ja",)；Windows 侧忽略）。
    真机已知限制：zh-Hans 引擎对稀疏网格里的孤立单字符（如计算器数字键）会漏识——放大可缓解、
    反色补跑（tools._ocr_words_of_png）再救一层（2026-07-22 真机探针实证有效，此前「救不了」的
    结论被推翻）；仍可能漏，如实告知调用方。
    """
    return _ocr_run(path, runner, plat, boxes=True, langs=langs)


_COORD_MAX = 32767   # SetCursorPos 的 int16 屏幕坐标界；负值留给主屏左侧的副屏


def _coord_int(v, name):
    """坐标严格校验：只收整数值（int / 整值 float），拒 bool/字符串/非整/越界 → PS 脚本只插值 int，无注入面。"""
    if isinstance(v, bool):
        raise ValueError(f"{name} 不能是布尔值")
    if isinstance(v, int):
        n = v
    elif isinstance(v, float) and v.is_integer():
        n = int(v)
    else:
        raise ValueError(f"{name} 必须是整数（收到 {type(v).__name__}）")
    if not (-_COORD_MAX <= n <= _COORD_MAX):
        raise ValueError(f"{name}={n} 超出屏幕坐标范围（±{_COORD_MAX}）")
    return n


def _win_click_ps(x: int, y: int) -> str:
    """DPI 感知 + SetCursorPos + mouse_event 左键单击（物理像素）。只插值 int，无自由文本。"""
    return (_WIN_DPI_AWARE_PS +
            "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X,int Y); "
            "[DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,System.UIntPtr e);' -Name M -Namespace W\n"
            f"if(-not [W.M]::SetCursorPos({x},{y})){{ Write-Output 'ERR|SetCursorPos 失败'; return }}\n"
            "Start-Sleep -Milliseconds 60\n"
            "[W.M]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)\n"
            "[W.M]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)\n"
            "Write-Output 'CLICKED|'\n")


def _mac_click_jxa(x: int, y: int) -> str:
    """macOS 坐标点击（osascript JXA CoreGraphics CGEvent）：mouseMoved→leftMouseDown→leftMouseUp，
    60ms 间隔对齐 Win 侧 Start-Sleep 60。坐标=**逻辑点**（Mac 执行层坐标系，与 AX/OCR 经不变式①
    换算后的坐标同系）。只插值 int，无自由文本注入面。

    失败分流（2026-07-22 红队真跑后修；同日探针诊断再修）：
    ① 前置 `AXIsProcessTrusted()`——未授权辅助功能（TCC）时 CGEventPost 静默无效，且鼠标若恰已停在
       目标点 ±1 内，纯位置校验会**假 CLICKED**；前置硬检查关掉这个假成功（API 真机已验可用）。
    ② 读 CGEventGetLocation：到位 → CLICKED|；**原地未动**（=静默丢弃签名）→ ERR 挂授权引导；
       **移动了但没到位**（活机用户鼠标竞争 / 目标超屏）→ ERR 如实报「目标可能超出屏幕边界」，不挂授权引导。
    ③ **超屏目标 NSScreen 帧预检（读回不可信，必须预检）**——探针实测（30/30 复现）：CGEventGetLocation
       读的是「最后 post 的**原始未钳制**逻辑位置」且**粘住**（post (30000,12) 后 0/50/100/300/800ms
       乃至跨进程都读回 (30000,12)，直到物理鼠标移动才回真实位置）。红队当年靠物理鼠标巧合动过才看到
       钳制值。故目标不在任何显示屏帧内（NSScreen.screens 逐帧 AppKit→CG 换算）时直接判「移动未到位」，
       不信读回——否则超屏坐标在静机下必假 CLICKED。
    读回时机（同日探针两轮 40 次诊断）：leftMouseUp 后**立即读**，不再 delay 0.05——读回偏差随等待**增大**
    （0ms 读 18/20 精确到位、50ms 11/20 偏、300ms 13/20 偏，最大偏差上千 px）：活机真鼠标在合成事件落位后
    立刻抢回光标，等越久竞争窗口越大（金标准「停在 2335,332」误报即此竞态：偏 70+px 但点击实际命中）。
    首读未到位时做 2 次 10ms 有界确认重试、取**离目标最近**的读数判定——只防长距离移动的读早中间态
    （实测大跨度移动 ~10ms 才收敛），±1 容差不动。
    ④ **P0≈目标时先预移动再点（2026-07-23 残留洞修复）**：事件全丢（系统静默丢弃）+ 鼠标恰停在目标 ±1 内
       时读回「到位」假 CLICKED（真机复现：篡改 post 空操作 + 预停目标 → CLICKED|）。故点击前读的 P0 距
       目标 ≤±1（读回失效场景）时，先发一次纯 mouseMoved 预移到 (x±8, y±8)——候选四角方向 (+8,+8)/
       (-8,-8)/(+8,-8)/(-8,+8) 取第一个过 NSScreen 帧判定的屏内点，不落 click——60ms 后读回校验落位：
       **没落位 = 事件真被丢**，置 skip 跳过主序列（点了也白点），best=预移读回直接落末尾三分流
       （≈P0 → 原地未动；≠P0 → 竞争移动未到位），CLICKED 分支以 !skip 闭锁；落位则正常点击，此时
       「最后停在目标」必然是事件真送达的结果，读回重新有效。P0 远离目标的正常路径零额外事件。
    真机已验（2026-07-22：JXA 常量桥接正常、点 (1280,12) 到位、鼠标可复原；NSScreen 帧桥接实测可用，
    双屏 2560x1440×2 并排读取正确；无 struct/枚举坑，未落 Swift 备胎）。"""
    return ("ObjC.import('CoreGraphics');\n"
            "ObjC.import('ApplicationServices');\n"
            "ObjC.import('AppKit');\n"
            f"var x={x}, y={y};\n"
            "var screens=$.NSScreen.screens, primaryH=screens.objectAtIndex(0).frame.size.height;\n"
            "function inscreen(px,py){"
            " for (var si=0; si<screens.count; si++){ var f=screens.objectAtIndex(si).frame;"
            " var gy=primaryH-f.origin.y-f.size.height;"
            " if (px>=f.origin.x && px<f.origin.x+f.size.width && py>=gy && py<gy+f.size.height) return true; }"
            " return false; }\n"
            "var onscreen=inscreen(x,y);\n"
            "function postxy(t,px,py){ var ev=$.CGEventCreateMouseEvent($(),t,$.CGPointMake(px,py),$.kCGMouseButtonLeft);"
            " $.CGEventPost($.kCGHIDEventTap,ev); }\n"
            "function post(t){ postxy(t,x,y); }\n"
            "var trusted=$.AXIsProcessTrusted();\n"
            "var l0=$.CGEventGetLocation($.CGEventCreate($()));\n"
            "var best=l0, skip=false;\n"
            # P0≈目标 → 读回失效场景：先预移出目标点，预移没落位=事件被丢（修假 CLICKED 残留洞）
            "if (trusted && onscreen && Math.abs(l0.x-x)<=1 && Math.abs(l0.y-y)<=1){\n"
            " var cands=[[x+8,y+8],[x-8,y-8],[x+8,y-8],[x-8,y+8]];\n"
            " for (var ci=0; ci<cands.length; ci++){ var px=cands[ci][0], py=cands[ci][1];\n"
            "  if (!inscreen(px,py)) continue;\n"
            "  postxy($.kCGEventMouseMoved,px,py); delay(0.06);\n"
            "  var lp=$.CGEventGetLocation($.CGEventCreate($()));\n"
            "  if (Math.abs(lp.x-px)>1 || Math.abs(lp.y-py)>1){ skip=true; best=lp; }\n"
            "  break; } }\n"
            "if (!skip){\n"
            " post($.kCGEventMouseMoved); delay(0.06);\n"
            " post($.kCGEventLeftMouseDown); delay(0.06);\n"
            " post($.kCGEventLeftMouseUp);\n"
            " var l=$.CGEventGetLocation($.CGEventCreate($()));\n"
            " best=l;\n"
            " for (var i=0; i<2 && (Math.abs(best.x-x)>1 || Math.abs(best.y-y)>1); i++){ delay(0.01);"
            " l=$.CGEventGetLocation($.CGEventCreate($()));"
            " if (Math.abs(l.x-x)+Math.abs(l.y-y)<Math.abs(best.x-x)+Math.abs(best.y-y)) best=l; } }\n"
            "(!trusted) ? 'ERR|辅助功能未授权（AXIsProcessTrusted=false，CGEvent 被系统静默丢弃）' :\n"
            "(!onscreen ? 'ERR|鼠标移动了但未到位（停在 '+Math.round(best.x)+','+Math.round(best.y)"
            "+'，目标可能超出屏幕边界）' :\n"
            "((!skip && Math.abs(best.x-x)<=1 && Math.abs(best.y-y)<=1) ? 'CLICKED|' :\n"
            "((Math.abs(best.x-l0.x)<=1 && Math.abs(best.y-l0.y)<=1) ? 'ERR|鼠标原地未动（疑似辅助功能未授权）' :\n"
            "'ERR|鼠标移动了但未到位（停在 '+Math.round(best.x)+','+Math.round(best.y)+'，目标可能超出屏幕边界）')))\n")


def click_xy(x, y, runner=None, plat=None):
    """在屏幕执行层坐标 (x,y) 发一次左键单击，返回 (ok, err)。真机已验（Win11 200% 缩放：点 CE 分毫不差；
    macOS：JXA CGEvent 点 (1280,12) CGEventGetLocation 实测到位）。

    坐标系=执行层坐标：Win=物理像素（截图/UIA/OCR 词框同系；脚本内自设 DPI 感知，不设则 200% 机差 2× 全脱靶）、
    Mac=逻辑点（AX 同系；spec §Mac 适配）。这是 click(uid) 之外的坐标兜底：UIA 树没有该元素（自绘界面）时才用。
    可注入 runner 离线 TDD。Mac 点击走辅助功能 TCC：脚本内校验鼠标真到位，没动 → ERR 挂授权引导（不装成功）。
    """
    xi, yi = _coord_int(x, "x"), _coord_int(y, "y")
    plat = plat or sys.platform
    if plat == "darwin":
        argv = ["osascript", "-l", "JavaScript", "-e", _mac_click_jxa(xi, yi)]
    else:  # win32（真机）/ 或注入 runner 的测试：注入 runner 一律优先于平台分发，保 CI 水密（照 _ocr_run 先例）
        argv = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", _win_click_ps(xi, yi)]
    if runner is None and plat not in ("win32", "darwin"):
        return (False, f"此平台暂不支持坐标点击（目前仅 Windows / macOS，当前 {plat}）")
    try:
        if runner is not None:
            rc, out, err = runner(argv)
        else:
            p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=15)
            rc, out, err = p.returncode, p.stdout, p.stderr
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return (False, f"点击子进程失败：{e}")
    if rc != 0:
        return (False, (err or "").strip() or "点击子进程非零退出")
    for line in (out or "").splitlines():
        line = line.strip()
        if line.startswith("CLICKED|"):
            return (True, "")
        if line.startswith("ERR|"):
            msg = line[4:]
            # 授权引导只挂给 TCC 签名的失败（脚本前置查到未授权 / 鼠标原地未动=静默丢弃）；
            # 「移动了但没到位」=超屏钳制或用户鼠标竞争，不是授权问题——挂引导会骗人去系统设置空转（红队真跑）。
            if plat == "darwin" and ("AXIsProcessTrusted" in msg or "原地未动" in msg):
                msg = f"{msg}——{platform_caps.AX_GUIDE}"
            return (False, msg)
    return (False, "点击无明确结果")


_PDF_MAX_EDGE = 2200   # RenderToStreamAsync 渲染栅格 DIP 上限：封恶意巨 MediaBox PDF 撑爆 PS 侧位图
                       # （hi-DPI 机上物理像素约 ≤2×，仍远在 imaging.decode 的 50M 像素闸下）；常见 Letter 页不触发、保原生清晰度。


def _win_pdf_ps(path: str) -> str:
    """Windows.Data.Pdf/WinRT 把 PDF 首页渲染成 PNG、base64 从 stdout 回传（OK|页数|b64 / ERR|原因）。

    WinRT 异步投影同 OCR：反射拿 AsTask 把 IAsyncOperation<T>/IAsyncAction 转 .NET Task 同步等（那个"踩坑"点）。
    PDF 路径走 base64、脚本内 FromBase64String 解回（防 Unicode 引号同形字逃逸 RCE，同 OCR/按键等自由文本入口）。
    RenderToStreamAsync 产出的位图经 BitmapDecoder→BitmapEncoder(PNG) 显式重编码，保证输出是 PNG（Encoder 拒非法像素格式时转 Bgra8）。
    """
    b64 = _ps_b64(path)
    return (_PS_UTF8 +
            "$ErrorActionPreference='Stop'\n"
            "try{\n"
            f"  $p=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{b64}'))\n"
            "  if(-not (Test-Path -LiteralPath $p)){ Write-Output 'ERR|PDF 文件不存在'; return }\n"
            "  Add-Type -AssemblyName System.Runtime.WindowsRuntime\n"
            "  $asOp=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{ $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]\n"
            "  $asAct=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{ $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]\n"
            "  function Await($o,$t){ $m=$asOp.MakeGenericMethod($t); $k=$m.Invoke($null,@($o)); [void]$k.Wait(-1); $k.Result }\n"
            "  function AwaitAct($o){ $k=$asAct.Invoke($null,@($o)); [void]$k.Wait(-1) }\n"
            "  [void][Windows.Data.Pdf.PdfDocument,Windows.Foundation,ContentType=WindowsRuntime]\n"
            "  [void][Windows.Data.Pdf.PdfPageRenderOptions,Windows.Foundation,ContentType=WindowsRuntime]\n"
            "  [void][Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]\n"
            "  [void][Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]\n"
            "  [void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]\n"
            "  [void][Windows.Graphics.Imaging.BitmapEncoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]\n"
            "  $file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])\n"
            "  $doc=Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])\n"
            "  if($doc.PageCount -lt 1){ Write-Output 'ERR|PDF 没有页面'; return }\n"
            "  $page=$doc.GetPage(0)\n"
            "  $sz=$page.Size\n"
            "  $opts=New-Object Windows.Data.Pdf.PdfPageRenderOptions\n"
            f"  $me={_PDF_MAX_EDGE}\n"
            "  if($sz.Height -ge $sz.Width){ if($sz.Height -gt $me){ $opts.DestinationHeight=[uint32]$me } }\n"
            "  else { if($sz.Width -gt $me){ $opts.DestinationWidth=[uint32]$me } }\n"
            "  $rs=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream\n"
            "  AwaitAct ($page.RenderToStreamAsync($rs,$opts))\n"
            "  $rs.Seek(0)\n"
            "  $dec=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($rs)) ([Windows.Graphics.Imaging.BitmapDecoder])\n"
            "  $sb=Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])\n"
            "  $os=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream\n"
            "  $enc=Await ([Windows.Graphics.Imaging.BitmapEncoder]::CreateAsync([Windows.Graphics.Imaging.BitmapEncoder]::PngEncoderId,$os)) ([Windows.Graphics.Imaging.BitmapEncoder])\n"
            "  try{ $enc.SetSoftwareBitmap($sb) }catch{ $sb2=[Windows.Graphics.Imaging.SoftwareBitmap]::Convert($sb,[Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied); $enc.SetSoftwareBitmap($sb2) }\n"
            "  AwaitAct ($enc.FlushAsync())\n"
            "  $os.Seek(0)\n"
            "  $br=New-Object System.IO.BinaryReader ([System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($os.GetInputStreamAt(0)))\n"
            "  $bytes=$br.ReadBytes([int]$os.Size)\n"
            "  $b=[System.Convert]::ToBase64String($bytes)\n"
            "  Write-Output ('OK|'+$doc.PageCount+'|'+$b)\n"
            "}catch{ Write-Output ('ERR|PDF 渲染失败：'+$_.Exception.Message) }\n")


def pdf_to_png_win(path, runner=None, plat=None):
    """Windows 用 WinRT Windows.Data.Pdf 把 PDF 首页渲染成 PNG 字节（零依赖，替 mac-only 的 sips）。
    返回 (ok, png_bytes 或 None, 错误串)。可注入 runner 离线 TDD。PDF 内容=不可信外部数据（视觉注入面）。"""
    plat = plat or sys.platform
    if plat != "win32" and runner is None:
        return (False, None, "此平台不支持 WinRT PDF 渲染（目前仅 Windows）")
    argv = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", _win_pdf_ps(path)]
    try:
        if runner is not None:
            rc, out, err = runner(argv)
        else:
            p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=60)
            rc, out, err = p.returncode, p.stdout, p.stderr
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return (False, None, f"PDF 子进程失败：{e}")
    if rc != 0:
        return (False, None, (err or "").strip() or "PDF 子进程非零退出")
    for line in (out or "").splitlines():
        line = line.strip()
        if line.startswith("OK|"):
            try:
                _, _pages, b64 = line.split("|", 2)
                png = base64.b64decode(b64)   # binascii.Error 是 ValueError 子类
            except (ValueError, TypeError):
                return (False, None, "PDF 渲染输出解析失败")
            return (True, png, "") if png else (False, None, "PDF 渲染出空图")
        if line.startswith("ERR|"):
            return (False, None, line[4:])
    return (False, None, "PDF 渲染无有效输出")


def _win_focus_ps(title: str) -> str:
    # 走 Win32：UIA 找到标题含 title 的顶层窗口 → 取 HWND → ShowWindow(SW_RESTORE) 复原最小化 + SwitchToThisWindow 置前。
    # 不用 WScript.Shell.AppActivate：真机实测它对 UWP / 最小化窗口不可靠（不复原、布尔返回也不可信）。
    # title 走 base64（防同形字逃逸 RCE）；成功判据严格=真正置到最前，句柄为 0 / 没置成 → 明确 ERR（别把没切成功报成功，
    # 否则后续 observe/click/press 会打到错窗口甚至 agent 自己的终端）。
    b64 = _ps_b64(title)
    return (_PS_UTF8 +
            "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes 2>$null\n"
            "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr h,int n); [DllImport(\"user32.dll\")] public static extern void SwitchToThisWindow(System.IntPtr h,bool b);' -Name U -Namespace W 2>$null\n"
            f"$t=([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{b64}'))).ToLower()\n"
            "$root=[System.Windows.Automation.AutomationElement]::RootElement\n"
            "$wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)\n"
            "$tgt=$null; $tn=''\n"
            "foreach($w in $wins){ try{ $n=$w.Current.Name; if($n -and $n.ToLower().Contains($t)){ $tgt=$w; $tn=$n; break } }catch{} }\n"
            "if(-not $tgt){ Write-Output 'ERR|没找到标题含该子串的窗口（先确认它开着、标题对得上）'; return }\n"
            "$h=[System.IntPtr]$tgt.Current.NativeWindowHandle\n"
            # 组合置前：ShowWindow(SW_RESTORE) 复原最小化 + AppActivate(可靠越前台锁) + SwitchToThisWindow(兜底)；
            # $tn 是 PS 变量（非 Python 插值），AppActivate($tn) 无注入面。
            "if($h -ne [System.IntPtr]::Zero){ [W.U]::ShowWindow($h,9) | Out-Null; [W.U]::SwitchToThisWindow($h,$true) }\n"
            "try{ (New-Object -ComObject WScript.Shell).AppActivate($tn) | Out-Null }catch{}\n"
            "Start-Sleep -Milliseconds 350\n"
            # 成功判据=最前窗口**句柄身份等于目标** 或 **名字精确等于目标全名**（都比纯子串包含精确，防"另一个名字恰含子串的
            # 窗口在最前"被误判成功，#16）。UWP 的宿主 HWND 常与 FocusedElement 上溯的 CoreWindow 句柄不一致→句柄判失效，
            # 故叠一条"最前全名 == 目标全名 $tn"（对 UWP 计算器成立），既修子串误报又不误伤 UWP。
            "$fg=[System.Windows.Automation.AutomationElement]::FocusedElement\n"
            'try{ $fw=$fg; while($fw.Current.ControlType.ProgrammaticName -ne "ControlType.Window" -and $fw){ $fw=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($fw) } }catch{}\n'
            "$fn= if($fw){ $fw.Current.Name }else{ '' }\n"
            "$fh= if($fw){ [System.IntPtr]$fw.Current.NativeWindowHandle }else{ [System.IntPtr]::Zero }\n"
            "if(($h -ne [System.IntPtr]::Zero -and $fh -eq $h) -or ($fn -and $fn.ToLower() -eq $tn.ToLower())){ Write-Output ('OK|'+$fn) }else{ Write-Output ('ERR|已尝试置前但当前最前是「'+$fn+'」、未匹配到目标（可能被置顶窗遮挡/前台锁定），别在此状态 click/press，先手动切或重试') }\n")


def _mac_focus_as(title: str) -> str:
    """按进程名置前后**回读真实最前进程名校验**（对齐已硬化的 Windows 路径），未真正到最前 → ERR。⚠部分真机验证。
    修复：旧码 set frontmost 后无条件 `return OK|<回显输入>`，进程存在但窗口没真抬前（无窗口/被遮挡/Space）时假成功，
    害得后续 observe/click/press 打到错窗口甚至 agent 自己的终端。回报的是真实最前名（不是输入回显）。"""
    esc = title.replace("\\", "\\\\").replace('"', '\\"')
    return ('tell application "System Events"\n'
            '  try\n'
            f'    set frontmost of (first process whose name contains "{esc}") to true\n'
            '  on error\n'
            '    return "ERR|没找到名字含该子串的进程（先确认它开着、名字对得上）"\n'
            '  end try\n'
            '  delay 0.3\n'
            '  set fp to name of first application process whose frontmost is true\n'
            f'  if fp contains "{esc}" then\n'
            '    return "OK|" & fp\n'
            '  else\n'
            '    return "ERR|已尝试置前但当前最前是「" & fp & "」、未匹配到目标（别在此状态 click/press，先手动切或重试）"\n'
            '  end if\n'
            'end tell')


def focus_window(title, runner=None, plat=None):
    """把标题含 title 的窗口带到最前，返回 (ok, 当前最前窗口名或错误)。可注入 runner 离线 TDD。

    observe/click/press 都作用于最前窗口，而 agent 跑在终端里、终端才是最前——要操作别的 app，必须先 focus_window。
    Windows = WScript.Shell.AppActivate（真机验过，标题可部分匹配）；macOS = osascript（⚠未真机验证）；其它平台不支持。
    """
    plat = plat or sys.platform
    if plat == "win32":
        argv = ["powershell", "-NoProfile", "-Command", _win_focus_ps(title)]
    else:  # darwin（真机）/ 或注入 runner 的测试：用 mac osascript 作载体（注入 runner 一律优先于平台分发，保 CI 水密）
        argv = ["osascript", "-e", _mac_focus_as(title)]
    if runner is None and plat not in ("darwin", "win32"):
        return (False, "此平台暂不支持窗口聚焦（目前仅 Windows / macOS）")   # 真机 + 无 runner + 不支持平台 才降级
    try:
        if runner is not None:
            rc, out, err = runner(argv)
        else:
            p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=20)
            rc, out, err = p.returncode, p.stdout, p.stderr
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return (False, f"聚焦窗口子进程失败：{e}")
    if rc != 0:
        return (False, (err or "").strip() or "聚焦窗口子进程非零退出")
    for line in (out or "").splitlines():
        line = line.strip()
        if line.startswith("OK|"):
            return (True, line[3:])
        if line.startswith("ERR|"):
            return (False, line[4:])
    return (False, "聚焦窗口无明确结果")


def invoke_element(index, runner=None, plat=None):
    """按 index（observe 元素表第 index 个）用无障碍接口触发默认动作，返回 (ok, 描述)。可注入 runner 离线 TDD。

    Windows = UIA InvokePattern（→ LegacyIAccessible.DoDefaultAction 兜底，真机验过、零坐标）；
    macOS = osascript AXPress（⚠未真机验证）；其它平台不支持。子进程输出约定 `OK|role|name` / `ERR|原因`。
    """
    plat = plat or sys.platform
    if plat == "win32":
        argv = ["powershell", "-NoProfile", "-Command", _win_invoke_ps(index)]
    else:  # darwin（真机）/ 或注入 runner 的测试：用 mac osascript 作载体（注入 runner 一律优先于平台分发，保 CI 水密）
        argv = ["osascript", "-e", _mac_invoke_as(index)]
    if runner is None and plat not in ("darwin", "win32"):
        return (False, "此平台暂不支持编程点击（目前仅 Windows / macOS）")   # 真机 + 无 runner + 不支持平台 才降级
    try:
        if runner is not None:
            rc, out, err = runner(argv)
        else:
            p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=20)
            rc, out, err = p.returncode, p.stdout, p.stderr
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return (False, f"点击子进程失败：{e}")
    if rc != 0:
        return (False, (err or "").strip() or "点击子进程非零退出")
    for line in (out or "").splitlines():
        line = line.strip()
        if line.startswith("OK|"):
            return (True, line[3:])
        if line.startswith("ERR|"):
            return (False, line[4:])
    return (False, "点击无明确结果（子进程未按约定输出 OK|/ERR|）")


# 截图子进程必须**自设** DPI 感知：SetProcessDPIAware() 设在 Python 父进程不会被子 PowerShell 继承，
# 不设则 System.Drawing 工作在逻辑像素、与 UIA 物理坐标差 DPI 缩放倍数（200% 缩放机实测 2×）→ 视觉全脱靶。
# 必须在任何 Screen 查询 / 绘图之前调用。真机验证（Win11 200%）：设了→截 3120×2080 物理；不设→1560×1040 逻辑。
# argv 由 subprocess 直传（非经 shell），故内嵌的 "user32.dll" 双引号原样保留、无需再转义。
_WIN_DPI_AWARE_PS = ("Add-Type -MemberDefinition "
                     "'[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();' "
                     "-Name D -Namespace W 2>$null;[W.D]::SetProcessDPIAware() | Out-Null;")


def _win_shot_ps(tmp: str, region) -> str:
    """System.Drawing 截前台窗口区域（或整屏）到 tmp；**先自设进程 DPI 感知**，截物理像素与 UIA 坐标同系。

    真机验证过（Win11 200% 缩放）：DPI 感知后整屏截 3120×2080 物理像素、出有效 PNG（不设则 1560×1040 逻辑、差 2×）。
    """
    if region and all(isinstance(v, int) for v in region) and region[2] > 0 and region[3] > 0:
        x, y, w, h = region
    else:
        x = y = 0
        w = h = 0  # 0 → 脚本内取整屏
    return (_WIN_DPI_AWARE_PS
            + f"Add-Type -AssemblyName System.Drawing,System.Windows.Forms;"
            f"$b=if({w} -gt 0){{[Drawing.Bitmap]::new({w},{h})}}else{{"
            f"$s=[Windows.Forms.Screen]::PrimaryScreen.Bounds;[Drawing.Bitmap]::new($s.Width,$s.Height)}};"
            f"$g=[Drawing.Graphics]::FromImage($b);"
            f"$g.CopyFromScreen({x},{y},0,0,$b.Size);$b.Save('{tmp}');")


def capture_screenshot(runner=None, region=None, plat=None):
    """截屏 → (png字节, 引导语)。未授权/失败 → (b'', 屏幕录制引导)。可注入 runner 便于离线 TDD。

    macOS = screencapture（`-R` 只截前台窗口区域，别把整屏含后台一并截走）；Windows = System.Drawing
    （⚠未真机验证，前置 set_dpi_aware 防逻辑/物理像素错位）；其它平台降级引导。
    """
    plat = plat or sys.platform
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    if plat == "win32":
        platform_caps.set_dpi_aware()   # 让 harness 进程自身 DPI 感知（真正修截图脱靶的是 _win_shot_ps 内自设，子进程不继承父的）
        argv = ["powershell", "-NoProfile", "-Command", _win_shot_ps(tmp, region)]
    else:  # darwin（真机）/ 或注入 runner 的测试：用 screencapture 作载体
        argv = ["screencapture", "-x", "-t", "png"]
        if region and all(isinstance(v, int) for v in region) and region[2] > 0 and region[3] > 0:
            argv += ["-R", f"{region[0]},{region[1]},{region[2]},{region[3]}"]
        argv.append(tmp)
    if runner is None and plat not in ("darwin", "win32"):
        try:
            os.unlink(tmp)               # 真机 + 不支持平台 + 无 runner → 降级引导
        except OSError:
            pass
        return (b"", platform_caps.CAP_GUIDE)
    try:
        if runner is not None:
            rc, _out, err = runner(argv)
        else:
            p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=20)
            rc, err = p.returncode, p.stderr
        png = b""
        if rc == 0 and "could not create image" not in (err or "").lower():
            try:
                with open(tmp, "rb") as f:
                    png = f.read()
            except OSError:
                png = b""
        return (png, "") if png else (b"", platform_caps.CAP_GUIDE)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return (b"", platform_caps.CAP_GUIDE)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def window_bbox(els: list):
    """前台窗口区域 = 所有元素外接框的并集 (x,y,w,h)。无元素 → None（调用方退回整屏或降级）。"""
    boxes = [(e["x"], e["y"], e["x"] + e["w"], e["y"] + e["h"]) for e in els
             if e["w"] > 0 and e["h"] > 0]
    if not boxes:
        return None
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    return (x0, y0, x1 - x0, y1 - y0)


_NAME_SHOW = 120   # 显示时单个 name 限长：整表恒远低于 MAX_TOOL_CHARS → observe 输出永不 spill（污点仍记完整原始 name）


# ── 列窗口（视觉C 收口）：列出顶层窗口标题，供 focus_window 挑目标 ──
_WIN_LIST_PS = _PS_UTF8 + r'''
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes 2>$null
$root=[System.Windows.Automation.AutomationElement]::RootElement
$wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
foreach($w in $wins){ try{ $n=$w.Current.Name; if($n -and $n.Trim() -ne ""){ Write-Output ($n -replace "[\r\n\t]+"," ") } }catch{} }
'''

_MAC_LIST_AS = r'''tell application "System Events"
  set out to ""
  repeat with proc in (every application process whose visible is true)
    try
      repeat with w in (every window of proc)
        try
          set nm to (name of proc) & " — " & (name of w)
          set AppleScript's text item delimiters to {return, linefeed, tab}
          set nm to text items of nm
          set AppleScript's text item delimiters to " "
          set nm to (nm as text)
          set AppleScript's text item delimiters to ""
          set out to out & nm & linefeed
        end try
      end repeat
    end try
  end repeat
  return out
end tell'''


def list_windows(runner=None, plat=None) -> list:
    """列出当前打开的顶层窗口标题 [str]（供 focus_window 挑目标）。可注入 runner 离线 TDD（同 capture_ax：runner(script)->stdout）。

    Windows = UIA RootElement 直属窗口名；macOS = System Events 每个可见进程的窗口名（"App — 窗口标题"）。
    注入 runner 一律优先于平台分发（保 CI 水密）；真机 + 无 runner + 不支持平台 → 空表降级。
    """
    plat = plat or sys.platform
    if plat == "win32":
        script, argv = _WIN_LIST_PS, ["powershell", "-NoProfile", "-Command", _WIN_LIST_PS]
    else:  # darwin（真机）/ 或注入 runner 的测试：mac osascript 作载体
        script, argv = _MAC_LIST_AS, ["osascript", "-e", _MAC_LIST_AS]
    if runner is not None:
        out = runner(script)
    elif plat not in ("darwin", "win32"):
        return []
    else:
        try:
            p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=20)
            out = p.stdout if p.returncode == 0 else ""
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return []
    titles = []
    for line in (out or "").split("\n"):
        s = line.strip()
        if s and not s.startswith(("APP:", "WIN:", "ERR:")):
            titles.append(s)
    return titles


def format_table(els: list) -> str:
    """把元素表渲染成给模型看的紧凑文本（每行一个元素，带 ref/uid/坐标）。单个 name 显示限长，保表有界。"""
    if not els:
        return "（本窗口没抽到可用元素）"
    lines = []
    for e in els:
        nm = e["name"]
        if len(nm) > _NAME_SHOW:
            nm = nm[:_NAME_SHOW] + "…"
        lines.append(f"{e['ref']} [{e['uid']}] {e['role']} 「{nm}」 @({e['x']},{e['y']}) {e['w']}x{e['h']}")
    return "\n".join(lines)
