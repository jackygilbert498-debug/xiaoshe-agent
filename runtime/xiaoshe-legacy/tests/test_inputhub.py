"""基M3 骨架 · steering stdin 单一归属（乙17）。TDD 红→绿。

加了「边跑边插话(steering)」后 stdin 有多个潜在读者（主循环 / approver / 插话），会互相抢：
用户审批的 y 被插话读走、或缓冲的插话被当成审批答案——污染不可逆动作的审批铁律。
修：一个 daemon 是**唯一读者**，按当前模式把每行投递到对应队列（审批期→审批队列，否则→插话队列），
approver 与主循环从队列取、绝不各自读 stdin。本骨架只做路由逻辑（可注入行源、无需真 stdin/线程）。
运行：仓库根 `python -m unittest tests.test_inputhub -v`
"""
import threading
import unittest

from harness import inputhub


class 分类投递(unittest.TestCase):
    def test_审批期的行进审批队列_其余进插话队列(self):
        hub = inputhub.InputHub()
        hub._route("你去把 a 文件也看下")          # 非审批期 → 插话
        hub.begin_approval()
        hub._route("y")                            # 审批期 → 审批
        hub.end_approval()
        hub._route("再顺手删掉 b")                  # 非审批期 → 插话
        self.assertEqual(hub.next_approval(timeout=0.01), "y")
        self.assertEqual(hub.next_message(timeout=0.01), "你去把 a 文件也看下")
        self.assertEqual(hub.next_message(timeout=0.01), "再顺手删掉 b")

    def test_劫持防护_缓冲的插话不被当成审批答案(self):
        # 用户在处理中先打了句插话，随后危险动作弹审批——那句插话绝不能被当成审批答案放行。
        hub = inputhub.InputHub()
        hub._route("顺便查下天气")                  # 处理中的插话（非审批期）
        hub.begin_approval()                       # 危险动作弹审批
        self.assertIsNone(hub.next_approval(timeout=0.01))   # 审批队列空——那句插话没被吞成答案
        hub._route("n")                            # 用户真正的审批答案
        self.assertEqual(hub.next_approval(timeout=0.01), "n")
        hub.end_approval()
        self.assertEqual(hub.next_message(timeout=0.01), "顺便查下天气")  # 插话仍在、原样留存

    def test_劫持防护_审批的y不被主循环插话读走(self):
        # 反向：审批期用户打 y，主循环此刻若也在 next_message 不能把 y 抢走。
        hub = inputhub.InputHub()
        hub.begin_approval()
        hub._route("y")
        self.assertIsNone(hub.next_message(timeout=0.01))    # 插话队列空——y 没进插话
        self.assertEqual(hub.next_approval(timeout=0.01), "y")

    def test_drain_steering一次取走所有缓冲插话(self):
        hub = inputhub.InputHub()
        for s in ("插话1", "插话2", "插话3"):
            hub._route(s)
        self.assertEqual(hub.drain_steering(), ["插话1", "插话2", "插话3"])
        self.assertEqual(hub.drain_steering(), [])          # 取空后再取为空

    def test_next队列空时超时返回None不阻塞(self):
        hub = inputhub.InputHub()
        self.assertIsNone(hub.next_approval(timeout=0.01))
        self.assertIsNone(hub.next_message(timeout=0.01))

    def test_红队HIGH_begin_approval抽干残留防上次答案串到下次(self):
        # 铁律：上一次审批的残留行绝不能自动答下一次审批（残留 y/a 会静默放行用户没看到的危险动作）。
        hub = inputhub.InputHub()
        hub.begin_approval()
        hub._route("a")          # 审批#1 的答案
        hub._route("y")          # 审批期多打的残留（本该让位、不算下次答案）
        hub.end_approval()
        self.assertEqual(hub.next_approval(timeout=0.01), "a")   # 审批#1 取到 a
        hub.begin_approval()     # 审批#2 开始 → 必须抽干残留 'y'
        self.assertIsNone(hub.next_approval(timeout=0.01))       # 审批#2 无自动答案，等用户真答

    def test_红队MED_EOF前入队消息closed后仍可取(self):
        # 主循环须先取队列再认 EOF——EOF 前已入队的用户指令别丢。
        hub = inputhub.InputHub()
        hub._route("重要任务别丢")
        hub.set_closed()          # EOF
        self.assertEqual(hub.next_message(timeout=0.01), "重要任务别丢")   # closed 也能取到 EOF 前入队的


class 唯一读者循环(unittest.TestCase):
    def test_run从行源读并投递直到EOF(self):
        hub = inputhub.InputHub()
        lines = iter(["第一句", "第二句"])
        def source():
            return next(lines, None)   # None = EOF
        stop = threading.Event()
        hub.run(source, stop)          # 读完两行遇 None 自然结束
        self.assertEqual(hub.next_message(timeout=0.01), "第一句")
        self.assertEqual(hub.next_message(timeout=0.01), "第二句")

    def test_run遇EOFError干净退出(self):
        hub = inputhub.InputHub()
        def source():
            raise EOFError
        hub.run(source, threading.Event())   # 不抛、干净退出
        self.assertIsNone(hub.next_message(timeout=0.01))

    def test_stop置位后循环退出(self):
        hub = inputhub.InputHub()
        stop = threading.Event()
        stop.set()
        called = []
        def source():
            called.append(1)
            return "x"
        hub.run(source, stop)                # stop 已置位 → 一进循环即退，不读
        self.assertEqual(called, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
