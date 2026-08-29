import asyncio
import json
import os
import subprocess
import sys
import time
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from concurrent.futures import ThreadPoolExecutor

from harness import agent, compaction
from harness.kimi_client import KimiError
from harness.capabilities import CapabilityDescriptor, CapabilitySnapshot
from harness.context_budget import (
    ContextBudget,
    ContextBudgetError,
    ContextItem,
    allocate_context_budget,
    select_context,
)
from harness.runtime_factory import (
    current_runtime_session, route_runtime_call, runtime_session_scope,
)
from harness.runtime_session import (
    RuntimeIdentity, RuntimeOutcome, RuntimePolicySnapshot, RuntimeSession,
)


def _budget(history=80):
    remaining = 160 - 32 - 16 - 16 - 16 - history
    return ContextBudget(
        window_tokens=160,
        reserved_output_tokens=32,
        stable_prefix_tokens=16,
        active_task_tokens=16,
        evidence_tokens=16,
        history_tokens=history,
        remaining_tokens=remaining,
    )


def _runtime_fixture(*, session_id="session-a", entrypoint="cli", task_id=None, run_id=None):
    descriptor = CapabilityDescriptor(
        "extension", "plugin.example", "1.0", "task", True, True, True, True,
        (entrypoint,), (), (),
    )
    snapshot = CapabilitySnapshot(session_id, entrypoint, (descriptor,))
    policy = RuntimePolicySnapshot(
        "deepseek-v4-flash", "plan-1", "workspace", "collaborate", True,
        "proxy", True, False, {}, snapshot.catalog_digest,
    )
    runtime = RuntimeSession(
        RuntimeIdentity(session_id, entrypoint, task_id=task_id, run_id=run_id),
        policy, lambda _value: RuntimeOutcome("success"),
        capability_snapshot=snapshot,
    )
    return runtime, snapshot


