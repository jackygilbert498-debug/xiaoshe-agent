# G12 · 风险、回退与发布治理证据

运行：

```bash
python3 scripts/check_release_governance.py --output docs/evidence/g12-release-governance/report.json
python3 scripts/check_release_governance.py --strict-admission
```

前者检查治理结构，后者是准入门。当前外部观察、独立审查与 staging/迁移演练尚未真实完成，因此报告应为结构通过但 `action: hold`；这是正确的 fail-closed 结果。
