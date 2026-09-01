---
name: xiaoshe-project-history
description: Use when configuring, diagnosing, reconstructing, comparing, auditing, or exporting the evidence-backed history of Xiaoshe, XS, DSH, legacy worktrees, Git stashes, single-repo public releases, or handoff archives.
---

# 小蛇项目历史

## 目标

从调用者明确提供的只读来源重建可验证的项目历程。始终区分当前实现、历史快照、stash 独有内容、容器可信度和无法判断项；不要把“未发现”写成“不存在”。

## 首次使用

1. 完整读取 [证据合同](references/evidence-contract.md)。
2. 首次配置或换机时，先判断来源是历史多工作树还是公开单仓版，再按 [安装、配置与复现](references/setup-and-reproduction.md) 执行 `configure`，把本机配置写在 Skill 目录之外。
3. 运行 `doctor`。有 `fail` 时停止证据分析；只有告警时可继续，但结论保持相同限定。
4. 普通请求先执行 `inventory`，再按用户意图选择后续模式。

[历史工作区示例配置](references/source-config.example.json) 与 [公开版示例配置](references/source-config.published.example.json) 只用于理解字段，不包含可直接运行的个人路径。

## 两种布局

- `--layout workspace`（默认）：XS、嵌套 DSH、嵌套 legacy、可选桌面 legacy/stash 与往期归档是分别取证的历史现场。
- `--layout published`：整个公开交付物是一个 Git 仓库；仓内 `runtime/DSH` 和 `runtime/xiaoshe-legacy` 只是该提交中的普通目录，不得重复登记为独立 Git 来源。

不要只因目录名称相同就在两种布局间自动切换；选择必须来自用户提供的来源性质或当前 Git 顶层证据。

## 模式路由

| 用户意图 | 模式 |
|---|---|
| 创建这台机器的来源配置 | `configure` |
| 检查 Python、Git、配置和证据是否可用 | `doctor` |
| 确认来源、HEAD、dirty/untracked 与归档等级 | `inventory` |
| 按时间查看可验证快照 | `timeline` |
| 比较两个归档的新增、删除和内容变化 | `compare` |
| 找未进入归档快照的 stash 内容 | `gaps` |
| 生成脱敏、冻结的课程证据 | `course-export` |

## 执行合同

1. 从 Skill 根目录用当前 Python 3.11–3.13 解释器运行 `scripts/history_inventory.py`。不要假定操作系统或启动器。
2. 只使用调用者生成的本机配置；不要改写 `references/source-config.example.json`。
3. 报告每个来源的 `verified`、`readable-no-sidecar`、`live-unarchived`、`container-noncanonical`、`missing`、`unreadable` 或 `integrity-failed`。
4. `integrity-failed` 来源不得用于推导正文结论。`unreadable` 与 `missing` 必须分开说明。
5. `gapsStatus=cannotEvaluate` 时，列出缺失前置条件；不能输出“没有遗漏”。
6. `course-export` 只写用户指定的文件，且不得包含绝对路径、秘密或源项目正文。
7. 无传统 manifest 的公开版 ZIP 只有同时具备格式有效、提交一致的 Windows/macOS `_验收` 报告，且全部成员通过路径、类型、加密位、数量和大小边界后才可生成只在内存中的派生快照；没有外部 `.sha256` 时仍是 `readable-no-sidecar`。
8. 扫描实时 Git 来源时，同时读取仓内固定位置的 Windows/macOS `_验收` 报告并比较其 `commit` 与当前 HEAD。`current`、`stale`、`mixed`、`incomplete`、`missing`、`invalid` 必须原样表达；旧报告只能证明对应提交，不能包装成当前 HEAD 已验收。工作树 dirty 状态仍单独判断。

通用调用形式：

```text
python scripts/history_inventory.py inventory \
  --config "/path/to/xiaoshe-history.local.json" \
  --output "/path/to/history-inventory.json" \
  --pretty
```

复制或安装后，可从任意当前目录运行完整自检，无需预设 `PYTHONPATH`：

```text
python "/path/to/xiaoshe-project-history/scripts/run_tests.py"
```

只有全部测试通过，才继续读取真实项目来源；自检不读取或修改 XS、DSH、legacy、stash 或归档。

## Read-only 只读边界

- 不执行 stash apply/pop/drop、checkout、reset、clean、commit 或自动归档。
- 不把压缩包解压到 XS、DSH、legacy 或任何来源目录。
- 用 SHA-256 比较内容，不用文件时间冒充版本差异。
- 不读取或导出 API Key、Token、个人会话、本机授权和秘密环境变量。
- 不把 DSH 底层能力、计划或 `release-held` 项写成 XS 已交付能力。

## 返回与表达

- 退出 0：命令合同完整满足；`compare` 还要求两侧 verified 且无差异。
- 退出 2：获得部分结果、存在告警/无法判断，或 verified 比较发现真实差异。
- 退出 3：配置、参数、输入、运行或完整性错误。

先给结论，再列来源等级、时间线/差异/缺口、证据限制和可安全继续的动作。不要把 partial 解释为扫描失败，也不要把 partial 改写成 complete。
