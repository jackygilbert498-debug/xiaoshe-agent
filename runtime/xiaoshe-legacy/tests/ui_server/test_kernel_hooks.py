"""内核仪表化（M0）自测试：agent.py 事件钩子 / 总线审批分支 / tools & jobs 仪表化。

全离线：假 model_fn 驱动，不调模型、不联网。每条用例跑前跑后都把全局注册面归零
（set_event_sink(None)/set_bus_approver(None)/ui_bus.shutdown()），防串味。
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import agent, jobs, permission, tools, ui_bus, viewport


def _fake_model_script(script):
    """按脚本逐次返回模型响应：{"content": ...} 或 {"content": ..., "tool_calls": [...]}。"""
    calls = {"n": 0}

    def model_fn(messages, tools=None):
        i = min(calls["n"], len(script) - 1)
        calls["n"] += 1
        return script[i]

    return model_fn


def _todos_turn_script():
    """一条带 update_todos 工具调用的轮次：先工具、后最终文本。"""
    return [
        {"role": "assistant", "content": "先记清单", "tool_calls": [
            {"id": "call-1", "type": "function",
             "function": {"name": "update_todos",
                          "arguments": json.dumps({"todos": [{"content": "写测试", "status": "in_progress"}]})}}]},
        {"role": "assistant", "content": "清单已更新，完成。"},
    ]


def _run_todos_turn(sink_events=None, use_bus=False, tmp=None):
    """跑一遍「update_todos 轮次」，返回 (final_text, history, ctx)。"""
    # 固定 S5 会话边界 token（agent._wrap_tool_data）：两遍跑 token 相同，history 才可逐字比对
    ctx = {"todos": [], "_session_boundary": "0123456789abcdef"}
    if use_bus:
        ui_bus.init(ctx, "sess-test", Path(tmp.name) if hasattr(tmp, "name") else tmp)
    history = []
    text = agent.run_once("帮我记个待办", history,
                          model_fn=_fake_model_script(_todos_turn_script()),
                          log_file=Path(tempfile.mkdtemp()) / "log.jsonl",
                          ctx=ctx)
    return text, history, ctx


class _Base(unittest.TestCase):
    def setUp(self):
        agent.set_event_sink(None)
        agent.set_bus_approver(None)
        ui_bus.shutdown()

    def tearDown(self):
        agent.set_event_sink(None)
        agent.set_bus_approver(None)
        ui_bus.shutdown()


class TestRunOnceHooks(_Base):
    """SPEC §6.1：message.append / tool_call.start / tool_call.end + dirty 标记 + 关闭即原行为。"""

    def test_sink_off_is_baseline_and_sink_on_observes(self):
        # ① 不注册 sink 跑一遍（原行为）
        text_off, hist_off, ctx_off = _run_todos_turn()
        self.assertNotIn("_ui_dirty", ctx_off)   # 无总线：mark_dirty 全 no-op，一行不多走
        self.assertEqual(agent._EVENT_SINK, None)

        # ② 注册 sink + 总线跑一遍
        events = []
        agent.set_event_sink(lambda t, p: events.append((t, p)))
        with tempfile.TemporaryDirectory() as tmp:
            text_on, hist_on, ctx_on = _run_todos_turn(use_bus=True, tmp=tmp)

        # ③ 两遍 history 角色序列与最终文本一致（钩子不改变任何既有行为）
        self.assertEqual([m["role"] for m in hist_off], [m["role"] for m in hist_on])
        self.assertEqual(text_off, text_on)
        self.assertEqual([m.get("content") for m in hist_off], [m.get("content") for m in hist_on])

        # ④ sink 版收到三类事件且载荷字段齐
        types = [t for t, _ in events]
        self.assertIn("message.append", types)
        self.assertIn("tool_call.start", types)
        self.assertIn("tool_call.end", types)

        appends = [p for t, p in events if t == "message.append"]
        self.assertEqual([m["role"] for m in appends], ["user", "assistant", "tool", "assistant"])
        self.assertEqual(appends[0]["content"], "帮我记个待办")
        self.assertIn("tool_calls", appends[1])          # assistant 浅拷含 tool_calls
        self.assertEqual(appends[2]["tool_call_id"], "call-1")

        start = next(p for t, p in events if t == "tool_call.start")
        self.assertEqual(start["call_id"], "call-1")
        self.assertEqual(start["name"], "update_todos")
        self.assertEqual(start["args"], {"todos": [{"content": "写测试", "status": "in_progress"}]})
        self.assertEqual(start["permission"], "allow")   # SAFE_TOOLS approve→allow 映射
        self.assertEqual(start["approval_key"], "update_todos")   # bare 指纹

        end = next(p for t, p in events if t == "tool_call.end")
        self.assertEqual(end["call_id"], "call-1")
        self.assertEqual(end["status"], "ok")
        self.assertIs(end["is_error"], False)
        self.assertIsInstance(end["duration_ms"], int)
        self.assertGreaterEqual(end["duration_ms"], 0)

        # ⑤ ctx['_ui_dirty'] 含 todos（update_todos 变更点 mark_dirty）
        self.assertIn("todos", ctx_on["_ui_dirty"])
        self.assertIn("stall", ctx_on["_ui_dirty"])      # D9：stall 分支打点
        self.assertEqual(ctx_on["_stall"]["limit"], agent.STALL_LIMIT)
        self.assertIn("count", ctx_on["_stall"])
        self.assertIn("at", ctx_on["_stall"])
        ui_bus.shutdown()

    def test_tool_call_denied_path_emits_start_end_denied(self):
        """未批准路径（ask + approver 拒）也要发 start(permission=ask)+end(status=denied)。"""
        events = []
        agent.set_event_sink(lambda t, p: events.append((t, p)))
        script = [
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "call-9", "type": "function",
                 "function": {"name": "run_command", "arguments": json.dumps({"command": "echo hi"})}}]},
            {"role": "assistant", "content": "被拒绝了"},
        ]
        ctx = {"todos": []}
        agent.run_once("跑个命令", [], model_fn=_fake_model_script(script),
                       approver=lambda n, a, r: False,
                       log_file=Path(tempfile.mkdtemp()) / "log.jsonl", ctx=ctx)
        start = next(p for t, p in events if t == "tool_call.start")
        end = next(p for t, p in events if t == "tool_call.end")
        self.assertEqual(start["permission"], "ask")
        self.assertEqual(start["approval_key"], "run_command:echo hi")
        self.assertTrue(start.get("reason"))
        self.assertEqual(end["status"], "denied")
        self.assertIs(end["is_error"], True)
        self.assertEqual(ctx["_denied_calls"], 1)


class TestApprovalKey(_Base):
    """R2 §1 指纹规则回归（path/command/bare 各一）。"""

    def test_path_command_bare(self):
        self.assertEqual(agent._approval_key("write_file", {"path": "sku清单.txt"}),
                         "write_file:sku清单.txt")
        self.assertEqual(agent._approval_key("run_command", {"command": "  git status  "}),
                         "run_command:git status")
        self.assertEqual(agent._approval_key("update_todos", {"todos": []}), "update_todos")


class TestCompactionEvent(_Base):
    """SPEC §3.2/D7：compaction.event 载荷走契约形状（kind/before/after/cleared/depth）。"""

    def test_payload_shape(self):
        events = []
        agent.set_event_sink(lambda t, p: events.append((t, p)))
        history = [{"role": "user", "content": "x" * 100},
                   {"role": "assistant", "content": "y" * 50}]
        log_file = Path(tempfile.mkdtemp()) / "log.jsonl"

        from harness import compaction
        chars = compaction.total_chars(history)
        # R1 depth-0 统一规则：depth=1（子 agent）→ sink 事件静默（JSONL 落盘仍带 depth，不受影响）
        done = agent._observe_compaction(history, lambda: True, "auto_compact", "测试触发",
                                         log_file, {"_subagent_depth": 1})
        self.assertTrue(done)
        self.assertEqual(events, [])
        # depth=0（主线）→ 正常发
        done = agent._observe_compaction(history, lambda: True, "auto_compact", "测试触发",
                                         log_file, {"_subagent_depth": 0})
        self.assertTrue(done)
        ev = next(p for t, p in events if t == "compaction.event")
        self.assertEqual(ev["kind"], "auto_compact")
        self.assertEqual(ev["before"], {"msgs": 2, "chars": chars})
        self.assertEqual(ev["after"], {"msgs": 2, "chars": chars})
        self.assertIsNone(ev["cleared"])      # 非 int 返回 → cleared 可空
        self.assertEqual(ev["depth"], 0)

        # clear_stale 类：action 返回 int → cleared 带上
        events.clear()
        done = agent._observe_compaction(history, lambda: 3, "tool_result_clearing", "清理",
                                         log_file, {})
        ev = next(p for t, p in events if t == "compaction.event")
        self.assertEqual(ev["cleared"], 3)
        # JSONL 落盘字段名不动（before_msgs/…），读取方兼容（R1 ⑦）
        line = json.loads(log_file.read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(line["role"], "system")
        self.assertEqual(line["event"], "compaction")
        self.assertIn("before_msgs", line)
        self.assertEqual(line["cleared"], 3)

        # action falsy → 不落记录也不发事件
        events.clear()
        done = agent._observe_compaction(history, lambda: None, "auto_compact", "r", log_file, {})
        self.assertFalse(done)
        self.assertEqual(events, [])


class TestBusApprover(_Base):
    """SPEC §6.2/§8.2：总线审批分支 + R2 §4 语义（tainted 时 always 不落白名单）。"""

    def test_bus_approver_branch_and_whitelist(self):
        seen = []

        def fake_bus(name, args, reason, force_ask=False, ctx=None):
            seen.append({"name": name, "args": args, "reason": reason,
                         "force_ask": force_ask, "ctx": ctx})
            return "always"

        ctx = {"_approved_tools": set()}
        agent.set_bus_approver(fake_bus)
        ok = agent._approved("update_todos", {"todos": []}, "测试原因",
                             lambda n, a, r: False, ctx)   # 既有 approver 恒拒——必须走总线分支
        self.assertTrue(ok)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["name"], "update_todos")
        self.assertEqual(seen[0]["args"], {"todos": []})
        self.assertEqual(seen[0]["reason"], "测试原因")
        self.assertIs(seen[0]["force_ask"], False)
        self.assertIs(seen[0]["ctx"], ctx)
        # 非污点 always → 落会话白名单（与既有 :203-205 逻辑一致）
        self.assertIn("update_todos", ctx["_approved_tools"])

    def test_tainted_always_does_not_whitelist(self):
        span = "不可信外部文本" * 5          # ≥32 字符整行才入污点
        ctx = {}
        permission.record_taint(ctx, span)
        agent.set_bus_approver(lambda name, args, reason, force_ask=False, ctx=None: "always")
        # run_command 属 _TAINT_HIGH_RISK，参数原样含污点 → tainted=True
        ok = agent._approved("run_command", {"command": f"echo {span}"}, "r",
                             lambda n, a, r: False, ctx)
        self.assertTrue(ok)   # tainted + always ≠ 拒绝：本次仍批准（R2 §4）
        key = agent._approval_key("run_command", {"command": f"echo {span}"})
        self.assertNotIn(key, ctx.get("_approved_tools", set()))   # 但不落白名单（防洗白）

    def test_unregistered_bus_approver_is_baseline(self):
        called = []
        ctx = {"_approved_tools": set()}
        ok = agent._approved("update_todos", {}, "r",
                             lambda n, a, r: called.append(n) or True, ctx)
        self.assertTrue(ok)
        self.assertEqual(called, ["update_todos"])   # 未注册总线：走既有 approver，一行不多走


class TestPickDiffRecord(_Base):
    """SPEC §6.3/D5：ctx['_pick_diff_last'] 五字段与 status 映射（轻量 mock，不真点击）。"""

    def test_status_mapping_and_fields(self):
        ctx = {}
        # Y1：ui_bus 未 init 时整条路径零副作用（红线 3）——init 后才记录
        tools._record_pick_diff(ctx, 100, 200, True, png0=None)
        self.assertNotIn("_pick_diff_last", ctx)
        with tempfile.TemporaryDirectory() as tmp:
            ui_bus.init(ctx, "sess-test", Path(tmp))
            # 无 session_id → 前后帧 ref 为 None（fail-soft）
            tools._record_pick_diff(ctx, 100, 200, True, png0=None)
        rec = ctx["_pick_diff_last"]
        self.assertEqual(set(rec), {"ratio", "status", "pair", "target", "at"})
        self.assertEqual(rec["status"], "effective")     # AX 差分有增减
        self.assertIsNone(rec["ratio"])
        self.assertEqual(rec["pair"], {"before_ref": None, "after_ref": None})
        self.assertEqual(rec["target"], {"no": None, "screen_cx": 100, "screen_cy": 200})

        tools._pd_stash_pixel(ctx, 0.5)                   # 像素链成功、ratio≥0.01
        tools._record_pick_diff(ctx, 1, 2, False)
        self.assertEqual(ctx["_pick_diff_last"]["status"], "effective")
        self.assertEqual(ctx["_pick_diff_last"]["ratio"], 0.5)

        tools._pd_stash_pixel(ctx, 0.0)                   # 都无变化
        tools._record_pick_diff(ctx, 1, 2, False)
        self.assertEqual(ctx["_pick_diff_last"]["status"], "suspected_noop")

        tools._pd_stash_pixel(ctx, None)                  # 像素链失败
        tools._record_pick_diff(ctx, 1, 2, False)
        self.assertEqual(ctx["_pick_diff_last"]["status"], "unknown")

        tools._record_pick_diff(ctx, 1, 2, None)          # 点击未发出
        self.assertEqual(ctx["_pick_diff_last"]["status"], "unknown")

        # changed=True 分支不得沿用上次像素陈值（陈 stash 被 pop 且忽略）
        tools._pd_stash_pixel(ctx, 0.9)
        tools._record_pick_diff(ctx, 1, 2, True)
        self.assertIsNone(ctx["_pick_diff_last"]["ratio"])

    def test_dirty_marked_when_bus_ready(self):
        ctx = {}
        with tempfile.TemporaryDirectory() as tmp:
            ui_bus.init(ctx, "sess-test", Path(tmp))
            tools._record_pick_diff(ctx, 1, 2, None)
            self.assertIn("pick_diff", ctx["_ui_dirty"])

    def test_pick_writes_target_no(self):
        """_pick 走 _do_click_at（mock 掉真点击）后补 target.no。"""
        ctx = {}
        with tempfile.TemporaryDirectory() as tmp:
            ui_bus.init(ctx, "sess-test", Path(tmp))   # Y1：init 后 _record_pick_diff 才记录
            reg = tools._viewport_registry(ctx)
            vp = viewport.new_viewport("v1", origin=(0, 0), scale=1.0, size=(800, 600),
                                       marks={1: {"no": 1, "label": "按钮", "screen_cx": 5,
                                                  "screen_cy": 6, "source": "uia"}})
            viewport.register(vp, reg)

            def fake_click(c, x, y, mark=None):
                tools._record_pick_diff(c, x, y, True)
                return "已在屏幕坐标 (5,6) 发出左键点击。界面变化 → 新增「x」"

            with mock.patch.object(tools, "_do_click_at", fake_click):
                out = tools._pick({"viewport_id": "v1", "mark_no": 1}, ctx)
        self.assertIn("1 号", out)
        self.assertEqual(ctx["_pick_diff_last"]["target"]["no"], 1)
        self.assertEqual(ctx["_pick_diff_last"]["target"]["screen_cx"], 5)


class TestSubagentRuns(_Base):
    """SPEC §6.5/D10：ctx['_subagent_runs'] 运行清单。"""

    def test_begin_end_and_cap(self):
        ctx = {}
        rec = tools._sa_runs_begin(ctx, "目标" * 300)
        self.assertEqual(len(ctx["_subagent_runs"]), 1)
        self.assertEqual(rec["status"], "running")
        self.assertEqual(len(rec["objective"]), 200)     # 截 200
        self.assertIsNone(rec["ref_id"])
        tools._sa_runs_end(ctx, rec, True, "摘要" * 300, ref_id="sa_1")
        self.assertEqual(rec["status"], "done")
        self.assertEqual(len(rec["summary"]), 200)
        self.assertEqual(rec["ref_id"], "sa_1")
        self.assertIn("ended_at", rec)
        tools._sa_runs_end(ctx, rec, False, "boom")
        self.assertEqual(rec["status"], "failed")
        # 上限 50
        for i in range(60):
            tools._sa_runs_begin(ctx, f"t{i}")
        self.assertEqual(len(ctx["_subagent_runs"]), 50)

    def test_spawn_parallel_populates_runs(self):
        ctx = {"todos": [], "_model_fn": _fake_model_script([{"content": "结论全文"}]),
               "_log_file": Path(tempfile.mkdtemp()) / "log.jsonl"}
        out = tools._spawn_parallel({"subtasks": ["子任务一", "子任务二"]}, ctx)
        self.assertIn("并行 2 个子任务", out)
        runs = ctx["_subagent_runs"]
        self.assertEqual(len(runs), 2)
        self.assertEqual({r["status"] for r in runs}, {"done"})
        self.assertTrue(all(r["ref_id"] for r in runs))            # sa_N 回填
        self.assertTrue(all(r["batch_id"] and r["batch_id"].startswith("b-") for r in runs))
        self.assertEqual(runs[0]["batch_id"], runs[1]["batch_id"])  # 同批共享批次号
        self.assertTrue(all(r["summary"] for r in runs))


class TestViewportRef(_Base):
    """SPEC §6.4/D6：look/zoom 建视口后 screenshot_ref/created_at 回写注册表 record。"""

    def test_look_writes_screenshot_ref(self):
        png = (b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)   # 假 PNG 字节：put_image 落盘不验内容
        ctx = {"todos": [], "session_id": "sess-vp-test",
               "_screencapture_runner": object(), "_ax_runner": object(),
               "_ocr_runner": object(), "_sips_runner": object(), "_screen_size_runner": object()}
        reg = tools._viewport_registry(ctx)
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch("harness.vision._sdir", lambda sid: Path(tmp) / sid), \
                mock.patch.object(tools.observe, "capture_screenshot", return_value=(png, "")), \
                mock.patch.object(tools.observe, "capture_ax", return_value=[]), \
                mock.patch.object(tools.observe, "element_table", return_value=[]), \
                mock.patch.object(tools, "_ocr_words_of_png",
                                  return_value=(False, "无 OCR", [])), \
                mock.patch.object(tools.vision, "_png_size", return_value=(800, 600)), \
                mock.patch.object(tools.platform_caps, "screen_logical_size", return_value=(800, 600)), \
                mock.patch.object(tools.viewport, "merge_marks",
                                  return_value=[{"label": "按钮", "box": (1, 2, 10, 10), "source": "uia"}]), \
                mock.patch.object(tools.vision, "downscale_to_max", side_effect=lambda d, **k: d):
            out = tools._look({}, ctx)
        self.assertIn("已建根视口 v1", out)
        self.assertTrue(reg["v1"]["screenshot_ref"].startswith("img-"))
        self.assertIn("created_at", reg["v1"])


class TestJobsUpdate(_Base):
    """SPEC §6.6：任务状态翻转处发 job.update（总线未 init 时零开销 no-op）。"""

    def test_flip_emits_job_update(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(jobs, "JOBS_DIR", Path(tmp) / "jobs"):
            # 未 init：翻转不抛、无事件（no-op）
            jid = jobs.start("exit 0", cwd=tmp)
            self.assertEqual(ui_bus.ring_buffer(), [])

            ctx = {}
            ui_bus.init(ctx, "sess-jobs", Path(tmp))
            q = ui_bus.subscribe()
            jid2 = jobs.start("exit 0", cwd=tmp)   # 启动翻转 running
            env = q.get(timeout=2)
            self.assertEqual(env["type"], "job.update")
            self.assertTrue(any(j["id"] == jid2 and j["status"] == "running"
                                for j in env["payload"]["jobs"]))
            # 等子进程结束 → status() 触发 _finalize → 终态翻转
            jobs._JOBS[jid2]["proc"].wait(timeout=10)
            st = jobs.status(jid2)
            self.assertEqual(st["status"], "done")
            seen = set()
            while True:
                env = q.get(timeout=2)
                seen.add(env["type"])
                if env["type"] == "job.update" and any(
                        j["id"] == jid2 and j["status"] == "done" for j in env["payload"]["jobs"]):
                    break
            jobs._JOBS.pop(jid, None)
            jobs._JOBS.pop(jid2, None)


if __name__ == "__main__":
    unittest.main()
