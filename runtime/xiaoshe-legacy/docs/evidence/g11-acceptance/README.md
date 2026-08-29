# G11 测试、评测与验收证据

执行：

```bash
python3 scripts/check_acceptance_evidence.py --output docs/evidence/g11-acceptance/report.json
python3 scripts/check_acceptance_evidence.py --strict-admission
```

第一条命令校验 Plan11 的冻结资产和已落盘自动证据，成功不代表发布准入；第二条仅在 G0–G8 都带有符合最低等级的真实证据时返回 0。当前报告的 `integrity_pass: true` 与 `action: hold` 是预期的诚实状态：它证明台账没有漂移，但不会把 E2 的离线报告冒充为 E3 真浏览器、E4 真实模型任务或 E5 长期观察。

任何新证据必须先保存到仓库、写入 SHA-256、声明等级和可验证条件；只有阶段的 evidence IDs 均有效且等级足够，才可将该阶段从 `unverified`/`partial` 更新为 `local_passed` 或 `passed`。
