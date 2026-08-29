# M3 · 定时调度 + 无人值守安全闸 · 设计文档

> 2026-07-03 定稿。前置输入：M1/M2 整体体检（16 agent 对抗复核，11 条证实）+ 业界调研
> （Kimi CLI 源码 19 项机制逐条、Claude Code / Codex / Gemini CLI 官方文档）。
> 结论：定时器是无人值守风险的放大器，「停得住 / 跑不飞 / 事后查得清」与定时器本身
> 是同一套设计，M3 一起交付。

---

## 1. 目标与非目标

**目标**：用户建一个定时任务（如「每小时记一行时间戳」），电脑重启照样跑；任务
跑飞有总闸拦住；正在跑的能找到、能停掉；每次执行留结构化历史，越权企图看得见。

**非目标（明确不做，写给未来的自己）**：
- 不做常驻守护进程（架构复议已否，借系统调度器：Windows 任务计划 / macOS launchd）。
- 不做 OS 级沙箱/断网（纯标准库做不到 Seatbelt/Landlock；契约白纸黑字写明档位，
  别给虚假安全感——业界「敢自动批是因为容器兜底」的公式我们只有进程内护栏这半层）。
- 不做 token/费用精确预算（M7 花费统计的正题；本期用墙钟+轮数上限兜「跑不飞」）。
- 不做 cron 表达式（YAGNI：间隔 + 每天定点覆盖日常绝大多数需求，双平台映射简单）。

## 2. 总体形态：薄监工 + 复用 M2 无头

```
系统调度器（任务计划/launchd）
   │ 到点唤起
   ▼
schedule run <名>            ←—— 也可人工敲，行为一致
 ┌─────────────────────────────┐
 │ 监工（薄，不跑模型）           │
 │ ① killswitch/enabled 检查    │
 │ ② 按任务名拿非阻塞锁（防重入） │
 │ ③ 落 pidfile                │
 │ ④ 起子进程 run.py -p …       │──▶ M2 无头模式（白名单/硬护栏/留痕全复用）
 │ ⑤ wait(墙钟超时)→两阶段杀     │
 │ ⑥ 写执行历史一行、清 pidfile  │
 └─────────────────────────────┘
```

**为什么监工起子进程、而不是进程内跑**：真正的墙钟控制（curl 阻塞中也杀得动）；
崩溃隔离（监工极薄不会挂，历史一定写得上）；`stop` 命令有明确的杀伤目标（子进程树）；
M2 全部安全语义零改动复用。这正是契约两处「M3 调度器统一加超时」承诺的兑现方式。
（Kimi CLI 互证：其超时杀进程 = SIGTERM→5s 宽限→SIGKILL，Windows 用 taskkill /T /F 杀整树。）

## 3. 命令面（全部走 `python run.py schedule <子命令>`）

| 命令 | 干什么 |
|---|---|
| `schedule add --name 报时 --prompt "…" --every 1h [--daily HH:MM] [--allow write_file] [--workdir D:\x] [--max-minutes 30] [--mcp]` | 建任务档案 + 装进系统调度器。**敲这条命令的那一刻 = 审批那一刻**（M2 拍板的延伸） |
| `schedule list` | 列所有任务：节奏 · 启/停 · 上次结果 |
| `schedule run 名` | 被调度器唤起的入口（人工敲同义），走监工流程 |
| `schedule history 名 [-n 10]` | 看最近 N 次执行记录 |
| `schedule pause 名` / `resume 名` | 暂停/恢复（系统层禁用 + 档案 enabled 双保险）——回答「怎么暂停」 |
| `schedule stop 名` | 停掉**正在跑**的那一次（按 pidfile 两阶段杀）——回答「怎么停」 |
| `schedule remove 名` | 从系统调度器删除；档案改名 `.removed`，历史保留 |

`--every` 接 `Nm`/`Nh`（1 分钟~24 小时）；`--daily` 接 `HH:MM`；二选一必给其一。

## 4. 落盘布局（全在 `.state/schedule/`，本机私有不进 git）

```
.state/schedule/
  tasks/<name>.json      任务档案：name/prompt/allow/workdir/节奏/max_minutes/mcp/enabled/created_at
  history/<name>.jsonl   执行历史：一行一次运行（见 §6）
  running/<name>.pid     正在跑的 pidfile（监工+子进程 pid、启动时间；结束即清）
```

- 任务名白名单 `^[\w一-鿿-]{1,40}$`（字母数字下划线中文连字符，防路径穿越——抄 Kimi 的 id 正则思路）。
- prompt 按 UTF-8 字节封顶 8KiB（抄 Kimi：防按字符数低估中文）。
- 每任务数量上限 50 个（抄 Kimi 的会话内 cron 上限）。

## 5. 安全设计（六道闸，对应体检六缺口）

1. **墙钟总超时**：每任务 `--max-minutes`（默认 30，上限 24h）。监工 `wait(timeout)` 到点
   两阶段杀子进程树（Windows `taskkill /T /F`；POSIX `killpg` TERM→5s→KILL），历史记
   `timeout`。这同时封死了体检最尖锐的「子 agent 免审批扇出 × 嵌套 × 每轮无限宽」慢速失血。
2. **防重入**：按任务名拿 M1 已有的跨平台文件锁（非阻塞）；拿不到 = 历史记
   `skipped_overlap` 后退出 0（跳过不算失败）。「每小时任务遇上慢任务」的必然场景有账可查。
   （业界互证：三家 CLI 均无内置防重入、把调度交给外部，flock 是通行做法——我们有现成锁，补上。）
3. **能停**：`running/<name>.pid` 让「找到并停掉」成为一条命令；`pause` 是计划层的暂停，
   `stop` 是运行层的急停，两个词分开、语义不混。
