# 小蛇 · 你自己的 agent（从零共建）

按《Harness共建手册》的六阶段路线图，从零造的一个生产级 agent harness。
当前版本提供本地对话、任务、工具调用、模型切换、会话记忆和桌面界面；运行所需源码、测试与启动方式均包含在本仓库。

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
     - macOS（zsh）：`echo 'alias s="python3 \"$PWD/run.py\""' >> ~/.zshrc`（在仓库目录跑一次），之后开新终端敲 `s` 即可；`s -p "任务"` 走无头。也可使用仓库内的 `.command` 启动文件。
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

## 它现在能 / 不能做什么

- ✅ 聊天、读/写文件、跑命令（危险先问你）、任务清单、长对话压缩、跨会话记忆、派子 agent、后台任务、崩了读档接着干、**接外部 MCP 工具**、留痕。

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
mcp.json（可选）             要接的 MCP server 清单（不进 git）
```

## 隐私与配置

- `.env`、`.state/`、会话记录与本机模型密钥均不会被提交。
- 请从 `.env.example` 复制出本机 `.env` 后再填写自己的服务商配置；不要将该文件上传到公开仓库。
