# Plan12 发布治理运行手册

本文件与 `release-governance.json`、商业 Beta 台账共同构成发布事实源。JSON 负责机器校验；本手册负责执行顺序。任何候选缺失外部证据都必须是 `hold`，不能以“本机测试通过”替代。

## 候选冻结顺序

1. 记录候选 ID、commit、版本号与生成时间；禁止复用其他候选的哈希。
2. 重跑本机自动证据，更新商业 Beta 台账中的 SHA-256。
3. 执行 Plan11 与 Plan12 校验；二者都只说明结构完整，不等同于放行。
4. 组装离线可验的候选包并执行离线 hash 校验。
5. 按台账补齐目标平台安装、观察、独立审查、迁移与 staging 回退演练。证据必须在仓库内、含 SHA-256。

```bash
python3 scripts/check_acceptance_evidence.py --output docs/evidence/g11-acceptance/report.json
python3 scripts/check_release_governance.py --output docs/evidence/g12-release-governance/report.json
python3 scripts/check_release_governance.py --strict-admission
python3 scripts/check_commercial_beta_readiness.py
```

最后两条仅在所有外部闸门真实通过时返回 0。

## 回退与停止

任一 `stop_conditions` 触发时：冻结新放量与迁移、保留日志和受影响候选、切换到最近验证的只读版本，并按 `rollback-playbook.md` 执行。禁止自动清理用户数据、自动 stash、reset 或 `git clean`。

## 迁移演练

一次可计入的演练必须验证：备份文件可打开、迁移全事务、旧格式在承诺窗口内可读、不可安全降级被明确拒绝、只读导出可用，以及回退后数据 hash/可读性一致。完成后把原始记录放入仓库，填写 `migration.drill` 的 `passed`、相对路径和 SHA-256；否则保持 `unverified`。
