# -*- coding: utf-8 -*-
"""非流式 _post 连接阶段失败重试（D3 实测：代理间歇 TLS 握手失败 curl exit 35 直接掐死 headless 任务）。

口径：只重试『请求确定未到达服务端』的连接阶段失败（exit 6 DNS / 7 连不上 / 35 TLS 握手）；
56（接收中断，服务端可能已生成）、28（max-time 失速）、硬超时、HTTP 应用层错误一律原路径不重试。
sleep 经参数注入，测试不真睡。
"""
import subprocess
import unittest
from unittest import mock

from harness import kimi_client


_OK_BODY = '{"choices":[{"message":{"content":"hi"}}]}'
_OVERFLOW_BODY = '{"error":{"message":"context size exceeded","type":"invalid_request_error"}}'


def _proc(returncode=0, stdout="", stderr=""):
    p = mock.Mock()
    p.returncode = returncode
    p.stdout = stdout
    p.stderr = stderr
    return p


def _cfg():
    cfg = mock.Mock()
    cfg.API_KEY = "k"
    cfg.BASE_URL = "https://api.kimi.com/v1"
    cfg.ENV_PATH = ".env"
    cfg.CURL = "curl"
    return cfg


def _post_with(procs, sleep=None):
    """跑一次 _post：subprocess.run 按 procs side_effect；sleep 注入 mock。返回 (result, run, warn, sleep)。"""
    sleep = sleep or mock.Mock()
    with mock.patch.object(kimi_client, "config", _cfg()), \
         mock.patch.object(kimi_client.subprocess, "run", side_effect=procs) as run, \
         mock.patch.object(kimi_client._io, "warn") as warn:
        result = kimi_client._post({"model": "m", "messages": []}, timeout=90, retry=5, _sleep=sleep)
    return result, run, warn, sleep


class TestConnectRetry(unittest.TestCase):
    def test_handshake_35_retried_then_success(self):
        raw, run, warn, sleep = _post_with([_proc(35, stderr="schannel handshake fail"),
                                            _proc(0, stdout=_OK_BODY)])
        self.assertEqual(raw["choices"][0]["message"]["content"], "hi")
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(1.0)          # 首次重试间隔
        self.assertEqual(warn.call_count, 1)         # 可观测：重试不静默
        self.assertIn("35", warn.call_args[0][0])

    def test_dns_6_and_refused_7_also_retried(self):
        for rc in (6, 7):
            sleep = mock.Mock()
            raw, run, _, _ = _post_with([_proc(rc), _proc(0, stdout=_OK_BODY)], sleep=sleep)
            self.assertEqual(raw["choices"][0]["message"]["content"], "hi", f"exit {rc}")
            self.assertEqual(run.call_count, 2, f"exit {rc}")

    def test_retries_exhausted_raises(self):
        # 重试次数跟 _POST_CONNECT_RETRIES 常量走：共 N+1 次尝试；间隔递增 1s → N s
        n = kimi_client._POST_CONNECT_RETRIES
        sleep = mock.Mock()
        with mock.patch.object(kimi_client, "config", _cfg()), \
             mock.patch.object(kimi_client.subprocess, "run",
                               side_effect=[_proc(35, stderr="e")] * (n + 1)) as run, \
             mock.patch.object(kimi_client._io, "warn") as warn:
            with self.assertRaises(kimi_client.KimiError) as cm:
                kimi_client._post({"model": "m", "messages": []}, timeout=90, retry=5, _sleep=sleep)
        self.assertIn("exit 35", str(cm.exception))
        self.assertEqual(run.call_count, n + 1)
        self.assertEqual([c.args[0] for c in sleep.call_args_list],
                         [min(1.0 * i, kimi_client._POST_RETRY_MAX_SLEEP) for i in range(1, n + 1)])
        self.assertEqual(warn.call_count, n)

    def test_retry_count_constant_is_calibration_knob(self):
        """重试次数抽常量：调大常量即放宽，不必改代码。"""
        with mock.patch.object(kimi_client, "_POST_CONNECT_RETRIES", 3):
            sleep = mock.Mock()
            raw, run, _, _ = _post_with([_proc(35)] * 3 + [_proc(0, stdout=_OK_BODY)], sleep=sleep)
            self.assertEqual(raw["choices"][0]["message"]["content"], "hi")
            self.assertEqual(run.call_count, 4)


