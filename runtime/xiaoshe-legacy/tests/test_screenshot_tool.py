"""视觉 · screenshot 工具：整屏截图存成工作区 PNG，补「截屏→ocr(boxes)→click_at」链的第一步。TDD 红→绿。

此前该链的截图只能人工预置（模型看得见点不了却截不了屏）。本工具复用 observe.capture_screenshot
（DPI 感知已修、物理分辨率），整屏 only——ocr(boxes) 词框中心 = click_at 屏幕坐标只在整屏下同系。
安全面：授权对齐 observe（不进 SAFE_TOOLS 默认 ask）；写盘=写类（不进 READONLY_TOOLS、记 effects 账本）；
路径过 safe_path + 显式禁 .state + 只准 .png + 拒绝覆盖已存在文件（堵「污点路径覆盖工作区资产」）；
截图字节只存盘不进上下文 → 本工具不入污点（下游 read_image/ocr 各自把关）。
本文件=两个并行会话实现的并集：工具内护栏（对抗审查 8 角度 9 项修复）+ permission 层收口
（screenshot 入污点闸名单、.state 整树 safe_path 设防）。
运行：仓库根 `python -m unittest tests.test_screenshot_tool -v`
"""
import re
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

from harness import effects, permission
from harness import tools as tools_mod


