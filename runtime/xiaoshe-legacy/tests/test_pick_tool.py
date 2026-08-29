"""统一「裁剪-重问」子系统 P4a · pick 工具 + click_xy mac 分支。TDD 红→绿。

spec：docs/superpowers/specs/2026-07-19-统一裁剪重问子系统-design.md §组件3 pick 行 / §Mac 适配。
- pick(viewport_id, mark_no)：查视口表取 screen_cx/screen_cy（建视口时已换算好，模型零算术）
  → 走 click_at **同一执行函数**（同权限面：默认 ask、指纹绑坐标不跨会话持久、动作后 observe diff 汇报）。
- click_xy mac 分支：osascript JXA CoreGraphics CGEvent（mouseMoved→leftMouseDown→leftMouseUp，
  60ms 间隔对齐 Win 侧），坐标=逻辑点；真机已验（2026-07-22：点 (1280,12) CGEventGetLocation
  实测到位、鼠标可复原）。点完脚本内读位置校验——未授权辅助功能时 CGEventPost 静默无效，
  据此把 TCC 拒权从「假成功」里揪出来，错误文案挂 platform_caps 的辅助功能引导。
全部注入 runner 离线；真机冒烟一条 skipUnless(darwin)。
运行：仓库根 `python -m unittest tests.test_pick_tool -v`
"""
import subprocess
import sys
import unittest
from pathlib import Path

from harness import imaging, observe, permission, viewport
from harness import tools as tools_mod


def _reg_with_marks(marks, vid="v1"):
    """造一份会话注册表放一个带 marks 的视口（绕过 look，直接喂 pick 的查表层）。"""
    reg = viewport.new_registry()
    vp = viewport.new_viewport(vid, origin=(0, 0), scale=1.0, size=(800, 600), marks=marks)
    viewport.register(vp, reg)
    return reg


def _fake_shot(argv):
    """假区域截屏（click 像素差分读回的点前/点后帧）：写一张纯色合法 PNG，前后帧相同=像素无变化。
    .png 承载路径两形态都认（Mac=独立 argv 元素 / Win=PS 脚本内嵌，照 test_zoom_tool 先例）。"""
    import re as _re
    png = imaging.encode_png(4, 4, (bytes((32, 48, 64)) + b"\xff") * 16)
    for a in argv:
        m = _re.search(r"[^'\"\s]+\.png", a)
        if m:
            Path(m.group(0)).write_bytes(png)
            break
    return (0, "", "")


_MARKS = {1: {"no": 1, "label": "五", "screen_cx": 828, "screen_cy": 1358, "source": "uia+ocr"},
          2: {"no": 2, "label": "CE", "screen_cx": 828, "screen_cy": 760, "source": "uia"}}

_DUMP_BEFORE = "APP: TestApp\nWIN: 计算器\nText | 显示为 5 | pos=0,0 | size=9x9"
_DUMP_AFTER = "APP: TestApp\nWIN: 计算器\nText | 显示为 0 | pos=0,0 | size=9x9"


def _ctx(reg, dumps=(_DUMP_BEFORE, _DUMP_AFTER)):
    q = list(dumps)
    return {"session_id": "s", "_viewport_registry": reg,
            "_ax_runner": lambda s: q.pop(0) if len(q) > 1 else q[0],
            "_clickxy_runner": lambda argv: (0, "CLICKED|", ""),
            "_screencapture_runner": _fake_shot}   # click 像素差分读回的点前/点后帧（离线，不真截屏）


