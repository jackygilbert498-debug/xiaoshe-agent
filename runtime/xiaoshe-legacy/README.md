# 小蛇 · 你自己的 agent（从零共建）

按《Harness共建手册》的六阶段路线图，从零造的一个生产级 agent harness。
当前进度：**v1 六阶段走完；v2 已完成 M0 换机闭环、M1 引擎整备（多开不打架）、M2 无头模式（免值守入口）、M3 前基线夯实（坏文件免疫）、M3 定时调度（借系统调度器 + 六道无人值守安全闸）、流式输出（交互模式边生成边显示）**。阶段5 产出《[离生产级还差什么](docs/离生产级还差什么.md)》。

## 跑起来（你验收用）

前提：Windows 或 macOS，已装 Python 3.10+、系统自带 `curl`。`.env` 可同时填写 Kimi 与 DeepSeek；已配置的模型会同时出现在界面菜单，切换只影响当前会话。Kimi 需代理时在 `.env` 的 `KIMI_PROXY` 填代理地址（`.env.example` 预填 `http://127.0.0.1:7897`，留空则直连）；DeepSeek 直连可用时将 `DEEPSEEK_PROXY` 留空。

默认使用 DeepSeek Flash；在 `.env` 中配置：

```dotenv
MODEL_PROVIDER=deepseek
DEEPSEEK_MODEL=deepseek-v4-flash
XS_MODELS=deepseek-v4-pro
```

模型 pill 可在本次会话中切换所有已配置的模型；菜单底部的“＋ 添加模型”可添加 OpenAI 兼容、Anthropic、Gemini 或本机 Ollama 配置。密钥只写入本机安全存储，编辑时只显示“密钥已保存”；保存不会测试连接，测试连接需要单独确认。要改变新会话默认模型，将对应 `*_MODEL` 与 `MODEL_PROVIDER` 改好后重启。

1. 对话：
   ```
   python run.py
   ```
   - **一键唤醒（推荐）**：配个短别名（本机用的是 `s`）就能任意目录敲一个字母起它——
     - macOS（zsh）：`echo 'alias s="python3 \"$PWD/run.py\""' >> ~/.zshrc`（在仓库目录跑一次），之后开新终端敲 `s` 即可；`s -p "任务"` 走无头。也可放一个双击启动的 `.command` 文件（内容就是 `python3 <仓库>/run.py`，`chmod +x`；本机放在交接包根目录 `唤醒Harness.command`）。
     - Windows：在仓库根目录跑一次 `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`。它只在当前用户的 `WindowsApps` 目录生成 `S.cmd`，不读取或修改 PowerShell profile，也不修改系统执行策略；之后在新开的 cmd 或 PowerShell 中输入 `S` 起交互、`S -p "任务"` 走无头。仓库移动后重跑一次安装命令即可更新路径。
   - 读/写文件、跑命令（写/跑先问你）、列任务清单、跨会话记忆、派分身、后台任务。
   - 回复会逐字冒出；生成中按 Ctrl+C 可干净打断。
   - 退出再进来 → 列出最近会话（最多 5 个），回车开新的、输编号接着旧的。
   - 想接外部工具：在 `mcp.json` 里写上 MCP server（如星见桥），启动即自动插上。
   - 输入 `:exit` 退出。

2. 无头模式（免值守跑一条任务）：
   ```
   python run.py -p "看看 README 讲了啥"
   python run.py -p "在 note.txt 写一句 hello" --allow write_file
   ```
   - 不给 `--allow` 时危险操作一律拒（并记日志）；`--allow` = 敲命令那一刻你已审批。
   - `--workdir 目录` 可把这次的工作区切到别处；`.env`/私钥等硬护栏在哪都拒。
   - 退出码 0 = 跑完了；干没干成看输出文本。

3. 定时任务（借系统调度器，电脑重启并登录后照跑）：
   ```
   python run.py schedule add --name 报时 --prompt "记一行时间戳" --every 1h --allow write_file
   python run.py schedule list / history 报时 / pause 报时 / stop 报时 / remove 报时
   ```
   - 敲 `add` 那一刻 = 审批那一刻（`--allow` 放行工具、`--workdir` 切工作区、`--max-minutes` 墙钟超时）。
   - 六道安全闸：墙钟总超时两阶段杀、防重入、能急停、`HARNESS_DISABLE_SCHEDULE=1` 总开关、
     `.state/schedule/` 对 agent 设防、默认不连 MCP。`history` 里能看到「越权尝试」次数。
   - 隔离档位=进程内护栏（非 OS 沙箱）；`--allow run_command` 等于开联网出口，别跑不可信内容。