class TestNoRetrySemantics(unittest.TestCase):
    """红队：副作用不放大——以下场景绝不重试。"""

    def test_recv_error_56_not_retried(self):
        """56=接收中断：响应可能已开始（服务端或已生成计费 completion），重发会重复生成。"""
        sleep = mock.Mock()
        with mock.patch.object(kimi_client, "config", _cfg()), \
             mock.patch.object(kimi_client.subprocess, "run",
                               side_effect=[_proc(56, stderr="recv fail")]) as run, \
             mock.patch.object(kimi_client._io, "warn") as warn:
            with self.assertRaises(kimi_client.KimiError):
                kimi_client._post({"model": "m", "messages": []}, timeout=90, retry=5, _sleep=sleep)
        self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()
        warn.assert_not_called()

    def test_stall_28_not_retried(self):
        """28=max-time 失速：下落不明（可能生成完回包途中断），与流式 _STALL_EXIT 同口径，不重试。"""
        sleep = mock.Mock()
        with mock.patch.object(kimi_client, "config", _cfg()), \
             mock.patch.object(kimi_client.subprocess, "run", side_effect=[_proc(28)]) as run, \
             mock.patch.object(kimi_client._io, "warn"):
            with self.assertRaises(kimi_client.KimiError):
                kimi_client._post({"model": "m", "messages": []}, timeout=90, retry=5, _sleep=sleep)
        self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()

    def test_hard_timeout_not_retried(self):
        """Python 侧硬超时（curl 被杀）：请求已发出下落不明，绝不重发。"""
        sleep = mock.Mock()
        with mock.patch.object(kimi_client, "config", _cfg()), \
             mock.patch.object(kimi_client.subprocess, "run",
                               side_effect=subprocess.TimeoutExpired(cmd="curl", timeout=210)) as run, \
             mock.patch.object(kimi_client._io, "warn"):
            with self.assertRaises(kimi_client.KimiError) as cm:
                kimi_client._post({"model": "m", "messages": []}, timeout=90, retry=5, _sleep=sleep)
        self.assertIn("超时", str(cm.exception))
        self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()

    def test_http_400_overflow_passthrough(self):
        """HTTP 400 溢出（curl exit 0 + error body）：走原路径附结构化 error，供溢出校准重试网，绝不重试。"""
        sleep = mock.Mock()
        with mock.patch.object(kimi_client, "config", _cfg()), \
             mock.patch.object(kimi_client.subprocess, "run",
                               side_effect=[_proc(0, stdout=_OVERFLOW_BODY)]) as run, \
             mock.patch.object(kimi_client._io, "warn") as warn:
            with self.assertRaises(kimi_client.KimiError) as cm:
                kimi_client._post({"model": "m", "messages": []}, timeout=90, retry=5, _sleep=sleep)
        self.assertEqual(cm.exception.error, {"message": "context size exceeded",
                                              "type": "invalid_request_error"})
        self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()
        warn.assert_not_called()


class TestRedTeam(unittest.TestCase):
    def test_sleep_interval_capped(self):
        """间隔有上限：调大基数常量也撞 cap，退避不失控。"""
        with mock.patch.object(kimi_client, "_POST_RETRY_BASE_SLEEP", 100.0):
            sleep = mock.Mock()
            with self.assertRaises(kimi_client.KimiError):
                _post_with([_proc(35)] * (kimi_client._POST_CONNECT_RETRIES + 1), sleep=sleep)
            for c in sleep.call_args_list:
                self.assertLessEqual(c.args[0], kimi_client._POST_RETRY_MAX_SLEEP)

    def test_keyboard_interrupt_during_backoff_propagates(self):
        """退避 sleep 中按 Ctrl+C：KeyboardInterrupt 直接穿出，不被重试网吞掉。"""
        sleep = mock.Mock(side_effect=KeyboardInterrupt)
        with mock.patch.object(kimi_client, "config", _cfg()), \
             mock.patch.object(kimi_client.subprocess, "run", side_effect=[_proc(35)]) as run, \
             mock.patch.object(kimi_client._io, "warn"):
            with self.assertRaises(KeyboardInterrupt):
                kimi_client._post({"model": "m", "messages": []}, timeout=90, retry=5, _sleep=sleep)
        self.assertEqual(run.call_count, 1)

    def test_keyboard_interrupt_during_run_propagates(self):
        """curl 执行中按 Ctrl+C：原样传播，不重试。"""
        sleep = mock.Mock()
        with mock.patch.object(kimi_client, "config", _cfg()), \
             mock.patch.object(kimi_client.subprocess, "run", side_effect=KeyboardInterrupt) as run, \
             mock.patch.object(kimi_client._io, "warn"):
            with self.assertRaises(KeyboardInterrupt):
                kimi_client._post({"model": "m", "messages": []}, timeout=90, retry=5, _sleep=sleep)
        self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
