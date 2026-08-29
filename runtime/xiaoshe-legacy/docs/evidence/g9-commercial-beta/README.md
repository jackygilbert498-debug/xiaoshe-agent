# G9 商业 Beta 准入预检

商业 Beta 的事实源是 `docs/release/commercial-beta-readiness.json`。执行：

```bash
python3 scripts/check_commercial_beta_readiness.py --allow-hold
```

不带 `--allow-hold` 时，只有全部门通过才返回 `0`；任何候选字段、证据文件、哈希、指标或外部观察缺失都返回 `2` 并保持 `hold`。

当前台账只绑定本机可复算的 G6 项目记忆、G7 资源卫生和 G8 冻结评测。它**不是**商业 Beta 候选：候选版本尚未绑定，P1/B0–B2 真实观察、目标平台签名安装、72h soak/故障恢复、独立安全隐私审查与 staging 回退演练仍必须由相应责任人产生证据。

生成实际候选时，先在 exact candidate commit 重跑自动证据并更新 SHA-256，再将每个外部门的 `status` 改为 `passed`、填入仓库内可审查的 `evidence_ref` 和该文件 SHA-256。仅填写状态或路径不会放行。