class mac_click分支(unittest.TestCase):
    """click_xy 补 darwin：JXA CGEvent，行协议 CLICKED|/ERR| 对齐 Win，_coord_int 校验复用。"""

    def test_argv形态_osascript_JXA_CGEvent_坐标插值(self):
        seen = {}

        def spy(argv):
            seen["argv"] = argv
            return (0, "CLICKED|", "")
        ok, _ = observe.click_xy(1280, 12, runner=spy, plat="darwin")
        self.assertTrue(ok)
        argv = seen["argv"]
        self.assertEqual(argv[0], "osascript")
        self.assertIn("JavaScript", argv)
        script = argv[-1]
        self.assertIn("CGEventCreateMouseEvent", script)
        self.assertIn("CGEventPost", script)
        self.assertIn("kCGEventMouseMoved", script)
        self.assertIn("kCGEventLeftMouseDown", script)
        self.assertIn("kCGEventLeftMouseUp", script)
        self.assertIn("var x=1280, y=12", script)          # 只插值 int，无自由文本
        self.assertIn("CGEventGetLocation", script)        # 点完校验鼠标真到位（TCC 拒权→静默不动）

    def test_CLICKED判成功_ERR判失败_对齐Win行协议(self):
        ok, _ = observe.click_xy(1, 2, runner=lambda a: (0, "CLICKED|", ""), plat="darwin")
        self.assertTrue(ok)
        ok, err = observe.click_xy(1, 2, runner=lambda a: (0, "ERR|鼠标未移动", ""), plat="darwin")
        self.assertFalse(ok)
        self.assertIn("鼠标未移动", err)

    def test_非零rc判失败(self):
        ok, err = observe.click_xy(1, 2, runner=lambda a: (1, "", "boom"), plat="darwin")
        self.assertFalse(ok)
        self.assertIn("boom", err)

    def test_ERR挂辅助功能授权引导(self):
        """TCC 拒权 → 脚本前置 AXIsProcessTrusted 直接报未授权（或位置校验原地未动），文案引导授权路径。"""
        ok, err = observe.click_xy(1, 2, runner=lambda a: (0, "ERR|辅助功能未授权（AXIsProcessTrusted=false）", ""),
                                   plat="darwin")
        self.assertFalse(ok)
        self.assertIn("系统设置", err)                    # 挂了授权引导
        ok, err = observe.click_xy(1, 2, runner=lambda a: (0, "ERR|鼠标原地未动（疑似辅助功能未授权）", ""),
                                   plat="darwin")
        self.assertFalse(ok)
        self.assertIn("系统设置", err)                    # 静默丢弃签名同样挂引导

    def test_移动未到位不挂授权引导(self):
        """红队真跑复现（2026-07-22）：超屏坐标 (30000,12)/(-100,12) 被系统钳制，鼠标动了但没到位——
        不是授权问题，挂「辅助功能未授权」引导会把模型/用户骗去系统设置空转。"""
        ok, err = observe.click_xy(30000, 12, plat="darwin",
                                   runner=lambda a: (0, "ERR|鼠标移动了但未到位（停在 2559,0，目标可能超出屏幕边界）", ""))
        self.assertFalse(ok)
        self.assertIn("超出屏幕边界", err)
        self.assertNotIn("系统设置", err)                 # 不误导去授权
        self.assertNotIn("辅助功能未授权", err)

    def test_脚本前置TCC检查防假成功(self):
        """鼠标恰已在目标点 ±1 内 + TCC 拒权时，纯位置校验会假 CLICKED——脚本须先查 AXIsProcessTrusted。"""
        script = observe._mac_click_jxa(100, 200)
        self.assertIn("AXIsProcessTrusted", script)
        self.assertIn("鼠标原地未动", script)             # 原地未动（静默丢弃）与移动未到位（钳制/竞争）分流
        self.assertIn("移动了但未到位", script)

    def test_读回紧跟leftMouseUp_不等50ms_竞争窗口最小(self):
        """真机诊断（2026-07-22 探针两轮 40 次）：CGEventGetLocation 读回偏差随等待**增大**
        （0ms 读 18/20 精确到位，50ms 11/20 偏、300ms 13/20 偏）——活机真鼠标在合成事件落位后
        立刻抢回光标，等越久读到真鼠标新位置的概率越大。金标准误报（停在 2335,332 偏离 70+px
        但实际命中）即此竞态。故 up 后须**立即读**，不得再 delay 0.05。"""
        script = observe._mac_click_jxa(100, 200)
        up_idx = script.index("post($.kCGEventLeftMouseUp)")
        read_idx = script.index("CGEventGetLocation", up_idx)
        self.assertNotIn("delay(", script[up_idx:read_idx])   # up → 首次读回之间零等待

    def test_读回未到位短确认重试_取最近读数判定(self):
        """首读未到位时允许 10ms 级有界确认重试、取**离目标最近**的读数判定：
        防偶发读早（事件流中间态），又不实质放宽竞争窗口；±1 容差不动
        （超屏钳制的几千 px 偏差仍与到位差着数量级，分流不破）。"""
        script = observe._mac_click_jxa(100, 200)
        self.assertIn("delay(0.01)", script)        # 确认重试间隔 10ms 级
        self.assertIn("i<2 &&", script)             # 有界（最多补读 2 次）且到位即停
        self.assertIn("best", script)               # 取最近目标的读数判定与报错

    def test_超屏目标NSScreen帧预检_不信读回(self):
        """探针实测（2026-07-22，30/30 复现）：CGEventGetLocation 读回的是最后 post 的**原始未钳制**
        逻辑位置且跨进程**粘住**（post (30000,12) 后 0~800ms 乃至新进程都读回 (30000,12)，直到物理鼠标
        移动才回真值）——超屏坐标在静机下任何时机的读回都假 CLICKED。脚本须用 NSScreen.screens 逐帧
        （AppKit→CG 换算）预检目标是否在任一显示屏内，超屏直接判「移动未到位」，不信读回。"""
        script = observe._mac_click_jxa(100, 200)
        self.assertIn("NSScreen.screens", script)
        self.assertIn("onscreen", script)
        self.assertLess(script.index("!onscreen"), script.index("CLICKED|"))   # 超屏预检先于到位判定

    def test_坐标校验复用_拒布尔字符串越界(self):
        for bad in ("100", 8.5, True, None, 99999):
            with self.assertRaises((ValueError, TypeError)):
                observe.click_xy(bad, 10, runner=lambda a: (0, "CLICKED|", ""), plat="darwin")

    def test_真机不支持的其它平台仍报不支持(self):
        ok, err = observe.click_xy(1, 2, plat="linux")
        self.assertFalse(ok)
        self.assertIn("不支持", err)


