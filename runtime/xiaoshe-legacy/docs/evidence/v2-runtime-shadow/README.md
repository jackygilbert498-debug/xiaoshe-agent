# RuntimeSession V1 shadow gate

本目录保存 Plan 09 的统一运行时对照证据。产品默认保持
`XIAOSHE_RUNTIME_SESSION=shadow`；`on` 只用于受控测试，不作为日常运行档。

## 对照内容

报告器以确定性的 pairwise 组合覆盖 GUI、CLI、Headless、Worker、沙箱、网络、
心跳、权限档和 Task 绑定状态。每个组合的 `off` 与 `shadow` 都调用生产代码使用的
命名适配边界，并分别维护独立可变状态；核对 history、Task 状态、审批、工具调用和
UI payload 的完整结果。Schedule 的 Task 绑定模式只写幂等队列事实，不启动另一套
RuntimeSession 或无头子进程。

shadow 回执必须满足精确字段协议；敏感扫描同时覆盖所有内存回执和最终报告，任何多余
字段、凭据样式或 Windows 绝对路径都会令门变为 `hold`。本地默认回执日志限制为
1 MiB，并只保留 3 个轮转备份，避免无限累积会话标识。

运行：

```powershell
py -3 -X utf8 scripts/check_runtime_shadow.py --output docs/evidence/v2-runtime-shadow/report.json
```

`mismatch_count` 必须为 0，`sensitive_scan.status` 必须为 `pass`；否则
`gate_status=hold` 且命令返回非零。治理和回退约束见
`docs/release/plan09-runtime-session-governance.json`。