def solid_png(w, h, rgb=(10, 20, 30)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


# 承载文件路径可能是独立 argv 元素（macOS screencapture 尾参），也可能内嵌在命令串里
# （Windows System.Drawing 走 powershell -Command "...$b.Save('C:\\...\\tmpXXXX.png')..."）——两种形状都要认。
_PNG_PATH = re.compile(r"[^'\"\s]+\.png")


def shot_runner(rc=0, err="", w=100, h=60):
    def fake(argv):
        if rc == 0:
            for a in argv:
                m = _PNG_PATH.search(a)
                if m:
                    Path(m.group(0)).write_bytes(solid_png(w, h))
                    break
        return (rc, "", err)
    return fake


class screenshot注册与权限面(unittest.TestCase):
    def test_注册且有SPEC声明_path可选(self):
        self.assertIn("screenshot", tools_mod.REGISTRY)
        specs = [s for s in tools_mod.SPECS if s["function"]["name"] == "screenshot"]
        self.assertEqual(len(specs), 1)   # 并行会话合并后绝不残留重复 SPEC（重复会喂 Kimi 两个同名工具）
        params = specs[0]["function"]["parameters"]
        self.assertIn("path", params["properties"])
        self.assertNotIn("path", params.get("required", []))   # path 缺省 → 自动命名

    def test_默认先问_对齐observe授权面(self):
        # 读屏是敏感能力：和 observe 一样不进安全白名单，首次必过 ask 闸门
        self.assertNotIn("screenshot", permission.SAFE_TOOLS)
        d = permission.check("screenshot", {})
        self.assertEqual(d.action, "ask")
        self.assertIn("窗口", d.reason)   # 审批提示要说清隐私面：整屏含所有可见窗口内容，别只给裸工具名

    def test_SPEC如实说明只截主显示器(self):
        # 对抗审查：Windows 实现用 PrimaryScreen.Bounds，双屏时副屏不在截图里——描述必须诚实，别让模型误判「看全了」
        spec = next(s for s in tools_mod.SPECS if s["function"]["name"] == "screenshot")
        self.assertIn("主显示器", spec["function"]["description"])

    def test_写盘算写类_不入只读集(self):
        # 写盘=有副作用：成功要算「改过外部状态」（触发收尾验证 dirty），不能进只读集
        self.assertNotIn("screenshot", tools_mod.READONLY_TOOLS)

    def test_effects账本记screenshot(self):
        self.assertIn("screenshot", effects.SIDE_EFFECT_TOOLS)
        self.assertIn("x.png", effects._target("screenshot", {"path": "x.png"}))

    def test_污点高危名单含screenshot(self):
        # 红队 F1（permission 层）：screenshot 写盘却曾漏在污点闸外——模型逐字把不可信 OCR/网页文本
        # 当 path 时必须复问，不能经会话白名单洗白后静默写盘
        self.assertIn("screenshot", permission._TAINT_HIGH_RISK)


class screenshot存盘(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.root = Path(self._d.name)
        self._rp = mock.patch.object(permission, "ROOT", self.root)
        self._rp.start()
        self.addCleanup(self._rp.stop)
        self.addCleanup(self._d.cleanup)
        self.ctx = {"session_id": "s", "_screencapture_runner": shot_runner()}

    def _pngs(self):
        return sorted(p for p in self.root.rglob("*.png"))

    def test_缺省自动命名存盘_报路径与分辨率(self):
        res = tools_mod.execute("screenshot", {}, self.ctx)
        self.assertFalse(res.is_error, res.content)
        files = self._pngs()
        self.assertEqual(len(files), 1)
        self.assertIn(files[0].name, res.content)          # 返回里能看到落盘文件名
        self.assertIn("100", res.content)                  # 分辨率 100x60（solid_png）
        self.assertIn("60", res.content)
        self.assertIn("ocr", res.content)                  # 引导下一步：ocr(boxes)→click_at 链
        self.assertIn("click_at", res.content)

    def test_连截两次不同名_都落盘(self):
        # 同秒内第二张不能覆盖第一张（自动命名要去重）
        tools_mod.execute("screenshot", {}, self.ctx)
        tools_mod.execute("screenshot", {}, self.ctx)
        self.assertEqual(len(self._pngs()), 2)

    def test_执行后把实际路径写回args_账本可记(self):
        # 缺省自动命名时 args 原本无 path——工具要把真实落盘路径写回 args，effects 账本才能记「动了哪个文件」
        args = {}
        tools_mod.execute("screenshot", args, self.ctx)
        self.assertTrue(str(args.get("path", "")).endswith(".png"))
        self.assertIn(".png", effects._target("screenshot", args))

    def test_显式path存到指定位置_自动建父目录(self):
        res = tools_mod.execute("screenshot", {"path": "shots/a.png"}, self.ctx)
        self.assertFalse(res.is_error, res.content)
        self.assertTrue((self.root / "shots" / "a.png").exists())
        # 返回引导语里的路径用正斜杠：模型照抄 shots\a.png 进 JSON 参数会成非法转义（\a），链在 ocr 一步断掉
        self.assertIn("shots/a.png", res.content)
        self.assertNotIn("shots\\a.png", res.content)

    def test_已存在同名拒绝覆盖(self):
        # 截图绝不覆盖任何现有文件（防覆盖工作区资产/代码；截图廉价，换名即可）
        (self.root / "a.png").write_bytes(b"old")
        res = tools_mod.execute("screenshot", {"path": "a.png"}, self.ctx)
        self.assertTrue(res.is_error)
        self.assertIn("已存在", res.content)
        self.assertEqual((self.root / "a.png").read_bytes(), b"old")   # 原文件毫发无损

    def test_非png后缀拒绝(self):
        res = tools_mod.execute("screenshot", {"path": "a.txt"}, self.ctx)
        self.assertTrue(res.is_error)
        self.assertFalse((self.root / "a.txt").exists())

    def test_禁写state内部状态目录(self):
        res = tools_mod.execute("screenshot", {"path": ".state/x.png"}, self.ctx)
        self.assertTrue(res.is_error)
        self.assertFalse((self.root / ".state" / "x.png").exists())
        res2 = tools_mod.execute("screenshot", {"path": ".State/深//x.png"}, self.ctx)   # 大小写变体也拦
        self.assertTrue(res2.is_error)
        # 红队：Win32 会剥目录名结尾的点/空格——".state." 实际落进 .state，判定要按剥后等价
        for evil in (".state./x.png", ".state /x.png"):
            r = tools_mod.execute("screenshot", {"path": evil}, self.ctx)
            self.assertTrue(r.is_error, f"path={evil!r} 应被拒")
        self.assertFalse((self.root / ".state").exists())

    def test_state整树对全部文件工具设防(self):
        # 红队 F3（permission 层）：原来只拦 schedule/user_tools/undo 三子目录，effects.jsonl/blobs/approvals
        # 都能被写（覆盖审计账本=反取证）。_is_sensitive 收成 .state 整树 deny——write_file/edit/read_file 同得防护
        for bad in (".state/effects.jsonl", ".state/blobs/x.png", ".state/approvals.json"):
            with self.assertRaises(permission.PathError, msg=f"{bad} 应被 safe_path 拒"):
                permission.safe_path(bad)

    def test_Windows保留设备名拒绝(self):
        # NUL.png/CON.png 会被 Win32 映射到设备：写进去静默丢失却报「已存」，谎报成功——直接拒
        for name in ("NUL.png", "con.png", "COM1.png", "lpt9.png", "shots/aux.png"):
            res = tools_mod.execute("screenshot", {"path": name}, self.ctx)
            self.assertTrue(res.is_error, f"path={name} 应被拒")
        self.assertEqual(self._pngs(), [])

    def test_越界路径决策层与执行层双拒(self):
        self.assertEqual(permission.check("screenshot", {"path": "../out.png"}).action, "deny")
        res = tools_mod.execute("screenshot", {"path": "../out.png"}, self.ctx)   # 执行层 safe_path 兜底
        self.assertTrue(res.is_error)
        self.assertFalse((self.root.parent / "out.png").exists())

    def test_截屏失败返回引导_不留文件_且是错误态(self):
        # 对抗审查（3 个角度独立命中）：失败若回普通字符串（is_error=False），effects 账本会记一条
        # ok=True 的幽灵副作用、还把会话标 dirty 白烧一次收尾验证——必须走错误态
        ctx = {"session_id": "s",
               "_screencapture_runner": shot_runner(rc=1, err="could not create image from display")}
        res = tools_mod.execute("screenshot", {}, ctx)
        self.assertTrue(res.is_error)                      # 没落盘就不是成功
        self.assertIn("屏幕录制", res.content)             # 平台授权引导（CAP_GUIDE）仍带给模型
        self.assertEqual(self._pngs(), [])                 # 工作区没落任何文件

    def test_截图内容不入污点(self):
        # 截图字节只存盘、不进模型上下文 → 本工具不记污点；后续 read_image/ocr 各自入污点
        tools_mod.execute("screenshot", {}, self.ctx)
        self.assertFalse(self.ctx.get("_tainted"))

    def test_打转检测不被路径写回打穿(self):
        # 对抗审查：args 写回实际路径发生在执行后——agent 的「连续相同参数」检测必须按模型原始参数计，
        # 否则 screenshot({}) 每次回填不同时间戳名、循环连拍永不触发系统提醒
        from harness import agent as agent_mod
        log = self.root / "log.jsonl"
        approver = lambda name, args, reason: True
        ctx = dict(self.ctx)
        for _ in range(3):
            tc = {"id": "t1", "function": {"name": "screenshot", "arguments": "{}"}}
            agent_mod._handle_tool_call(tc, [], approver, log, ctx)
        self.assertEqual(ctx.get("_repeat", {}).get("n"), 3)


if __name__ == "__main__":
    unittest.main()
