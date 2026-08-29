"""独立对抗审查（换机后二审）确认缺陷的修复：原生 UI 操作工具 5 条（2 HIGH/2 MED/1 LOW）。TDD 红→绿。

前一台设备修了 17 条（含 RCE），本次多 agent 对抗审查双路坐实它漏掉的 5 条，全在 Mac 活路径 + 一条 Windows 残留：
- A(HIGH) Mac AX_SCRIPT 没像 Windows 枚举核那样清元素名换行 → observe 丢行、与 _mac_invoke_as 的 AppleScript n 计数错位 → 点错/点到隐藏元素。
- B(HIGH) 连 Windows 的修复都不完整：清洗集 `[\r\n\t]` 窄于 Python str.splitlines()（少 VT/FF/NEL/LS/PS/FS-RS）→ 这些字符仍能拆行错位；根治=parse 只按 \n 切。
- C(MED) Mac _mac_focus_as 无条件回显输入当成功、不校验真到最前 → 键鼠打到错窗口/agent 自己终端（Windows 已硬化）。
- D(MED) Mac _mac_sendkeys_as 把 SendKeys 语法当字面 keystroke 打（{ENTER}/^s 变字面字符、回车快捷键从不触发还谎报成功）。
- E(LOW) Mac _mac_invoke_as 无 description 兜底 → 命名与 observe 不一致 → click 的 mismatch 防错护栏对 description 命名元素恒误报。

运行：仓库根 `python -m unittest tests.test_native_ui_review_fixes -v`
"""
import unittest

from harness import observe, permission


class A_Mac元素名换行清洗(unittest.TestCase):
    def test_AX脚本在源头清元素名换行防Mac侧索引错位(self):
        # AX_SCRIPT 用 linefeed 分隔记录；名字自身含 \r\n\t 会把一元素打成多物理行 → parse 丢行、
        # 与 _mac_invoke_as 的 n 计数错位点错元素。须像 Windows _WIN_ENUM_CORE 那样在源头把名字里的换行归一。
        self.assertIn("text item delimiters", observe.AX_SCRIPT)


class B_解析按硬换行切不被异常换行错位(unittest.TestCase):
    def test_名字含VT等splitlines专属换行不丢元素不错位(self):
        # str.splitlines() 的换行集比 [\r\n\t] 宽：含 VT/FF/NEL/LS/PS/FS/GS/RS。若 parse 用 splitlines，
        # 名字里放一个这些字符就能穿过 Windows 清洗、却把该元素记录行拆断丢弃 → 后续 ref 前移、与 invoke 的 $items 错位。
        # 根治：parse 只按 \n 切，异常换行字符留在 name 里（无害），保证一元素恒一行、ref 与 invoke 严丝对齐。
        for ch in ("\x0b", "\x0c", "\x85", " ", " ", "\x1c", "\x1d", "\x1e"):
            raw = ("Button | 取消 | pos=0,0 | size=1x1\n"
                   f"Button | 确认{ch}转账 | pos=1,1 | size=2x2\n"
                   "Button | 帮助 | pos=2,2 | size=3x3")
            els = observe.element_table(raw)
            self.assertEqual(len(els), 3, f"字符 {ch!r} 处被 splitlines 误拆、丢了元素")
            self.assertEqual(els[2]["name"], "帮助")   # 帮助 仍在 e2（没有因中间元素丢失而前移到 e1）
            self.assertEqual(els[2]["ref"], "e2")      # ref 与原始枚举序对齐 → 与 invoke 的 index 对齐


class C_Mac聚焦不假成功(unittest.TestCase):
    def test_置前后回读真实最前校验而非回显输入(self):
        script = observe._mac_focus_as("计算器")
        self.assertIn("frontmost is true", script)   # 置前后回读真实最前进程（对齐 Windows 严格判定）
        self.assertIn("ERR|", script)                # 未匹配真实最前 → 报 ERR，不把没切成功报成功

    def test_darwin分发能判ERR失败(self):
        ok, _ = observe.focus_window("x", runner=lambda a: (0, "ERR|未真正置前", ""), plat="darwin")
        self.assertFalse(ok)