4. **全局 killswitch**：环境变量 `HARNESS_DISABLE_SCHEDULE=1` → 一切 `schedule run` 记
   `skipped_killswitch` 直接退出（抄 Kimi 的 KIMI_DISABLE_CRON：一票停摆，出事时先止血）。
5. **任务档案设防**（防 agent 给未来的自己扩权——Claude Code protected paths 同思路）：
   `.state/schedule/` 进敏感路径清单，write_file 连碰都不行；run_command 文本扫描加
   `state/schedule` 目录特征 token。任务档案只能由人敲 `schedule add` 产生——守住
   「危险授权必须每次显式来自命令行、不能藏在文件里被改写」（Gemini「yolo 不可持久化」同理）。
6. **定时任务默认不连 MCP**：run.py 新增 `--no-mcp`；调度子进程默认带上，建任务时
   `--mcp` 显式声明才连（对齐 Claude Code headless `--bare` 的方向：无人值守时环境里
   恰好放着的配置不该自动成为攻击面）。交互模式行为不变。

**不变量重申**：硬护栏（越界/敏感文件/命令密钥扫描）任何模式不可豁免；无头 approver
恒拒 + 白名单是唯一放行通道；`--allow run_command` 等于打开联网出口（curl 可外发），
add 时 stderr 显著警告——业界的答案是沙箱断网，我们做不到就把话说透。

## 6. 执行历史与退出码（「事后查得清」）

历史一行（JSONL）：`{start, end, outcome, exit_code, duration_s, denied_calls, session_id, output_tail}`

- `outcome ∈ done | failed | timeout | interrupted | skipped_overlap | skipped_disabled | skipped_killswitch`
- **denied_calls（被拒调用数）是无人值守下唯一的越权信号灯**（业界调研结论原句），
  历史必含：无头模式统计本次被安全策略/白名单拒绝的调用次数，经运行摘要文件
  （监工设 `HARNESS_RUN_SUMMARY=<路径>`，headless 结束时原子写 JSON）带回监工。
- 监工退出码：`0`=done 或 skipped（跳过不算失败，别让任务计划误报）；`1`=failed；
  `124`=timeout（GNU timeout 惯例）；`130`=监工本身被 Ctrl+C。
  （Kimi goal 模式 0/3/6 分码互证：让调度历史能区分「干完/被掐/超预算」。）

## 7. 双平台安装器

抽象五操作：install / uninstall / enable / disable / status；按平台两个后端：

- **Windows（本机真机可验）**：`schtasks /Create /TN "Harness\<name>" /XML <生成的xml> /F`。
  用 XML 而非命令行拼参（转义地狱——Kimi 同款拍板）；触发器按 §3 节奏映射
  （每 N 分钟/小时 = Repetition Interval；每天 = CalendarTrigger）；
  MultipleInstancesPolicy=IgnoreNew（系统层也防重叠，与文件锁双保险）；
  StartWhenAvailable=true（关机错过的触发，开机补一次）。
  动作命令：`<python绝对路径> <run.py绝对路径> schedule run <name>`，工作目录=仓库根。
- **macOS（代码+单测本期交付，真机验证留待 Mac——对称于 M0 的 Windows 留待）**：
  `~/Library/LaunchAgents/com.harness.<name>.plist`，StartInterval（秒）或
  StartCalendarInterval{Hour,Minute}；`launchctl bootstrap gui/$UID` 加载、`bootout` 卸载；
  RunAtLoad=false；StandardOut/ErrorPath 指到 .state/schedule/ 下。

已知边界（写进契约）：不带凭据的用户级任务通常**仅用户登录会话存在时运行**
（Windows 免密任务如此，LaunchAgent 亦如此）——「重启照跑」指重启并登录后照跑。
这对单人个人机是对的默认；要无人登录也跑属服务器场景，非目标。

## 8. 顺手清偿的欠账（契约点名留 M3 的）

- `atomic_write` 固定 `.tmp` 临时名 → 改唯一名（`<名>.<pid>.tmp`），双开同瞬落档不再互抢（M1/M2 契约承诺）。
- 无头/调度档案与交互会话**分池**：恢复列表只显示交互会话；清理配额分开算
  （体检结论：不分池则每小时任务约两天挤空全部交互档案，从纸面取舍变日常疼痛）。

## 9. 测试与验收策略

- **离线为主**：监工用「假子进程」（sleep/立即退出/永睡的小脚本）测超时杀/锁/历史；
  安装器把「执行 schtasks/launchctl」做成可注入函数，单测断言生成的 XML/plist 内容与
  调用参数，不真装；权限设防、killswitch、denied_calls 计数全部离线可测。
- **真机验收（Windows，本期我自己做）**：真建一个每分钟任务 → schtasks 查到 → 等它
  真被唤起 → 时间戳文件有新行 + history 有 done 记录 → pause/resume/stop/remove 逐个验 →
  清理干净。重启验证留给用户（任务计划本性持久，注册即活）。
- **回归基线**：129 条只增不减；双平台全绿是里程碑收尾条件（Mac 侧留待用户下次 pull）。

## 10. 已知取舍

- 监工多一个进程的开销（Python 启动 ~百毫秒级）——换来真墙钟控制与崩溃隔离，值。
- 定时任务的输出不推送通知（notify 外包命令是好参照，留后续；本期靠 history 查）。
- 暂停的是「计划」，急停的是「本次运行」；暂停不杀正在跑的那次（要杀用 stop）。
- schtasks/launchctl 输出编码与本地化差异：状态解析尽量薄（只认退出码与关键字段），
  解析失败降级为「状态未知」而不是误报。