class mac_click预移动防假成功(unittest.TestCase):
    """红队两轮确认的残留洞（2026-07-23 修）：CGEvent 事件全丢（系统静默丢弃）+ 鼠标恰停在目标 ±1 内
    → 读回「到位」→ 假 CLICKED（真机复现：篡改 post 空操作 + 预停目标，输出 CLICKED|）。
    修法=候选 A：点击前读 P0，P0≈目标（读回失效场景）时先预移动出目标点再执行正常序列——
    预移动没落位 = 事件真被丢（原地未动），落位后「停在目标」必然是事件真送达，读回重新有效。"""

    def test_P0在目标容差内才预移动_正常路径零额外事件(self):
        """预移动是条件分支：只有 P0≈目标（±1）才触发；P0 远离目标时序列与旧版完全一致
        （mouseMoved→60ms→down→60ms→up），不多发任何事件。"""
        script = observe._mac_click_jxa(100, 200)
        self.assertIn("l0=$.CGEventGetLocation", script)            # 点击前先读 P0
        guard = "Math.abs(l0.x-x)<=1 && Math.abs(l0.y-y)<=1"
        self.assertIn(guard, script)                                # 触发条件=P0≈目标 ±1
        self.assertLess(script.index(guard), script.index("post($.kCGEventMouseMoved)"))  # 判定在主序列前
        # 主序列本身不变：moved→delay→down→delay→up 原顺序原间隔
        i_mv = script.index("post($.kCGEventMouseMoved);")
        i_dn = script.index("post($.kCGEventLeftMouseDown);")
        i_up = script.index("post($.kCGEventLeftMouseUp);")
        self.assertLess(i_mv, i_dn)
        self.assertLess(i_dn, i_up)
        self.assertIn("post($.kCGEventMouseMoved); delay(0.06);", script)
        self.assertIn("post($.kCGEventLeftMouseDown); delay(0.06);", script)

    def test_预移动只发mouseMoved不落click(self):
        """预移动是纯移动（无害，不在预移动点上落 down/up）。"""
        script = observe._mac_click_jxa(100, 200)
        guard = "Math.abs(l0.x-x)<=1 && Math.abs(l0.y-y)<=1"
        pre_block = script[script.index(guard):script.index("post($.kCGEventMouseMoved);")]
        self.assertIn("kCGEventMouseMoved", pre_block)
        self.assertNotIn("LeftMouseDown", pre_block)
        self.assertNotIn("LeftMouseUp", pre_block)

    def test_预移动方向候选四角_取屏内首个(self):
        """目标近边缘时 (x+8,y+8) 可能越界——候选四角方向 (+8,+8)/(-8,-8)/(+8,-8)/(-8,+8)，
        用与超屏预检同一个 NSScreen 帧判定取第一个屏内的。"""
        script = observe._mac_click_jxa(100, 200)
        for cand in ("x+8", "x-8", "y+8", "y-8"):
            self.assertIn(cand, script)
        guard = "Math.abs(l0.x-x)<=1 && Math.abs(l0.y-y)<=1"
        pre_block = script[script.index(guard):script.index("post($.kCGEventMouseMoved);")]
        self.assertIn("inscreen", pre_block)                        # 候选点过 NSScreen 帧判定

    def test_预移动未落位_禁到位判定_落原地未动或移动未到位(self):
        """事件全丢时预移动也落不了位（读回=P0≈目标）——此时绝不能再判 CLICKED
        （旧洞正是这里假成功）：CLICKED 分支须以「预移动已落位/未触发预移动」为前提，
        未落位按读回相对 P0 分流：≈P0 → 原地未动（挂授权引导）；≠P0 → 移动未到位（竞争）。"""
        script = observe._mac_click_jxa(100, 200)
        self.assertIn("skip=true", script)                          # 预移动未落位置标志
        self.assertLess(script.index("skip=true"), script.index("CLICKED|"))
        self.assertIn("!skip && Math.abs(best.x-x)<=1", script)     # 到位判定被 skip 闭锁
        self.assertIn("鼠标原地未动", script)                       # 分流文案不破
        self.assertIn("移动了但未到位", script)

    def test_预移动落位读回带正负1容差(self):
        """预移动落位校验与主读回同标准（±1），且预移动落位失败时 best 已置为预移动读回——
        直接复用末尾三分流，不再发主序列事件（事件已证丢，点了也白点）。"""
        script = observe._mac_click_jxa(100, 200)
        self.assertIn("Math.abs(lp.x-px)>1 || Math.abs(lp.y-py)>1", script)


