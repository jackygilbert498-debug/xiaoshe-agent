"""基M3 骨架 · steering stdin 单一归属（乙17）。

加了「边跑边插话(steering)」后，stdin 会有多个潜在读者互相抢：用户审批不可逆动作的 y 被插话读走、
或用户在处理中先打的插话被下一个弹出的审批当成答案吞掉——都会污染「危险动作必须由用户当次明确批准」的铁律。

修：**一个 daemon 线程是 stdin 的唯一读者**，按当前模式把每行分类投递到两条队列：
- 审批期（begin_approval→end_approval 之间）读到的行 → 审批队列，approver 从这里取。
- 其余时刻读到的行 → 插话队列，主循环空闲时取作新一轮输入、处理中 drain 出来作 steering。

approver 与主循环都**从队列取、绝不各自读 stdin**。模式标志在读到行的那一刻决定归属：用户在看到审批提示前打的
话归插话（本就不是答案）、看到提示后打的 y/n 归审批——两条队列互不串。

本文件是骨架：只做路由 + 唯一读者循环（行源可注入，便于离线测试）。接真 repl（真 stdin、bracketed paste
组装、把 steering 注入运行中的轮次）留下一增量，那步要配真机验证 + 红队。
"""
from __future__ import annotations

import queue
import threading


class InputHub:
    def __init__(self):
        self._approval_q: queue.Queue = queue.Queue()
        self._steering_q: queue.Queue = queue.Queue()
        self._approving = threading.Event()   # set = 审批模式（读到的行归审批队列）
        self._closed = threading.Event()      # set = stdin EOF/读者已退（consumer 据此别永久阻塞等答案）

    def set_closed(self) -> None:
        self._closed.set()

    def is_closed(self) -> bool:
        return self._closed.is_set()

    # ---- 唯一读者线程内：分类投递 ----
    def _route(self, line: str) -> None:
        """把一行投递到对应队列（只在唯一读者线程内调用）。审批模式→审批队列，否则→插话队列。"""
        (self._approval_q if self._approving.is_set() else self._steering_q).put(line)

    def run(self, source, stop: threading.Event) -> None:
        """唯一读者循环：反复调 source() 读一行并 _route 投递，直到 stop 置位 / source 返回 None / 抛 EOFError。

        source：无参可调用，返回一行（可含换行）或 None 表示 EOF。真 stdin 场景由调用方包装（含 bracketed paste 组装）。
        """
        while not stop.is_set():
            try:
                line = source()
            except EOFError:
                return
            if line is None:
                return
            self._route(line)

    # ---- 模式切换（approver 前后调）----
    def begin_approval(self) -> None:
        # 红队 HIGH：先抽干审批队列——新审批提示一弹，此前队列里任何行都是陈旧的（上次审批的残留 / 审批期多打的），
        # 绝不能算作本次答案，否则残留的 y/a 会把用户【没看到的】不可逆动作静默放行，击穿审批铁律。
        while True:
            try:
                self._approval_q.get_nowait()
            except queue.Empty:
                break
        self._approving.set()

    def end_approval(self) -> None:
        self._approving.clear()

    # ---- 消费端：approver / 主循环从队列取 ----
    def next_approval(self, timeout: float | None = None) -> str | None:
        """取一条审批答案；队列空且超时返回 None（approver 据此决定继续等或超时默认拒）。"""
        try:
            return self._approval_q.get(timeout=timeout)
        except queue.Empty:
            return None

    def next_message(self, timeout: float | None = None) -> str | None:
        """取一条插话/新一轮输入；队列空且超时返回 None。"""
        try:
            return self._steering_q.get(timeout=timeout)
        except queue.Empty:
            return None

    def drain_steering(self) -> list:
        """一次取走当前缓冲的所有插话（处理中在安全点注入用）；无则返回空列表。"""
        out = []
        while True:
            try:
                out.append(self._steering_q.get_nowait())
            except queue.Empty:
                return out
