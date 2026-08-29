# 旧能力迁移账本

## 结论

旧小蛇不是一个可以整体搬回来的“功能包”，而是同时拥有 Agent Runtime、会话、审批、任务、工具、桌面 Provider 和独立 UI 的完整产品。当前架构只保留一个所有者：DSH 负责 Agent/runtime/session/model/approval/task/workflow，XS 负责外部桌面 Bundle。**不迁移第二套 Agent Runtime**，也不让旧 UI、旧会话库或运行时自写工具重新取得所有权。

本轮从公开注册面而非文件名猜测能力：38 个模型工具、9 个 CLI/触发入口，以及 18 个跨模块用户能力，共 65 项。机器可读逐项账本在 `docs/evidence/2026-08-22-legacy-capability-inventory.json`，生成器和完整性门禁分别为 `scripts/audit-legacy-capabilities.mjs`、`tests/legacy-capability-ledger.test.ts`。

## 分类结果

| 分类 | 数量 | 决策含义 |
|---|---:|---|
| DSH 已提供 | 42 | 复用共享 Runtime，不迁移旧实现 |
| XS 已提供 | 13 | 已由当前 Bundle/Provider 接管并有门禁 |
| 应迁移 | 0 | 当前 Windows 可验证且适合统一架构的条目已清零 |
| 暂留 Provider | 5 | 仍有价值，但原生替代尚未达到同等安全契约 |
| 淘汰 | 4 | 与统一所有权冲突或被更安全入口替代 |
| 外部阻塞 | 1 | 当前设备缺少第二显示器，不能伪造验收 |

## 第一迁移波次

| 能力 | 当前缺口 | 迁移目标 | Windows 验收 |
|---|---|---|---|
| `cli.doctor` / `product.provider-doctor` | 已迁移 | `诊断小蛇-Windows.ps1` / `xiaoshe-doctor` | 当前 Profile 报告 ready=true、0 fail、1 个 Developer Mode 警告 |
| `product.old-s-cli` | 已迁移 | 用户 PATH 中的 `s.cmd` 与根目录可见的 Windows `.cmd` 薄包装到统一启动/停止/诊断入口，继续使用共享 DSH Profile | 普通 Windows PowerShell 5.1 现场完成诊断、启动复用和停止，退出码 0；未启动旧 Python Agent |
| `tool.list_windows` | 已迁移 | `screen_list_windows` 只读工具 | 只返回顶层标题与临时 ID；重复标题排除，不读取正文 |
| `tool.focus_window` | 已迁移 | `screen_focus_window` 动作工具 | 临时 ID + 完全一致标题 + 唯一复核；真实 Windows completed，纳入审批族 |

第一波已按风险拆分交付。窗口枚举/聚焦的标题隐私、唯一命中、临时 ID、审批和真机证据均已闭环，账本中不再有未处理的 `应迁移` 条目。

## 明确保留在 Provider 的能力

- `look`、`pick`、`click_at`、`ocr` 及组合的视觉标记能力暂留受限 Python Provider；它们涉及 OCR 污点、坐标映射、视口链和视觉差异校验，不能用一个薄工具声明冒充迁移完成。
- ModLens 已接管图片语义读取，但不等于已经接管 OCR 坐标和点击目标安全。
- 多显示器需要显式 display id、主副屏选择和第二块真实显示器证据，当前标为外部阻塞。

## 明确淘汰的能力

- 旧独立 UI server：统一 DSH web Profile 已替代。
- 旧 `.state` 整包恢复：会把旧会话和 Runtime 所有权带回来；改用 Profile、Git 与交接清单。
- `propose_tool` 与动态 user tools：改用经审阅的 DSH skill/plugin/Bundle，不允许运行时悄悄写入新的可执行工具。

## 更新纪律

任何条目只有在用户可见契约、自动化、Windows 现场证据和失败路径同时通过后，才允许从 `应迁移` 改为 `XS 已提供` 或 `DSH 已提供`。旧仓库在盘点中只读，490 条接收时 dirty 状态不得被清理或混入 XS 提交。