class pick参数与视口校验(unittest.TestCase):
    def test_视口不存在_报视口已过期引导重新look(self):
        ctx = {"session_id": "s"}                           # 无注册表
        res = tools_mod.execute("pick", {"viewport_id": "v9", "mark_no": 1}, ctx)
        self.assertIn("视口已过期", res.content)             # spec §错误处理原话
        self.assertIn("重新 look", res.content)

    def test_视口被LRU淘汰_同样报已过期(self):
        reg = viewport.new_registry()                       # 空注册表（v1 已被淘汰的场景）
        ctx = _ctx(reg)
        res = tools_mod.execute("pick", {"viewport_id": "v1", "mark_no": 1}, ctx)
        self.assertIn("视口已过期", res.content)

    def test_缺参数_报错(self):
        ctx = _ctx(_reg_with_marks(_MARKS))
        for args in ({}, {"viewport_id": "v1"}, {"mark_no": 1}, {"viewport_id": "  ", "mark_no": 1}):
            res = tools_mod.execute("pick", args, ctx)
            self.assertTrue(res.is_error, f"args={args} 应报错")

    def test_mark_no无效_列出有效编号(self):
        ctx = _ctx(_reg_with_marks(_MARKS))
        res = tools_mod.execute("pick", {"viewport_id": "v1", "mark_no": 99}, ctx)
        self.assertIn("99", res.content)
        self.assertIn("1~2", res.content)                   # 列出有效编号范围
        res0 = tools_mod.execute("pick", {"viewport_id": "v1", "mark_no": 0}, ctx)
        self.assertIn("1~2", res0.content)

    def test_mark_no严格整数_布尔浮点字符串拒(self):
        """照 P3 红队修 zoom 的同款：int(True)=1 静默当 1 号、浮点截断、数字字符串照收——一律拒。"""
        ctx = _ctx(_reg_with_marks(_MARKS))
        for bad in (True, 1.0, 1.5, "1"):
            res = tools_mod.execute("pick", {"viewport_id": "v1", "mark_no": bad}, ctx)
            self.assertTrue(res.is_error, f"mark_no={bad!r} 应报错")
            self.assertIn("整数", res.content)


