# G2 · Plan 控制面验收入口

本目录记录 Plan 02 的可复现验收入口。所有场景使用临时 SQLite 数据库与本地假模型，不访问网络、用户目录或真实模型额度。

## 已覆盖路径

| 场景 | 自动化证据 |
| --- | --- |
| 只读快速通道 | `tests.test_plan_gate.PlanGateTests.test_simple_read_only_request_can_start_without_plan` |
| 首个变异动作必须有计划 | `tests.test_plan_gate.PlanGateTests.test_mutation_is_blocked_before_permission_or_dispatch` |
| 退回、编辑并批准 | `tests.test_plan_store` |
| 计划批准不放宽权限 | `tests.test_run_policy` |
| 计划外文件偏离 | `tests.test_run_policy` |
| Question/Answer 恢复同一 Run | `tests.test_task_questions` |
| Stop/Steer 安全边界 | `tests.test_run_control` |
| REST 控制面协议 | `tests.test_task_api` |

## 一键回归

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/miniconda3/bin/python3.13 -X utf8 -m unittest \
  tests.test_plan_model tests.test_plan_store tests.test_plan_gate tests.test_run_policy \
  tests.test_run_control tests.test_task_questions tests.test_task_engine \
  tests.test_task_run_adapter tests.test_task_api tests.test_task_store -q
node --test tests/tasking_store.test.mjs
/opt/miniconda3/bin/python3.13 -X utf8 tests/ui_contract/validate_contract.py
git diff --check
```

通过判据：所有 Python 测试、前端状态测试和 UI 契约校验通过；`git diff --check` 无空白错误。

## 人工界面核查

启用 `XIAOSHE_TASKING_V2=on` 后，在任务详情确认：

1. “计划”弹窗可提交、批准或带反馈拒绝计划；冲突时未提交编辑文本保留在表单中。
2. `WaitingUser` 显示“回答问题”，选项按钮恢复原 Run。
3. 活跃 Run 显示“插话”和“安全停止”；停止文案为“正在安全停止”，而不是提前标记已完成。
