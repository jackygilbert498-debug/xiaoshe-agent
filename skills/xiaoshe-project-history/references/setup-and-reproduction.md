# 安装、配置与复现

## 1. 前置条件

- Python 3.11、3.12 或 3.13；运行时只使用标准库。
- Git 命令行可用；Skill 只调用只读子命令。
- 待检查的 XS、DSH、legacy 和归档目录由你明确指定。Skill 不搜索整块磁盘。

先检查：

```text
python --version
git --version
```

如果系统没有名为 `python` 的命令，请在下文把它替换为该机器上 Python 3.11–3.13 的真实可执行文件。不要把某一操作系统的启动器写进共享配置。

## 2. 选择布局并生成本机配置

从 Skill 根目录运行。配置写到 Skill 目录之外，便于更新或复制 Skill 时不夹带个人路径：

### 历史多工作树

```text
python scripts/history_inventory.py configure \
  --layout workspace \
  --xs-root "/path/to/XS" \
  --desktop-legacy-root "/path/to/legacy-xiaoshe" \
  --handoff-directory "/path/to/handoffs" \
  --output "../xiaoshe-history.local.json"
```

`--dsh-root` 和 `--embedded-legacy-root` 未提供时，分别从 `<XS>/runtime/DSH` 与 `<XS>/runtime/xiaoshe-legacy` 推导。程序不会猜测桌面 legacy 或归档目录。已存在的输出不会被覆盖；确认要替换时显式增加 `--overwrite`。

### 公开单仓版

当发布提交已经把 DSH、legacy 和产品包收在同一 Git 顶层时，使用：

```text
python scripts/history_inventory.py configure \
  --layout published \
  --xs-root "/path/to/xiaoshe-public-release" \
  --handoff-directory "/path/to/final-handoffs" \
  --output "../xiaoshe-release-history.local.json"
```

此布局只生成 `xiaoshe-release` 与可选 `handoffs` 两个来源。它不会把仓内 `runtime/DSH`、`runtime/xiaoshe-legacy` 重复算成两段独立 Git 历史，也不接受 `--dsh-root`、`--embedded-legacy-root` 或 `--desktop-legacy-root`。

[历史工作区示例配置](source-config.example.json) 与 [公开版示例配置](source-config.published.example.json) 只展示 schema，不可直接当成本机配置使用。

## 3. 先运行 doctor

```text
python scripts/history_inventory.py doctor \
  --config "../xiaoshe-history.local.json" \
  --json-output "../xiaoshe-history.doctor.json"
```

`doctor` 检查 Python、Git、配置、目录、Git 工作树、可选 manifest、归档魔数和 stash 路径映射。它不读取 diff 正文，不应用 stash，也不修改仓库。

- 退出 0：所有所需检查通过。
- 退出 2：可以继续，但存在告警，例如可选 manifest 缺失或归档目录为空。
- 退出 3：配置、运行环境或来源无法安全读取；先修复对应 `fail`。

## 4. 标准工作流

将 `<mode>` 依次替换为 `inventory`、`timeline`、`gaps` 或 `course-export`：

```text
python scripts/history_inventory.py <mode> \
  --config "../xiaoshe-history.local.json" \
  --output "../<mode>.json" \
  --pretty
```

比较两个归档：

```text
python scripts/history_inventory.py compare \
  --before "/path/to/before.tar.gz" \
  --after "/path/to/after.tar.gz" \
  --output "../comparison.json" \
  --pretty
```

`gapsStatus=cannotEvaluate` 表示缺 stash、快照或 `archivePrefix` 之一；这不是“没有缺口”。先补齐 `cannotEvaluate.missingPrerequisites` 再重跑。

对 Git 来源，先查看 `dirtyCounts`，再查看 `acceptanceAlignment` 与逐平台 `headMatch`。若为 `mixed` 或 `stale`，课程与交付说明必须把报告标为历史提交证据；不得因为检查项本身全为 pass 就声称当前 HEAD 已完成同一轮验收。`course-export` 只保留这组脱敏摘要。

`compare` 只有在两侧均为 `verified` 且内容相同时返回 0；发现真实差异或任一侧证据不完整时返回 2。输入损坏、完整性失败或运行错误返回 3。

## 5. 复制环境复现

下面的验收脚本会把 Skill 复制到一个含中文和空格的临时路径，创建最小 Git/stash/manifest/tar/ZIP 夹具，然后完整运行 configure → doctor → inventory → timeline → gaps → compare → course-export：

```text
python scripts/verify_reproduction.py \
  --json-output "../portable-reproduction.json"
```

脚本只操作自身临时目录；退出 0 且报告中七个步骤的退出码符合合同时，说明复制后的 Skill 能独立运行。该结果证明的是夹具复现，不替代对真实项目运行 `doctor` 和 `inventory`。

## 6. 常见故障

- `configured manifest does not exist`：这是显式告警。若不需要 live manifest，可从本机配置移除该字段；若需要，则修正路径。
- `container-noncanonical`：内容可读，但扩展名与真实容器不一致；不要把它升级为 verified。
- `readable-no-sidecar`：归档没有独立 SHA-256 sidecar；可以描述结构，不能声称外部完整性已验证。
- `no manifest or recognized release reports`：ZIP 既没有传统 v1 清单，也没有完整的 `_验收/windows-desktop.json` 与 `_验收/macos-desktop.json`，因此不会猜测成发布包。
- `release acceptance commit mismatch`：两平台报告指向不同提交；整个派生快照拒绝使用。
- `acceptanceAlignment=mixed`：实时仓库内两份平台报告属于不同提交；逐份报告仍可作为各自提交的历史证据，但不能合并为当前验收结论。
- `acceptanceAlignment=stale`：两份报告相互一致，但都不对应当前 HEAD；更新实现后必须重跑对应验收门禁。
- `safe relative path`、`encrypted`、`special or symbolic`、`size limit`：发布 ZIP 触发安全边界；不会解压或降级绕过。
- `unreadable`：路径存在，但 Git、JSON 或容器无法安全读取；与 `missing` 不同。
- `integrity-failed`：已有校验值不匹配；停止使用该来源推导正文结论。

不要把 API Key、Token、会话、授权缓存或环境变量写入配置和报告。