class pick执行路径(unittest.TestCase):
    def test_与click_at同一执行函数_间谍断言(self):
        """pick 不复制粘贴点击逻辑——必须调到 click_at 共用的执行函数，坐标从 marks 表解析。"""
        ctx = _ctx(_reg_with_marks(_MARKS))
        calls = []
        sentinel = "（间谍：共用执行路径已被调用）"
        orig = tools_mod._do_click_at
        tools_mod._do_click_at = lambda c, x, y, mark=None: calls.append((c, x, y)) or sentinel
        try:
            res = tools_mod.execute("pick", {"viewport_id": "v1", "mark_no": 1}, ctx)
        finally:
            tools_mod._do_click_at = orig
        self.assertFalse(res.is_error)
        self.assertEqual(len(calls), 1)
        self.assertEqual((calls[0][1], calls[0][2]), (828, 1358))   # marks[1] 的屏幕坐标
        self.assertIn(sentinel, res.content)                        # 返回 = 执行函数的汇报

    def test_汇报含编号label坐标与界面变化(self):
        ctx = _ctx(_reg_with_marks(_MARKS))
        res = tools_mod.execute("pick", {"viewport_id": "v1", "mark_no": 1}, ctx)
        self.assertFalse(res.is_error)
        self.assertIn("828", res.content)                   # 点了哪个坐标
        self.assertIn("1358", res.content)
        self.assertIn("1", res.content)                     # 哪个编号
        self.assertIn("五", res.content)                    # 哪个 label（方便模型核对）
        self.assertIn("显示为 0", res.content)              # click_at 同款的界面变化汇报

    def test_click_at本身仍走共用函数_行为不变(self):
        """抽取共用后 click_at 旧行为不破（同 test_ocr_boxes_clickat 的汇报形态）。"""
        ctx = _ctx(_reg_with_marks(_MARKS))
        res = tools_mod.execute("click_at", {"x": 828, "y": 760}, ctx)
        self.assertFalse(res.is_error)
        self.assertIn("828", res.content)
        self.assertIn("显示为 0", res.content)

    def test_点击失败_如实回报(self):
        ctx = _ctx(_reg_with_marks(_MARKS))
        ctx["_clickxy_runner"] = lambda argv: (0, "ERR|鼠标未移动到目标位置", "")
        res = tools_mod.execute("pick", {"viewport_id": "v1", "mark_no": 1}, ctx)
        self.assertIn("失败", res.content)