4. 看日志：`.state/logs/<会话id>.jsonl`　跑测试：`python -m unittest discover -s tests -v`

### Windows 完整验证

在仓库根目录运行唯一的 Windows 验证入口：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify_windows.ps1
```

它会依次执行 UI 契约、serve 冒烟、UI E2E 和全量 unittest；任一失败即停止。

安装后可运行 `S doctor` 做只读诊断；输出只包含有限状态码和修复建议，不回显密钥、环境变量值或个人绝对路径。Windows 启动器支持可回退生命周期：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Action Install
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Action Upgrade
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Action Rollback
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Action Uninstall
```

安装器只管理当前用户启动目录中的 `S.cmd` 及其 ownership/hash manifest。PATH 仅在完整预检后按 manifest 记录添加；卸载只在该条目确由安装器加入且 PATH 后续未被用户改动时恢复原值。升级和回退前都会验证 owner 与哈希；卸载只删除 manifest 明确登记且当前哈希匹配的文件，用户会话、模型配置和 `.state` 默认保留。文件被用户修改或 manifest 损坏时会拒绝覆盖/删除。

## 它现在能 / 不能做什么

见 [CONTRACT.md](CONTRACT.md)。一句话：
- ✅ 聊天、读/写文件、跑命令（危险先问你）、任务清单、长对话压缩、跨会话记忆、派子 agent、后台任务、崩了读档接着干、**接外部 MCP 工具**、留痕。
- 📋 阶段5 交付：《[离生产级还差什么](docs/离生产级还差什么.md)》——12 条"家用车→量产车"的差距 + 难点，据此判断要不要/何时接管星见。

## 结构

```
.state/                      本机运行状态（会话档案+日志；不进 git、不同步）
run.py                       入口：交互对话（无参数）/ -p 无头模式
harness/
  config.py                  读 .env（环境变量 > .env > 默认）
  kimi_client.py             OpenAI Chat Completions 兼容客户端（Kimi/DeepSeek，curl 传输、工具与重试）
  tools.py                   内置 8 工具 + all_specs()（内置 + MCP 一起发给模型）
  mcp_client.py              MCP 客户端：stdio JSON-RPC 接外部工具服务器（USB 插座）
  permission.py              权限闸门：approve/deny/ask + 敏感硬护栏 + 命令扫描
  compaction.py              上下文压缩（不切断工具配对）
  memory.py                  跨会话记忆 + 读档刷新
  jobs.py                    后台任务：Popen 非阻塞 + 退出回收进程树
  session.py                 会话存档/恢复（原子写 + fsync + 干净断点）
  agent.py                   对话 + 工具循环 + 权限 + 压缩 + 子 agent + 存档 + MCP
  headless.py                无头模式：-p 免值守单次执行（--allow 即审批）
  schedule.py                定时调度：任务登记 + 薄监工执行（超时/防重入/历史/急停）
  scheduler_install.py       双平台安装器：schtasks(/XML) / launchd(plist)
  schedule_cli.py            schedule 子命令：add/list/run/history/pause/resume/stop/remove
tests/                       160 个测试文件；共 2200+ 条（含 3 条需活动提供商 API key，必要时配相应代理的实链）
CONTRACT.md                  契约（大白话，阶段0~4 + M0~M3）
docs/离生产级还差什么.md      阶段5：v1 到生产级的 12 条差距 + 难点
mcp.json（可选）             要接的 MCP server 清单（不进 git）
```

## 双机同步（Mac + Windows）

- 代码与记忆（`memory.json`）走本私有仓库：**每次动手前先 `git pull`，收工 `git push`**。
- `.env`（密钥）永不进 git，换机走 U 盘等私密渠道。
- `memory.json` 若出现 git 冲突：跑 `python -m harness.memory merge`（两边都留、自动去重），再正常提交。
- 本机运行状态（`.state/` 会话档案与日志）是本机私有，不同步。
