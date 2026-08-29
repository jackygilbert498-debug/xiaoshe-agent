# Plan 01 完成审计

审计日期：2026-08-03。此文件只陈述当前工作树已验证的事实；Windows 原生门未执行前，不把计划 01 标成全平台完成。

| 计划项 | 当前状态 | 直接证据 |
| --- | --- | --- |
| G0 基线与 UTF-8 | 已验证 | `tests.test_tasking_baseline`；`docs/baselines/tasking-g0.json`；`validate_tasking_baseline.py --check-current` |
| Task/Run 领域与错误形状 | 已验证 | `tests.test_task_model`；`harness/task_model.py` |
| SQLite/WAL/FK/迁移/并发 | 已验证 | `tests.test_task_store`：v1→v3 备份迁移、WAL/FK、20 并发创建、事件失败回滚、Windows 路径规范 |
| 状态机与证据完成门 | 已验证 | `tests.test_task_engine`：闭集、50 轮竞态、验收闸、Verifying→Succeeded 的 evidence token |
| Run 与旧 Agent 兼容 | 已验证 | `tests.test_task_run_adapter`、`tests.test_effects*`、`tests.test_task_session_metadata` |
| 旧 Session 惰性导入 | 已验证 | `tests.test_session_import`：源文件字节/mtime 不变、20 并发只建一个 Task |
| v2 API 与 REST/WS 收敛 | 已验证 | `tests.test_task_api`：真实 localhost、ETag/409、seq 补拉、同一 serializer、并发导入只广播一次 |
| 收件箱与窄屏入口 | 已验证 | `tests/tasking_store.test.mjs`；macOS Chromium：新建/导入无 reload、12 状态计数、390px “任务”入口 |
| off/on/shadow 与失败降级 | 已验证 | `tests.test_tasking_feature_flag`：off/shadow 不开库；不可写账本回退旧会话 |
| Windows 原生复现 | 待 Windows 机器 | `scripts/verify_windows.ps1`；必须收集 PowerShell 原始输出与退出码 |

## 本机回归门

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/miniconda3/bin/python3.13 -X utf8 -W error::ResourceWarning \
  -m unittest tests.test_tasking_baseline tests.test_task_model tests.test_task_store \
  tests.test_task_engine tests.test_task_run_adapter tests.test_task_session_metadata \
  tests.test_session_import tests.test_task_api tests.test_tasking_feature_flag \
  tests.test_rounds_boundary tests.test_effects tests.test_effects_irreversible -q
node --test tests/tasking_store.test.mjs
PYTHONDONTWRITEBYTECODE=1 /opt/miniconda3/bin/python3.13 -X utf8 tests/ui_contract/validate_contract.py
PYTHONDONTWRITEBYTECODE=1 /opt/miniconda3/bin/python3.13 -X utf8 scripts/smoke_serve.py
```

## Windows 关闭门

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify_windows.ps1
```

若该命令为 0 且原始日志留存，计划 01 的最后平台门才可关闭。
