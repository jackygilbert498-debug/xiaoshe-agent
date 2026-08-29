# Beta 候选发布清单

此清单只允许在**已冻结的候选 commit**上执行。`hold` 是正常安全结果，不得用修改状态字段或复用旧报告绕过。

## A. 冻结与自动证据

1. 记录候选 ID、commit、版本号、生成时间；写入 `docs/release/commercial-beta-readiness.json` 的 `candidate`。四项任何一项为 `UNSET` 就不得进入组包。
2. 在候选 commit 重跑严格测试、资源门、冻结评测与 Plan11/Plan12 校验，更新台账中的证据 SHA-256。不要复用其他候选的报告。
3. 执行：

   ```bash
   python3 scripts/check_acceptance_evidence.py --output docs/evidence/g11-acceptance/report.json
   python3 scripts/check_release_governance.py --output docs/evidence/g12-release-governance/report.json
   python3 scripts/check_commercial_beta_readiness.py --allow-hold
   ```

   前两条的结构通过不等同于发布通过；第三条仅用于查看缺口。

## B. 不可替代的外部门

4. 将下列原始证据放入仓库内并填相对路径与 SHA-256：P1 的 14 天/30 Task 观察、B0–B2 cohort 观察、同一发行包的 Windows 与 macOS 安装/签名记录、72 小时 soak/故障恢复、独立安全隐私审查、staging 回退演练。
5. 在隔离环境完成迁移演练：备份可打开、迁移事务失败可回退、旧格式兼容、不可安全降级会被阻止、只读导出可用。仅这六项均有证据时，将 `release-governance.json` 的 `migration.drill` 置为 `passed`。

## C. 组包与最终门

6. 用 `assemble_release.py` 组装候选；缺任何必需证据必须 `hold`。
7. 用 `verify_release.py --offline` 验证 manifest 中每个 hash。
8. 执行下列严格门；两条都返回 0 才可发布：

   ```bash
   python3 scripts/check_release_governance.py --strict-admission
   python3 scripts/check_commercial_beta_readiness.py
   ```

9. 发布后继续保留候选、manifest、原始证据和回退包；任何停止施工条件触发都按 `rollback-playbook.md` 执行，不能先清理证据再排查。