class pick权限面(unittest.TestCase):
    def test_注册且默认ask_工具数38(self):
        self.assertIn("pick", tools_mod.REGISTRY)
        self.assertEqual(len(tools_mod.REGISTRY), 38)       # 37 → 38
        spec = [s for s in tools_mod.SPECS if s["function"]["name"] == "pick"][0]
        fn = spec["function"]
        self.assertIn("viewport_id", fn["parameters"]["required"])
        self.assertIn("mark_no", fn["parameters"]["required"])
        self.assertEqual(fn["parameters"]["additionalProperties"], False)
        self.assertEqual(permission.check("pick", {"viewport_id": "v1", "mark_no": 1}).action, "ask")
        self.assertNotIn("pick", tools_mod.READONLY_TOOLS)  # 状态改变，不是只读

    def test_污点高危与effects账本对齐click_at(self):
        from harness import effects
        self.assertIn("pick", permission._TAINT_HIGH_RISK)
        self.assertIn("pick", effects.SIDE_EFFECT_TOOLS)
        self.assertIn("v1#3", effects._target("pick", {"viewport_id": "v1", "mark_no": 3}))

    def test_指纹绑视口编号与解析坐标(self):
        """权限层对 pick 的审批指纹 = viewport_id + mark_no + 解析后的屏幕坐标——
        一次批准不放行任意编号/任意坐标（对齐 click_at 红队 L1 修复）。"""
        from harness import agent
        ctx = {"_viewport_registry": _reg_with_marks(_MARKS)}
        k1 = agent._approval_key("pick", {"viewport_id": "v1", "mark_no": 1}, ctx)
        self.assertIn("v1", k1)
        self.assertIn("1", k1)
        self.assertIn("828", k1)                            # 解析后的坐标进指纹
        self.assertIn("1358", k1)
        k2 = agent._approval_key("pick", {"viewport_id": "v1", "mark_no": 2}, ctx)
        self.assertNotEqual(k1, k2)                         # 换编号 → 换指纹
        # 视口表内容变了（重 look 后同编号不同坐标）→ 指纹变，不躺着放行旧批准
        reg2 = _reg_with_marks({1: {"no": 1, "label": "五", "screen_cx": 100, "screen_cy": 200, "source": "uia"}})
        k3 = agent._approval_key("pick", {"viewport_id": "v1", "mark_no": 1}, {"_viewport_registry": reg2})
        self.assertNotEqual(k1, k3)

    def test_答a后换编号仍要问(self):
        from harness import agent
        reg = _reg_with_marks(_MARKS)
        ctx = {"_viewport_registry": reg,
               "_approved_tools": {agent._approval_key("pick", {"viewport_id": "v1", "mark_no": 1},
                                                       {"_viewport_registry": reg})}}
        asked = []
        approver = lambda n, a, r: asked.append(1) or False
        self.assertTrue(agent._approved("pick", {"viewport_id": "v1", "mark_no": 1}, "点", approver, ctx))
        self.assertEqual(asked, [])                          # 同编号同坐标：白名单命中免问
        self.assertFalse(agent._approved("pick", {"viewport_id": "v1", "mark_no": 2}, "点", approver, ctx))
        self.assertEqual(asked, [1])                         # 换编号：必须重问

    def test_指纹不跨会话持久(self):
        """坐标/编号语义随窗口布局与视口淘汰朽坏 → 答 p 只本会话放行，不落 .state 永久白名单。"""
        from unittest import mock
        from harness import agent, approvals
        reg = _reg_with_marks(_MARKS)
        persistent = set()
        ctx = {"_viewport_registry": reg, "_persistent_approved": persistent}
        with mock.patch.object(approvals, "add") as padd:
            ok = agent._approved("pick", {"viewport_id": "v1", "mark_no": 1}, "点",
                                 lambda n, a, r: "persist", ctx)
        self.assertTrue(ok)
        self.assertEqual(persistent, set())                  # 没进跨会话集
        padd.assert_not_called()                             # 没落盘