class D_Mac按键解释SendKeys语法(unittest.TestCase):
    def test_ENTER译成回车键码而非字面字符(self):
        script = observe._mac_sendkeys_as("7{ENTER}")
        self.assertIn('keystroke "7"', script)
        self.assertIn("key code 36", script)          # {ENTER} → 回车键码
        self.assertNotIn("{ENTER}", script)           # 不再把 {ENTER} 当字面字符打

    def test_修饰键组合译成using修饰子句(self):
        script = observe._mac_sendkeys_as("^s")
        self.assertIn("using", script)                # ^s → keystroke "s" using {control down}
        self.assertIn("control down", script)
        self.assertNotIn('keystroke "^s"', script)

    def test_特殊键有对应键码(self):
        for token, code in (("{TAB}", "48"), ("{ESC}", "53"), ("{F5}", "96"), ("{BACKSPACE}", "51")):
            self.assertIn(f"key code {code}", observe._mac_sendkeys_as(token))

    def test_普通打字仍走keystroke(self):
        # 保持 send_keys 分发测试的契约：普通字符仍 keystroke
        self.assertIn("keystroke", observe._mac_sendkeys_as("hello"))


class E_Mac点击命名对齐observe(unittest.TestCase):
    def test_invoke脚本有description兜底(self):
        # observe 的 AX_SCRIPT 对空 name 回退 description；invoke 也须回退，否则 click 的 mismatch 护栏对
        # 靠 description 命名的元素恒误报（点对了却报"不一致"），久之训练模型无视这条唯一的漂移告警。
        self.assertIn("description", observe._mac_invoke_as(0))


class G_注入runner跨平台承载保CI水密(unittest.TestCase):
    """invoke_element/focus_window/send_keys 注入 runner 时必须一律用它（mac 作载体），别因 sys.platform=linux 短路成
    "此平台暂不支持"——否则 ubuntu CI 上这些注入式工具测试全挂（与 capture_ax/capture_screenshot 已修同类，新函数又踩回）。
    只有"真机 + 无 runner + 不支持平台"才降级。CI 逮出：那台设备直推 main 时 ubuntu 已红、绕过 PR 没发现。"""
    def test_invoke_element注入runner时linux也走runner(self):
        seen = {}
        ok, _ = observe.invoke_element(0, runner=lambda a: (seen.update(argv=a), (0, "OK|Button|等于", ""))[1], plat="linux")
        self.assertIn("argv", seen)   # runner 被真调用（没被平台短路）
        self.assertTrue(ok)

    def test_send_keys注入runner时linux也走runner(self):
        seen = {}
        ok, _ = observe.send_keys("7", runner=lambda a: (seen.update(argv=a), (0, "OK|w", ""))[1], plat="linux")
        self.assertIn("argv", seen)
        self.assertTrue(ok)

    def test_focus_window注入runner时linux也走runner(self):
        seen = {}
        ok, _ = observe.focus_window("x", runner=lambda a: (seen.update(argv=a), (0, "OK|计算器", ""))[1], plat="linux")
        self.assertIn("argv", seen)
        self.assertTrue(ok)

    def test_无runner时不支持平台仍降级(self):
        self.assertFalse(observe.invoke_element(0, plat="linux")[0])
        self.assertFalse(observe.send_keys("7", plat="linux")[0])
        self.assertFalse(observe.focus_window("x", plat="linux")[0])


class F_按键密钥扫描抗SendKeys绕过(unittest.TestCase):
    def test_插入净零光标移动键拆分敏感token仍被拒(self):
        # SendKeys 的 {LEFT}{RIGHT}（光标左移右移、净零、不产字符）被用来把 .env 拆成 .e{LEFT}{RIGHT}nv 躲过
        # _cmd_hits 的子串扫描，但实际敲进终端仍是 .env → 扫描前须先剥掉 {..} 特殊键，命中即 deny。
        evil = "Get-Content .e{LEFT}{RIGHT}nv{ENTER}"
        self.assertEqual(permission.check("press_keys", {"keys": evil}).action, "deny")

    def test_ssh目录同样绕过被拒(self):
        self.assertEqual(permission.check("press_keys", {"keys": "type .s{LEFT}{RIGHT}sh\\config{ENTER}"}).action, "deny")

    def test_裸敏感命令仍被拒不回归(self):
        self.assertEqual(permission.check("press_keys", {"keys": "Get-Content .env{ENTER}"}).action, "deny")

    def test_普通按键不误拒(self):
        self.assertEqual(permission.check("press_keys", {"keys": "7{ENTER}"}).action, "ask")


if __name__ == "__main__":
    unittest.main(verbosity=2)