class ContextBudgetContractTests(unittest.TestCase):
    def test_window_allocator_reserves_output_prefix_and_estimation_error(self):
        budget = allocate_context_budget(
            1_000, reserved_output_tokens=200, stable_prefix_tokens=100,
            estimation_error_tokens=100,
        )
        self.assertEqual(1_000, sum(getattr(budget, name)
                                   for name in budget.__dataclass_fields__ if name != "window_tokens"))
        self.assertGreaterEqual(budget.remaining_tokens, 100)
        self.assertEqual(200, budget.reserved_output_tokens)
        with self.assertRaises(ValueError):
            allocate_context_budget(1_000, reserved_output_tokens=True)

    def test_budget_rejects_negative_boolean_and_overcommitted_values(self):
        values = dict(
            window_tokens=100, reserved_output_tokens=20, stable_prefix_tokens=10,
            active_task_tokens=10, evidence_tokens=10, history_tokens=50,
            remaining_tokens=0,
        )
        for field, bad in (("window_tokens", -1), ("history_tokens", True)):
            broken = dict(values)
            broken[field] = bad
            with self.subTest(field=field), self.assertRaises(ValueError):
                ContextBudget(**broken)
        with self.assertRaises(ValueError):
            ContextBudget(**{**values, "history_tokens": 51})

    def test_protected_task_critical_items_survive_even_when_the_budget_overflows(self):
        kinds = (
            "active_task", "user_constraint", "permission_decision",
            "pending_approval", "recent_error", "tool_result", "evidence",
            "image_reference",
        )
        items = [ContextItem(
            f"src-{i}", kind,
            {"media_id": "img-1"} if kind == "image_reference" else "x",
            sequence=i,
        ) for i, kind in enumerate(kinds)]
        selection = select_context(items, _budget(history=1))
        self.assertEqual(tuple(item.source_id for item in items), selection.source_ids)
        self.assertGreater(selection.overflow_tokens, 0)
        self.assertTrue(selection.task_critical_preserved)

    def test_single_protected_item_is_never_truncated_and_fails_explicitly_if_over_window(self):
        content = "最新用户约束" * 100
        with self.assertRaises(ContextBudgetError) as caught:
            select_context([ContextItem("latest", "user_constraint", content)], _budget(history=1))
        self.assertEqual("protected_item_exceeds_context_window", caught.exception.code)
        self.assertIn("latest", caught.exception.source_ids)

    def test_only_completed_old_rounds_are_summarized_with_source_ids(self):
        items = [
            ContextItem("old-a", "history", "A" * 220, completed=True, sequence=1),
            ContextItem("old-b", "history", "B" * 220, completed=True, sequence=2),
            ContextItem("active", "history", "must stay exact", completed=False, sequence=3),
            ContextItem("latest", "user_constraint", "latest correction", sequence=4),
        ]
        selection = select_context(items, _budget(history=80))
        self.assertIn("active", selection.source_ids)
        self.assertIn("latest", selection.source_ids)
        summarized = {source for summary in selection.summaries for source in summary.source_ids}
        self.assertTrue(summarized.issubset({"old-a", "old-b"}))
        self.assertTrue(summarized)
        for summary in selection.summaries:
            self.assertNotIn("reasoning", summary.text.lower())
            self.assertNotIn("chain_of_thought", summary.text.lower())

    def test_selection_is_deterministic_and_deduplicates_system_content(self):
        items = [
            ContextItem("s2", "system", "same system", sequence=2),
            ContextItem("s1", "system", "same system", sequence=1),
            ContextItem("u", "user_constraint", "保留中文约束", sequence=3),
        ]
        first = select_context(items, _budget())
        second = select_context(list(reversed(items)), _budget())
        self.assertEqual(first, second)
        self.assertEqual(1, sum(item.kind == "system" for item in first.items))

    def test_malicious_nested_content_is_bounded_secret_safe_and_fast(self):
        cycle = {}
        cycle["self"] = cycle
        cycle["reasoning"] = "private chain"
        cycle["blob"] = [{"x": "y" * 50} for _ in range(20_000)]
        started = time.monotonic()
        result = select_context(
            [ContextItem("malicious", "history", cycle, completed=True)],
            _budget(),
        )
        self.assertLess(time.monotonic() - started, 1.0)
        rendered = repr(result)
        self.assertNotIn("private chain", rendered)
        self.assertLess(len(rendered), 20_000)

    def test_image_reference_keeps_safe_identity_and_purpose_not_local_path_or_binary(self):
        image = ContextItem(
            "image-7", "image_reference",
            {"media_id": "img-7", "purpose": "用户要求检查布局",
             "path": r"C:\\Users\\private\\secret.png", "bytes": b"secret"},
            sequence=7,
        )
        selected = select_context([image], _budget()).items[0]
        self.assertEqual({"media_id": "img-7", "purpose": "用户要求检查布局"}, selected.content)

        nested = ContextItem("image-8", "image_reference", {
            "attachment": {"id": "att-8", "path": r"C:\\private.png", "data": b"secret"},
            "usage": {"purpose": "比较界面", "mime_type": "image/png"},
        })
        nested_selected = select_context([nested], _budget()).items[0]
        self.assertEqual({"attachment_id": "att-8", "purpose": "比较界面",
                          "mime_type": "image/png"}, nested_selected.content)

        envelope = ContextItem("image-9", "image_reference", {
            "role": "user",
            "content": [{
                "type": "image_reference",
                "image": {"media_id": "img-9", "path": r"C:\private.png"},
                "purpose": "检查布局",
            }],
        })
        safe_envelope = select_context([envelope], _budget()).items[0].content
        self.assertEqual("user", safe_envelope["role"])
        self.assertIsInstance(safe_envelope["content"], list)
        self.assertEqual("image_reference", safe_envelope["content"][0]["type"])
        self.assertIn("img-9", repr(safe_envelope["content"]))
        self.assertNotIn("private.png", repr(safe_envelope))

        multi = ContextItem("image-multi", "image_reference", {
            "role": "user", "content": [
                {"type": "image_reference", "ref": "img-a"},
                {"type": "image_reference", "ref": "img-b"},
            ],
        })
        multi_content = select_context([multi], _budget()).items[0].content["content"]
        self.assertEqual(["img-a", "img-b"], [part["ref"] for part in multi_content])

    def test_compaction_view_only_summarizes_explicitly_completed_old_rounds(self):
        history = [
            {"role": "system", "content": "rules", "_source_id": "rules"},
            {"role": "assistant", "content": "old " + "x" * 400,
             "_source_id": "old", "_completed": True},
            {"role": "assistant", "content": "active",
             "_source_id": "active", "_completed": False},
            {"role": "user", "content": "latest", "_source_id": "latest"},
        ]
        roomy = ContextBudget(200, 32, 16, 16, 16, 120, 0)
        view, selection = compaction.prepare_budgeted_context(history, roomy)
        rendered = repr(view)
        self.assertIn("active", rendered)
        self.assertIn("latest", rendered)
        self.assertIn("old", rendered)
        self.assertNotIn("old " + "x" * 400, rendered)
        self.assertIn("old", {source for summary in selection.summaries for source in summary.source_ids})

    def test_real_history_never_infers_completion_from_position_and_large_correction_errors(self):
        history = [
            {"role": "user", "content": "old request", "_context_kind": "user_constraint"},
            {"role": "assistant", "content": "old answer", "_context_kind": "active_task"},
            {"role": "user", "content": "更正：" + "必须逐字保留" * 1000,
             "_context_kind": "user_constraint", "_completed": False},
        ]
        with self.assertRaises(ContextBudgetError) as caught:
            compaction.prepare_budgeted_context(history, _budget(history=1))
        self.assertEqual("protected_item_exceeds_context_window", caught.exception.code)

        roomy = ContextBudget(10_000, 100, 100, 4_000, 1_000, 4_000, 800)
        small_history = [
            {"role": "user", "content": "first", "_context_kind": "user_constraint"},
            {"role": "assistant", "content": "middle", "_context_kind": "active_task"},
            {"role": "user", "content": "correction", "_context_kind": "user_constraint"},
        ]
        _view, selection = compaction.prepare_budgeted_context(small_history, roomy)
        self.assertFalse(selection.summaries)
        self.assertTrue(all(not item.completed for item in selection.items))

    def test_budgeted_view_never_orphans_a_tool_result_from_its_assistant_call(self):
        history = [
            {"role": "user", "content": "original", "_source_id": "goal"},
            {"role": "assistant", "content": "", "_source_id": "call",
             "tool_calls": [{"id": "tc-1", "function": {"name": "read", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "tc-1", "content": "evidence",
             "_source_id": "result"},
            {"role": "user", "content": "latest", "_source_id": "latest"},
        ]
        view, _selection = compaction.prepare_budgeted_context(history, _budget(history=80))
        call_ids = {call["id"] for msg in view for call in msg.get("tool_calls", [])}
        result_ids = {msg["tool_call_id"] for msg in view if msg.get("role") == "tool"}
        self.assertEqual(result_ids, call_ids)

    def test_agent_flag_off_keeps_legacy_send_and_flag_on_uses_selected_view(self):
        history = [{"role": "user", "content": "hello"}]
        seen = []

        def model(messages, tools=None):
            seen.append(messages)
            return {"content": "ok"}

        with mock.patch.object(agent.notes, "wire", side_effect=lambda value, _ctx: value), \
             mock.patch.object(agent.vision, "wire", side_effect=lambda value, _ctx: value):
            agent._send(model, history, {}, None, [])
            self.assertIs(seen[-1], history)
            runtime, _ = _runtime_fixture()
            with runtime_session_scope(runtime), \
                 mock.patch.object(agent.calibrate, "effective_window", return_value=4_000):
                budget_ctx = {"_context_budget_enabled": True}
                bound_history = [agent._bind_context_message(history[0], budget_ctx)]
                agent._send(model, bound_history, budget_ctx, None, [])
        self.assertEqual("hello", seen[-1][-1]["content"])
        self.assertIsNot(seen[-1], history)

    def test_agent_environment_flag_is_explicit_and_invalid_values_fail_closed(self):
        with mock.patch.dict("os.environ", {"XIAOSHE_CONTEXT_BUDGET": "on"}):
            self.assertTrue(agent._context_budget_requested({}))
        with mock.patch.dict("os.environ", {"XIAOSHE_CONTEXT_BUDGET": "invalid"}):
            self.assertFalse(agent._context_budget_requested({}))
        self.assertFalse(agent._context_budget_requested({"_context_budget_enabled": False}))

    def test_duplicate_sources_and_cross_task_or_run_items_fail_closed(self):
        session, _snapshot = _runtime_fixture(task_id="task-a", run_id="run-a")
        duplicate = [ContextItem("dup", "history", "a"), ContextItem("dup", "history", "b")]
        with self.assertRaises(ContextBudgetError) as caught:
            select_context(duplicate, _budget(), session=session)
        self.assertEqual("duplicate_source_id", caught.exception.code)
        for item in (
            ContextItem("wrong-task", "evidence", "x", task_id="task-b"),
            ContextItem("wrong-run", "tool_result", "x", task_id="task-a", run_id="run-b"),
        ):
            with self.assertRaises(ContextBudgetError) as caught:
                select_context([item], _budget(), session=session)
            self.assertEqual("context_domain_mismatch", caught.exception.code)

    def test_summaries_are_chunked_with_complete_source_ids_and_fit_budget(self):
        items = [ContextItem(f"old-{i:03d}", "history", "fact " + "x" * 200,
                             completed=True, sequence=i) for i in range(80)]
        selection = select_context(items, _budget(history=60))
        self.assertLessEqual(selection.estimated_tokens,
                             _budget(history=60).active_task_tokens
                             + _budget(history=60).evidence_tokens
                             + _budget(history=60).history_tokens)
        for summary in selection.summaries:
            for source_id in summary.source_ids:
                self.assertIn(source_id, summary.text)
        represented = set(selection.source_ids)
        self.assertEqual(represented, {item.source_id for item in selection.items}
                         | {sid for summary in selection.summaries for sid in summary.source_ids})

    def test_hostile_top_level_and_unordered_sets_are_bounded_and_deterministic(self):
        with self.assertRaises(ValueError):
            select_context([ContextItem(str(i), "history", "x") for i in range(4097)], _budget())

        class BrokenMapping(dict):
            def items(self):
                raise RuntimeError("boom")

        first = select_context([ContextItem("set", "history", {"b", "a", "c"})], _budget())
        second = select_context([ContextItem("set", "history", {"c", "b", "a"})], _budget())
        self.assertEqual(first, second)
        with self.assertRaises(ContextBudgetError) as caught:
            select_context([ContextItem("broken", "active_task", BrokenMapping())], _budget())
        self.assertEqual("invalid_context_content", caught.exception.code)

        with self.assertRaises(ContextBudgetError) as caught:
            select_context([ContextItem("key-collision", "history", {1: "a", "1": "b"})], _budget())
        self.assertEqual("invalid_context_content", caught.exception.code)

        class HostileMapping(dict):
            def items(self):
                return [(object(), "value")]

        with self.assertRaises(ContextBudgetError) as caught:
            select_context([ContextItem("hostile-key", "history", HostileMapping())], _budget())
        self.assertEqual("invalid_context_content", caught.exception.code)

        class DuplicateKeyMapping(dict):
            def items(self):
                return [("same", "a"), ("same", "b")]

        with self.assertRaises(ContextBudgetError) as caught:
            select_context([ContextItem("duplicate-key", "history", DuplicateKeyMapping())], _budget())
        self.assertEqual("invalid_context_content", caught.exception.code)

        class SameRepr:
            def __init__(self, value): self.value = value
            def __repr__(self): return "same"

        with self.assertRaises(ContextBudgetError) as caught:
            select_context([ContextItem("complex-set", "history", {
                SameRepr("a"), SameRepr("b"),
            })], _budget())
        self.assertEqual("invalid_context_content", caught.exception.code)

        cycle = []
        cycle.append(cycle)
        with self.assertRaises(ContextBudgetError) as caught:
            select_context([ContextItem("protected-cycle", "active_task", cycle)], _budget())
        self.assertEqual("invalid_context_content", caught.exception.code)

    def test_flag_on_requires_live_runtime_boundary_and_rebuilds_for_window_change(self):
        ctx = {"_context_budget_enabled": True}
        with self.assertRaises(ContextBudgetError) as caught:
            agent._prepare_budgeted_send([{"role": "user", "content": "x"}], ctx)
        self.assertEqual("runtime_session_required", caught.exception.code)

        session, snapshot = _runtime_fixture()
        with mock.patch.object(agent, "_active_runtime_session", return_value=session), \
             mock.patch.object(agent.calibrate, "effective_window", side_effect=[1000, 2000]):
            history = [agent._bind_context_message({"role": "user", "content": "x"}, ctx)]
            agent._prepare_budgeted_send(history, ctx)
            first = ctx["_context_budget"]
            agent._prepare_budgeted_send(history, ctx)
            second = ctx["_context_budget"]
        self.assertEqual(snapshot, session.capability_snapshot)
        self.assertEqual(1000, first.window_tokens)
        self.assertEqual(2000, second.window_tokens)
        self.assertLessEqual(ctx["_stable_prefix_tokens"], second.stable_prefix_tokens)

    def test_runtime_boundary_is_nested_exception_safe_and_thread_isolated(self):
        outer, _ = _runtime_fixture(session_id="outer")
        inner, _ = _runtime_fixture(session_id="inner")

        class Factory:
            def __init__(self, value): self.value = value
            def create(self, *_args, **_kwargs): return self.value

        seen = []
        def inner_runner(_value):
            seen.append(current_runtime_session().identity.session_id)
            raise RuntimeError("stop")
        def outer_runner(_value):
            seen.append(current_runtime_session().identity.session_id)
            with self.assertRaises(RuntimeError):
                route_runtime_call(inner.identity, "", inner_runner, mode="shadow", factory=Factory(inner))
            seen.append(current_runtime_session().identity.session_id)
            return "ok"
        self.assertEqual("ok", route_runtime_call(
            outer.identity, "", outer_runner, mode="shadow", factory=Factory(outer)))
        self.assertEqual(["outer", "inner", "outer"], seen)
        self.assertIsNone(current_runtime_session())

        def worker(value):
            session, _ = _runtime_fixture(session_id=value)
            return route_runtime_call(session.identity, "", lambda _v: current_runtime_session().identity.session_id,
                                      mode="shadow", factory=Factory(session))
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(["a", "b", "c", "d"], list(pool.map(worker, "abcd")))
        self.assertIsNone(current_runtime_session())

    def test_runtime_boundary_is_async_task_isolated(self):
        first, _ = _runtime_fixture(session_id="async-a")
        second, _ = _runtime_fixture(session_id="async-b")

        async def probe(runtime, ready, release):
            with runtime_session_scope(runtime):
                ready.set()
                await release.wait()
                return current_runtime_session().identity.session_id

        async def exercise():
            first_ready, second_ready = asyncio.Event(), asyncio.Event()
            release = asyncio.Event()
            tasks = (
                asyncio.create_task(probe(first, first_ready, release)),
                asyncio.create_task(probe(second, second_ready, release)),
            )
            await first_ready.wait()
            await second_ready.wait()
            release.set()
            return await asyncio.gather(*tasks)

        self.assertEqual(["async-a", "async-b"], asyncio.run(exercise()))
        self.assertIsNone(current_runtime_session())

    def test_detached_async_task_cannot_retain_an_exited_runtime_binding(self):
        runtime, _ = _runtime_fixture(session_id="detached")

        async def exercise():
            release = asyncio.Event()
            async def detached():
                await release.wait()
                return current_runtime_session()
            with runtime_session_scope(runtime):
                task = asyncio.create_task(detached())
            release.set()
            return await task

        self.assertIsNone(asyncio.run(exercise()))

    def test_real_history_writes_are_bound_and_rejected_by_another_session(self):
        first, _ = _runtime_fixture(session_id="first", task_id="task-a", run_id="run-a")
        second, _ = _runtime_fixture(session_id="second", task_id="task-b", run_id="run-b")
        history = [{"role": "system", "content": "trusted startup rules"}]
        ctx = {"_context_budget_enabled": True}

        def model(_messages, tools=None):
            return {"content": "done"}

        with tempfile.TemporaryDirectory() as temp, \
             mock.patch.object(agent.calibrate, "effective_window", return_value=4_000), \
             runtime_session_scope(first):
            agent.run_once("first request", history, model_fn=model,
                           log_file=Path(temp) / "agent.jsonl", ctx=ctx)
        for message in history[1:]:
            self.assertEqual("first", message["_runtime_session_id"])
            self.assertEqual("task-a", message["_task_id"])
            self.assertEqual("run-a", message["_run_id"])
            self.assertIn("_context_kind", message)
            self.assertIs(type(message.get("_completed")), bool)

        with mock.patch.object(agent.calibrate, "effective_window", return_value=4_000), \
             runtime_session_scope(second), self.assertRaises(ContextBudgetError) as caught:
            agent.run_once("second request", history, model_fn=model,
                           log_file=Path(temp) / "agent.jsonl", ctx=ctx)
        self.assertEqual("context_domain_mismatch", caught.exception.code)

    def test_derived_source_id_hashes_only_canonical_sanitized_public_content(self):
        base = {"role": "user", "content": "same public", "_completed": False}
        variants = [
            {**base, "reasoning": "private-a", "api_key": "sk-private-a"},
            {**base, "reasoning": "private-b", "api_key": "sk-private-b"},
        ]
        ids = []
        for message in variants:
            _view, selection = compaction.prepare_budgeted_context([message], _budget())
            ids.append(selection.items[0].source_id)
            self.assertNotIn("private", repr(selection.items[0].content))
        self.assertEqual(ids[0], ids[1])

    def test_canonical_set_and_source_hash_are_stable_across_python_hash_seeds(self):
        code = (
            "from harness import compaction; "
            "from harness.context_budget import ContextBudget; "
            "b=ContextBudget(160,32,16,16,16,80,0); "
            "_,s=compaction.prepare_budgeted_context([{'role':'assistant','content':{'v':set(['中','a','b'])},'_completed':True}],b); "
            "print(s.items[0].source_id if s.items else s.summaries[0].source_ids[0])"
        )
        outputs = []
        for seed in ("1", "999"):
            env = dict(os.environ, PYTHONHASHSEED=seed)
            outputs.append(subprocess.check_output(
                [sys.executable, "-c", code], cwd=Path.cwd(), env=env, text=True,
            ).strip())
        self.assertEqual(outputs[0], outputs[1])

    def test_real_completion_boundary_marks_only_prior_assistant_and_tool_messages(self):
        runtime, _ = _runtime_fixture(session_id="rounds")
        ctx = {"_context_budget_enabled": True}
        history = []
        responses = iter(({"content": "first answer"}, {"content": "second answer"}))
        with tempfile.TemporaryDirectory() as temp, runtime_session_scope(runtime), \
             mock.patch.object(agent.calibrate, "effective_window", return_value=4_000):
            agent.run_once("original constraint", history, model_fn=lambda *_a, **_k: next(responses),
                           log_file=Path(temp) / "agent.jsonl", ctx=ctx)
            self.assertFalse(history[-1]["_completed"])
            agent.run_once("latest correction", history, model_fn=lambda *_a, **_k: next(responses),
                           log_file=Path(temp) / "agent.jsonl", ctx=ctx)
        self.assertFalse(history[0]["_completed"])
        self.assertEqual("user_constraint", history[0]["_context_kind"])
        self.assertTrue(history[1]["_completed"])
        self.assertEqual("history", history[1]["_context_kind"])
        self.assertFalse(history[2]["_completed"])
        self.assertEqual("user_constraint", history[2]["_context_kind"])

    def test_completion_boundary_never_relabels_protected_tool_evidence(self):
        runtime, _ = _runtime_fixture(session_id="protected-round")
        ctx = {"_context_budget_enabled": True}
        with runtime_session_scope(runtime):
            history = [
                agent._bind_context_message({"role": "user", "content": "goal"}, ctx,
                                            kind="user_constraint"),
                agent._bind_context_message({"role": "assistant", "content": "", "tool_calls": [{"id": "tc"}]},
                                            ctx, kind="tool_result"),
                agent._bind_context_message({"role": "tool", "tool_call_id": "tc", "content": "failed"},
                                            ctx, kind="recent_error"),
                agent._bind_context_message({"role": "system", "content": "proof"}, ctx,
                                            kind="evidence"),
                agent._bind_context_message({"role": "assistant", "content": "final"}, ctx,
                                            kind="active_task"),
            ]
            agent._close_previous_completed_round(history, ctx)
        self.assertEqual(
            ["user_constraint", "tool_result", "recent_error", "evidence", "history"],
            [message["_context_kind"] for message in history],
        )
        self.assertEqual([False, False, False, False, True],
                         [message["_completed"] for message in history])

    def test_flag_on_bypasses_every_legacy_destructive_compaction_path(self):
        runtime, _ = _runtime_fixture(session_id="selector-only")
        ctx = {"_context_budget_enabled": True, "_last_usage": {"prompt_tokens": 999999}}
        with tempfile.TemporaryDirectory() as temp, runtime_session_scope(runtime), \
             mock.patch.object(agent.calibrate, "effective_window", return_value=4_000), \
             mock.patch.object(agent.compaction, "clear_stale_tool_results") as clear, \
             mock.patch.object(agent.compaction, "maybe_compact") as compact, \
             mock.patch.object(agent.compaction, "emergency_truncate") as truncate:
            result = agent.run_once("keep exact", [], model_fn=lambda *_a, **_k: {"content": "ok"},
                                    log_file=Path(temp) / "agent.jsonl", ctx=ctx)
        self.assertEqual("ok", result)
        clear.assert_not_called()
        compact.assert_not_called()
        truncate.assert_not_called()

    def test_provider_overflow_rebudgets_without_mutating_history(self):
        runtime, _ = _runtime_fixture(session_id="overflow")
        ctx = {"_context_budget_enabled": True}
        history = []
        calls = 0

        def model(_messages, tools=None):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise KimiError("token limit: 16384 (requested: 20000)")
            return {"content": "ok"}

        with tempfile.TemporaryDirectory() as temp, runtime_session_scope(runtime), \
             mock.patch.object(agent.calibrate, "effective_window", side_effect=lambda state: state.get("_context_window", 32_000)), \
             mock.patch.object(agent.calibrate, "learn_window", side_effect=lambda window, requested, state: state.__setitem__("_context_window", window)), \
             mock.patch.object(agent.compaction, "maybe_compact") as compact, \
             mock.patch.object(agent.compaction, "emergency_truncate") as truncate:
            result = agent.run_once("exact constraint", history, model_fn=model,
                                    log_file=Path(temp) / "agent.jsonl", ctx=ctx)
        self.assertEqual("ok", result)
        self.assertEqual(2, calls)
        self.assertEqual("exact constraint", history[0]["content"])
        compact.assert_not_called()
        truncate.assert_not_called()

    def test_unbound_non_system_history_fails_closed_but_startup_system_is_allowed(self):
        runtime, _ = _runtime_fixture(session_id="bound")
        compaction.prepare_budgeted_context(
            [{"role": "system", "content": "trusted startup rules"}],
            _budget(), session=runtime,
        )
        with self.assertRaises(ContextBudgetError) as caught:
            compaction.prepare_budgeted_context(
                [{"role": "user", "content": "unbound old request"}],
                _budget(), session=runtime,
            )
        self.assertEqual("unbound_context_item", caught.exception.code)

    def test_budget_flag_binds_sealed_session_for_every_real_entrypoint(self):
        class Factory:
            def __init__(self, value): self.value = value
            def create(self, *_args, **_kwargs): return self.value

        for entrypoint in ("gui", "cli", "headless"):
            runtime, snapshot = _runtime_fixture(
                session_id="session-" + entrypoint, entrypoint=entrypoint,
            )
            observed = route_runtime_call(
                runtime.identity,
                "value",
                lambda _value: (
                    current_runtime_session().identity.entrypoint,
                    current_runtime_session().capability_snapshot,
                ),
                mode="off",
                ctx={"_context_budget_enabled": True},
                factory=Factory(runtime),
            )
            self.assertEqual((entrypoint, snapshot), observed)
            self.assertIsNone(current_runtime_session())

        self.assertIsNone(route_runtime_call(
            RuntimeIdentity("legacy", "cli"), "value",
            lambda _value: current_runtime_session(), mode="off",
            ctx={"_context_budget_enabled": False},
        ))

    def test_request_flag_is_distinct_from_factory_facts_and_env_drives_cli_headless(self):
        class Factory:
            def __init__(self, value): self.value = value; self.calls = 0
            def create(self, *_args, **_kwargs): self.calls += 1; return self.value

        gui, _ = _runtime_fixture(session_id="gui-explicit", entrypoint="gui")
        gui_factory = Factory(gui)
        observed = route_runtime_call(
            gui.identity, "value", lambda _value: current_runtime_session(),
            mode="off", ctx={"policy_snapshot": {}},
            request_ctx={"_context_budget_enabled": True}, factory=gui_factory,
        )
        self.assertIs(gui, observed)
        self.assertEqual(1, gui_factory.calls)

        for entrypoint in ("cli", "headless"):
            runtime, _ = _runtime_fixture(session_id="env-" + entrypoint, entrypoint=entrypoint)
            factory = Factory(runtime)
            with mock.patch.dict("os.environ", {"XIAOSHE_CONTEXT_BUDGET": "on"}):
                observed = route_runtime_call(
                    runtime.identity, "value", lambda _value: current_runtime_session(),
                    mode="off", ctx={"policy_snapshot": {}}, factory=factory,
                )
            self.assertIs(runtime, observed)
            self.assertEqual(1, factory.calls)

        off, _ = _runtime_fixture(session_id="off", entrypoint="gui")
        off_factory = Factory(off)
        self.assertIsNone(route_runtime_call(
            off.identity, "value", lambda _value: current_runtime_session(),
            mode="off", ctx={"policy_snapshot": {}},
            request_ctx={"_context_budget_enabled": False}, factory=off_factory,
        ))
        self.assertEqual(0, off_factory.calls)

    def test_summary_source_ids_use_unambiguous_canonical_json(self):
        items = [
            ContextItem("a,b", "history", "x" * 500, completed=True, sequence=1),
            ContextItem("c", "history", "y" * 500, completed=True, sequence=2),
            ContextItem("latest", "user_constraint", "z", sequence=3),
        ]
        selection = select_context(items, _budget(history=80))
        self.assertTrue(selection.summaries)
        encoded = json.dumps(["a,b", "c"], ensure_ascii=False, separators=(",", ":"))
        self.assertIn(encoded, selection.summaries[0].text)
        self.assertNotIn("source_ids=a,b,c", selection.summaries[0].text)


if __name__ == "__main__":
    unittest.main()