@unittest.skipUnless(sys.platform == "darwin", "仅 macOS 真机冒烟")
class mac_click真机冒烟(unittest.TestCase):
    """真点一次无害坐标：主屏菜单栏中央空隙（点击该处无副作用）。用 CGEventGetLocation
    前后对比验证鼠标真移动（真机已验 TCC 授权下到位），点后把鼠标移回原位。需辅助功能授权。
    活机上用户真鼠标可能恰好也在动（全量跑 38s 里撞上过）→ 竞争窗口 ~140ms（2026-07-22 读回时机修复后：
    60+60ms 事件间隔 + 最多 2×10ms 确认重试；旧实现 up 后再等 50ms 才读，窗口 ~170ms 且偏差随等待增大），
    重试几次再判失败。"""

    @staticmethod
    def _cur_pos():
        out = subprocess.run(
            ["osascript", "-l", "JavaScript", "-e",
             'ObjC.import("CoreGraphics");var l=$.CGEventGetLocation($.CGEventCreate($()));l.x+","+l.y'],
            capture_output=True, text=True, timeout=20)
        px, py = out.stdout.strip().split(",")
        return float(px), float(py)

    def test_事件全丢且P0在目标_报原地未动不假CLICKED(self):
        """残留洞真机回归（2026-07-23）：篡改脚本把 CGEventPost 全改空操作（模拟事件被系统静默丢弃）
        + 真 mouseMoved 预先把鼠标停到目标 ±1 内。修复前读回「到位」假 CLICKED（本机已复现）；
        修复后预移动落不了位 → 正确报「原地未动」。需辅助功能授权（真移动那步要真 post）。"""
        import time as _time
        cur_pos = self._cur_pos
        mv = ('ObjC.import("CoreGraphics");var ev=$.CGEventCreateMouseEvent($(),$.kCGEventMouseMoved,'
              '$.CGPointMake(1280,12),$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,ev)')
        ox, oy = cur_pos()
        try:
            subprocess.run(["osascript", "-l", "JavaScript", "-e", mv],
                           capture_output=True, timeout=20)          # 真把鼠标停到目标
            _time.sleep(0.2)
            script = observe._mac_click_jxa(1280, 12)
            tampered = script.replace("$.CGEventPost($.kCGHIDEventTap,ev);", "")
            self.assertNotEqual(tampered, script)                    # 篡改确实生效
            out = subprocess.run(["osascript", "-l", "JavaScript", "-e", tampered],
                                 capture_output=True, text=True, timeout=20).stdout
            print(f"\n===== 事件全丢+P0在目标 真机回归：{out.strip()!r} =====")
            self.assertNotIn("CLICKED", out)                         # 绝不再假成功
            self.assertIn("原地未动", out)                           # 正确报静默丢弃签名
        finally:
            subprocess.run(                                          # 鼠标移回原位（只移动、不点）
                ["osascript", "-l", "JavaScript", "-e",
                 f'ObjC.import("CoreGraphics");var ev=$.CGEventCreateMouseEvent($(),$.kCGEventMouseMoved,'
                 f'$.CGPointMake({ox},{oy}),$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,ev)'],
                capture_output=True, timeout=20)

    def test_真点击鼠标真移动(self):
        import time as _time

        def cur_pos():
            out = subprocess.run(
                ["osascript", "-l", "JavaScript", "-e",
                 'ObjC.import("CoreGraphics");var l=$.CGEventGetLocation($.CGEventCreate($()));l.x+","+l.y'],
                capture_output=True, text=True, timeout=20)
            px, py = out.stdout.strip().split(",")
            return float(px), float(py)

        ox, oy = cur_pos()
        ok, err = False, ""
        try:
            for attempt in range(3):                        # 用户真鼠标竞争 → 重试；TCC 拒权则三次都 ERR
                ok, err = observe.click_xy(1280, 12)        # 不注入 runner：真发 CGEvent
                if ok:
                    break
                _time.sleep(0.3)
            print(f"\n===== mac click 真机冒烟：({ox},{oy}) → 点 (1280,12)，第 {attempt + 1} 次 ok={ok} err={err!r} =====")
            self.assertTrue(ok, f"真点击失败：{err}")
            nx, ny = cur_pos()
            self.assertAlmostEqual(nx, 1280, delta=1)
            self.assertAlmostEqual(ny, 12, delta=1)
            print(f"===== CGEventGetLocation 实测到位 ({nx},{ny}) =====")
        finally:
            subprocess.run(                                  # 鼠标移回原位（只移动、不点）
                ["osascript", "-l", "JavaScript", "-e",
                 f'ObjC.import("CoreGraphics");var ev=$.CGEventCreateMouseEvent($(),$.kCGEventMouseMoved,'
                 f'$.CGPointMake({ox},{oy}),$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,ev)'],
                capture_output=True, timeout=20)


if __name__ == "__main__":
    unittest.main(verbosity=2)
