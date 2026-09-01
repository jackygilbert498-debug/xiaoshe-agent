# 证据与输出合同

## 来源配置

新配置 schema 为 `xiaoshe-history-sources/v2`；读取器兼容既有 v1。每个来源包含唯一 `id`、`kind` 和 `path`，Git 来源可有 `manifest`。支持：

- `git`：读取 HEAD、分支与工作树状态。
- `git-with-stashes`：额外读取 stash 的 tracked/untracked 树；v2 用显式 `archivePrefix` 映射归档路径。
- `archive-directory`：按内容魔数读取 gzip-tar、plain tar 和 ZIP；扩展名只参与规范性判断。

相对路径相对于配置文件解析。未知字段、重复 ID、不安全 `archivePrefix` 或空路径使配置失败。个人配置必须位于可复用 Skill 之外。

`configure --layout workspace` 生成 XS、DSH 与 embedded legacy 的多来源配置；`configure --layout published` 只生成一个 `xiaoshe-release` Git 来源及可选归档目录。公开单仓中的嵌套目录不能当作独立 Git 仓库重复计数。

### 实时仓库的验收报告对齐

Git 来源存在 `_验收/windows-desktop.json` 或 `_验收/macos-desktop.json` 时，inventory 会在 1 MiB 单文件上限内校验报告身份、带时区时间、40 位提交、唯一检查项、状态、detail 和 evidence，再只导出安全摘要。`acceptanceAlignment` 含义如下：

- `current`：两份报告提交相同，且等于当前 HEAD；
- `stale`：两份报告提交相同，但早于或不同于当前 HEAD；
- `mixed`：两份报告指向不同提交；
- `incomplete`：只存在一份平台报告；
- `missing`：两份都不存在；
- `invalid`：至少一份存在但格式或边界校验失败。

该字段只回答“报告对应哪个提交”，不改变 Git 来源的 `live-unarchived` 等级，也不掩盖 dirty/untracked。课程导出可保留平台、提交、时间、检查计数和 `headMatch`，不得带入报告正文、绝对路径或本机证据。

## Manifest 合同

可用于内容比较的 manifest 必须满足：

- schema 为 `xiaoshe-handoff-manifest/v1`；
- `generatedAt` 是带时区的 ISO 8601；
- `summary.fileCount` 等于 `files` 项数，`summary.totalBytes` 等于各项 size 之和；
- 每个文件路径是规范、唯一的 POSIX 相对路径，不能含绝对路径、盘符、反斜杠或 `..`；
- type 只能为 `file` 或 `symlink`；size 为非负整数；SHA-256 为 64 位十六进制。

ZIP manifest 在读取前检查解压后大小上限；tar manifest 流式读取且不解压到磁盘。

## 无传统 manifest 的公开版 ZIP

Skill 只对一个受约束的发布格式提供回退读取，不把任意 ZIP 猜成小蛇快照：

- 所有成员必须位于同一个顶层目录，并使用唯一、规范、相对的 POSIX 路径；拒绝绝对路径、盘符、反斜杠、`.`、`..`、NUL、加密成员、符号链接和特殊文件；
- 最多 20,000 个成员，单成员解压后最多 256 MiB，总解压大小最多 512 MiB；两份验收 JSON 各最多 1 MiB；
- 必须同时存在 `_验收/windows-desktop.json` 与 `_验收/macos-desktop.json`；`schemaVersion`、平台、带时区时间、40 位提交、检查状态与证据对象都要有效；
- 两份报告的提交必须一致；派生快照对每个文件流式计算 SHA-256，不写入磁盘，也不执行归档内容；
- 派生清单是扫描时生成的内容索引，不冒充 ZIP 内原有的 `xiaoshe-handoff-manifest/v1`。外部 `<archive>.sha256` 不存在时，最高只到 `readable-no-sidecar`。

## 证据等级

| 状态 | 可做结论 | 限定 |
|---|---|---|
| `verified` | 可引用清单和内容哈希 | 只代表该快照时点 |
| `readable-no-sidecar` | 可描述可读结构 | 没有独立 checksum |
| `live-unarchived` | 可描述当前工作树 | 尚未冻结为归档 |
| `container-noncanonical` | 可描述容器内信息 | 扩展名或外层证明不规范 |
| `missing` | 只能报告缺口 | 路径不存在 |
| `unreadable` | 只能报告读取失败 | 路径存在但无法安全读取 |
| `integrity-failed` | 不信任来源正文 | 报告期望值与实际值 |

总体 `complete` 只在所有参与来源均为 verified 时成立；任何 live/no-sidecar/noncanonical/missing/unreadable 都是 `partial`，完整性失败是 `failed`。

## 比较与 gaps

- 新增、删除和修改只由规范路径集合与内容 SHA-256 得出。
- `compare` 输出 `beforeEvidenceStatus` 与 `afterEvidenceStatus`。
- stash 路径只通过来源配置的 `archivePrefix` 映射，不使用内置个人项目前缀。
- 缺 stash 证据、快照证据或 archivePrefix 时，输出 `gapsStatus=cannotEvaluate` 与 `missingPrerequisites`；空 gaps 只有在成功 evaluated 后才表示没有发现缺口。

## 输出与隐私

普通报告 schema 为 `xiaoshe-history/v1`。`course-export` schema 为 `agent-workbench-evidence/v1`，只保留稳定来源 ID、证据等级、发布提交、时间线、差异、决策、缺口和限定；绝对路径、错误中的本机路径、秘密字段和 Git diff 正文不得进入课程导出。

JSON 通过同目录临时文件、`fsync` 和原子替换写入。失败前已有输出保持不变。

## 退出码

- `0`：命令合同完整满足；compare 两侧 verified 且无差异。
- `2`：部分证据、告警、cannotEvaluate，或 compare 发现差异。
- `3`：配置、参数、输入、运行或完整性错误。
