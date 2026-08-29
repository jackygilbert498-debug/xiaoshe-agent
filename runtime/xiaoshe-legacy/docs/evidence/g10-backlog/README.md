# G10 工程 Backlog 与依赖图证据

Plan10 的需求事实源为 `小蛇完善方案/10-完整工程Backlog与依赖图.md`，状态不写回 Markdown 表格，而由 `docs/backlog/engineering-backlog-status.json` 管理。

执行：

```bash
python3 scripts/check_engineering_backlog.py --output docs/evidence/g10-backlog/report.json
```

校验项包括：稳定 ID 唯一性、总数、压缩/范围依赖展开、无依赖环、实施计划引用、源文件 SHA-256，以及完成状态的证据路径和 SHA-256。当前报告将 126 项保持为 `planned`，这表示尚未按逐项证据审计；它不否定此前各实施计划已完成的局部代码工作，也不会把那些工作自动宣告为 Backlog 全部完成。

未来要关闭一项时，只能在 `overrides` 写入 `completed` 并附上仓库内可审的 `path`/`sha256` 证据；源需求、证据或依赖任一变化都会使校验失败，直到重新审计。
