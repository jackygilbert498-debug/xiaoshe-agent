# G3 Verification / Completion 证据

## 已覆盖

- `tests/test_verification_model.py`：argv、cwd、环境、网络枚举与 checksum。
- `tests/test_verification_discovery.py`、`tests/test_verification_trust.py`：候选不执行、精确批准、来源漂移失信。
- `tests/test_verification_runner.py`、`tests/test_evidence_redaction.py`：无 shell、最小环境、超时/取消、日志截断与脱敏。
- `tests/test_acceptance_coverage.py`、`tests/test_completion_policy.py`：逐条验收和纯函数 blocker。
- `tests/test_verification_api.py`：profile、执行、按需日志 artifact API。
- `tests/test_completion_loop.py`：Review → Verify → Success，以及失败回到 Review → 新 Repair Run。

## 当前边界

- Windows 子进程树与 UI 可复现性由交接设备执行；不在本机声称完成。
- 已知失败和模型 finding 的领域边界有单元测试；长期审计 UI 与真实浏览器 journey 仍需后续验收补强。
