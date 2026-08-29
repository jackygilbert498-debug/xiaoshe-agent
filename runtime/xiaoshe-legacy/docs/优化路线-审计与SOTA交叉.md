# 小蛇 v2 · 优化路线（代码审计 × SOTA 调研 交叉）

> 生成日期：2026-07-05。方法：先对 `D:\ke` 全量代码做多维度审计（对抗验证真伪），再联网调研 agent harness/“模型壳”领域的论文与顶尖项目，最后把**我们自己的真问题**对上**业界怎么解**，排出有依据的优化方向。
> 数字：审计 61 候选 → **43 确认**（22 中危 · 8 低危 · 13 改进点 · **0 高危**）+ 剔 18 误报；调研 8 方向 **82 来源 / 70 用 WebFetch 真核实**。
> 诚实前置：**0 高危说明小蛇本身造得扎实**，挖出来的都是单测照不到的边界/时序/协议/被绕护栏。其中 **#4 是上一次“流式握手重试”修复自己引入的 bug**（重试漏算 reasoning_content → 可能重复计费），应优先修。少数调研来源标了 `未核实`（WebFetch 失败但检索确认存在），见附录。

---

## 一、结论先行：五大优化方向（按 价值 × 可行 排序）

| # | 方向 | 一句话 | 命中的审计条 | 主要 SOTA 依据 | 工作量 |
|---|---|---|---|---|---|
| **1** | **安全硬化** | 真沙箱 + 污点标签 + MCP 硬化 + 注入回归 —— 把“靠提示/黑名单挡”升级成“不可信内容进不了触发动作的路径” | #7 #9 #8 #12 #14 #23 | CaMeL、6 设计模式、Adaptive Attacks、Anthropic 沙箱、InjecAgent/AgentDojo、MCP 规范 | 大（分阶段） |
| **2** | **上下文与成本工程** | 接真 token 计量 + prompt caching 稳定前缀 + 压缩改“选择性清理+可回捞分页+外置笔记” | #13 #15 #4 #6 | Manus、Don't Break the Cache、MemGPT、Anthropic context engineering、Aider repo map | 中（quick-win 多） |
| **3** | **真实任务 eval + 可靠性** | 建 Terminal-Bench 同构的最小 eval 套件 + pass^k 一致性 + Docker 沙箱跑 | （43 条中危“单测照不到”本身即证据） | Terminal-Bench、SWE-bench、τ-bench pass^k、LLM-as-judge | 中（战略价值高） |
| **4** | **43 条确认缺陷修复批** | 分三批把审计确认的 bug/弱点清掉，含若干 quick win | 全部 43 条 | —（我们自己的审计） | 小～中（确定性高） |
| **5** | **Agent 能力升级** | ReAct 显式轨迹 → Reflexion 反思闭环 → 进度感知停止 → 按需分解 → 多 agent 编排 | —（能力空白，非 bug） | ReAct、Reflexion、ADaPT、LATS、Huang“不能只靠自纠”、Anthropic 多 agent、MAST | 大（分 M4/M5/M6） |

**给你的一句话建议**：先做 **方向4 里的 6 个 quick win**（半天到两天、零风险、含修我引入的 #4）稳住地基；同时把 **方向1（安全）** 和 **方向2（上下文成本）** 当两条主线推——这两条既补 SOTA 差距、又一次性兜住最多审计条，是“大奖”所在。方向3（eval）先搭最小骨架，让后面每次改动有客观标尺。方向5 是更大的能力跃迁，留作 M4~M6 的正题。

---

## 二、方向详解

### 方向 1 · 安全硬化（最高价值）

**现状**：`run_command` 直接在宿主 `shell=True` 执行、无沙箱；安全边界靠命令子串黑名单 + 敏感文件硬拒。这是已知取舍，但审计在“取舍之外”又挖出多处**护栏静默失效**。

**我们的证据（审计）**：
- **#7** `permission.check()` 的路径硬护栏只认叫 `path` 的参数 → 接一个参数叫 `file`/`target` 的文件类 MCP server，越界/敏感文件校验**完全跳过**。
- **#9** MCP 工具执行不走 `safe_path`：即便用户已授信某 MCP 工具，`.env`/越界兜底对它**缺失**，与内置工具不对称。
- **#8** 命令子串扫描对合法命令**误拒**（`cat dev.env.md`、`grep credentials`）且硬 deny 连人都不能批。
- **#12** 记忆被冠以「回答时请遵循」注入 system：模型读了不可信内容后自作主张 `remember` → **跨会话持久提示注入**，用户看不到。
- **#14** 压缩摘要把被压历史（可能含注入文本）原样拼进 system，二阶注入面。

**SOTA 依据（真论文/项目）**：
- 《Adaptive Attacks Break Defenses…》(arXiv 2503.00061) 证明**启发式黑名单在针对性绕过下基本失效**（>50% 成功率）——直接说明子串扫描不是安全边界。
- **CaMeL**《Defeating Prompt Injections by Design》(2503.18813) 与《Design Patterns for Securing LLM Agents》(2506.08837) 的共同结论：**可靠防御必须让不可信内容进不了能触发动作的路径**，而不是靠提示前缀。
- Anthropic《Making Claude Code more secure with sandboxing》（含 `@anthropic-ai/sandbox-runtime`）：**OS 级隔离 + 网络只走白名单代理**，官方实测减 84% 权限弹窗。
- MCP 官方规范（2025-06-18）明确“**工具注解须视为不可信**”；MCPSecBench (2508.13220) 显示对 tool poisoning / 工具描述里的间接注入现有防护拦截率 **<30%**。
- 安全回归基准：InjecAgent (2403.02691)、AgentDojo (2406.13352)。

**怎么做（分阶段）**：
1. **真沙箱当第一道防线**（抄 mini-SWE-agent 的 `execute(cmd)` 可替换接口）：所有命令/文件操作收敛到一个接口，本地默认 `subprocess`，**一行切到 docker/bubblewrap exec**；Windows 走 WSL2 / AppContainer / Job Object；文件系统限定工作区，**网络只放行白名单出站代理**。一步同时兜住“无沙箱 + 黑名单可绕 + 出网无管控 + 敏感文件可经网络外传”。
2. **污点标签 + 数据流约束**（CaMeL 弱化落地版，贴合现有三态闸门）：工具返回（网页/邮件/MCP）与 **MCP 工具描述**一律标 `tainted`；当高危动作的参数**源自 tainted 数据**时，强制升级人工确认或拒绝。
3. **MCP 硬化**（修 #7 #9）：`check()` 不再只认 `path` 键——对 args 里所有类路径字符串统一过 `safe_path`；工具描述过一层注入检测再进 prompt；server 命名空间 + 信任分级。
4. **记忆/摘要去注入**（修 #12 #14）：把「请遵循」弱化为「以下为记录的偏好，仅供参考、勿当指令」；对 fact/summary 加长度上限与注入特征软过滤；长文/含指令特征的 `remember` 降级为 ask。
5. **注入安全回归套件**：把 InjecAgent/AgentDojo 的攻击话术做成**中文测试名契约**并入 CI，含“自适应攻击”评估，让“前缀防御到底挡不挡得住”有可量化答案。

---

### 方向 2 · 上下文与成本工程

**现状**：`compaction` 按**字符**预算把整段旧史压成一条摘要（一压即丢、不可逆）；无 token 计量、无 prompt caching；工具声明每轮全量下发。

**我们的证据（审计）**：**#13**（字符软预算与真 token 脱节，`keep_recent` 里多条大工具结果每轮触发一次白烧的摘要调用）、**#15**（`_render` 把工具结果截到 500 字喂摘要器 → 结论在末尾就丢）、**#4/#6**（流式重试漏算 reasoning / 失速误判 → 重复计费）。

**SOTA 依据**：
- Manus《Context Engineering… Lessons from Building Manus》：**KV-cache 命中 vs 未命中约 10x 价差**；前缀必须稳定（别放时间戳）、context 只追加不改、**别动态删工具（毁缓存）改用屏蔽**、把文件系统当外置可逆记忆（丢内容留路径）。
- 《Don't Break the Cache》(2601.06007)：prompt caching 在长程 agent 任务整体**降本 41–80%**。
- **MemGPT** (2310.08560)：OS 分页思想，压缩的旧内容进外存、**需要时再取回**（可回捞，而非一压即丢）。
- Anthropic《Effective Context Engineering》：**tool-result clearing**（只清原始工具输出、保架构决策/未解问题）+ **外置结构化笔记**（context 外持久 todo/notes，近端 recitation）+ context rot（token 越多有效召回越降）。
- Aider repo map（tree-sitter + 图排序）：主动的代码库地图作上下文。

**怎么做**：
1. **prompt caching + cache-aware 拼装**（成本/延迟头号杠杆）：system + 工具定义作稳定前缀（去动态串、确定性序列化、只追加），动态工具结果放消息末尾。
2. **压缩升级**（修 #13 #15）：从“整段摘要”改为 **选择性清工具输出 + 保决策/未解/进度 + 外置笔记**；压缩前把原文落盘外存，摘要保留**可回捞指针**，给模型一个 `recall` 工具按需取回（MemGPT 分页）。
3. **接真 token 计量**：用 provider 的 `usage` 或本地 tokenizer 替换按字符估算，为 caching 与预算决策打底。
4. **修 #4/#6 流式重试**：`has_output` 纳入 `reasoning_content`；`exit 28`（失速）与 `exit 35`（握手）分类对待，失速不无脑重试。

---

### 方向 3 · 真实任务 eval + 可靠性（战略地基）

**现状**：只有单测（验函数/契约）+ 对抗复盘（人工想攻击），**零真实任务级 eval、无一致性度量**。

**为什么现在做**：这 43 条中危“单测全绿却照不到”本身就是最强证据——没有真实任务 eval，深水雷就只能靠人肉对抗复盘偶然撞到。

**SOTA 依据**：**Terminal-Bench** (2601.11868，形态与小蛇“壳+工具+终端”几乎同构) / SWE-bench (2310.06770) 用**可执行判据**（跑测试/终态匹配）自动打分；**τ-bench** (2406.12045) 的 **pass^k**（重复 k 次全过率，SOTA pass^8 常 <25%）量化一致性；LLM-as-judge (2306.05685) 评非黑白输出（需防裁判偏置）。

**怎么做**：建最小 eval 套件（每任务 = 初始环境 + 目标 + 程序化验收），整套 harness 端到端跑自动打分，直接借 Terminal-Bench/Harbor 的任务格式；引 pass^k；**放 Docker 沙箱跑**（顺带落地方向 1 的隔离）。以后每次改动都有客观回归标尺。

---

### 方向 4 · 43 条确认缺陷修复批

见 **第三节全表**。建议分三批：**中危先（22）→ 低危（8）→ 改进点（13）**。

**六个 quick win（半天～两天、零风险、先做）**：
- **#4** 流式重试漏算 reasoning（我上次引入的，先修）
- **#22 / #29** `.env` 值不剥引号 / 不去 UTF-8 BOM → 401（很多人会踩）
- **#10** `save_session` 清理按 mtime 无 tiebreaker（NTFS ~75% 撞车会删掉当前会话）
- **#1** 压缩纳入回滚保护（失败轮别永久有损压历史）
- **#17** schedule 子进程启动失败无历史、裸 traceback → 兜一条历史
- **#20** jobs POSIX 缺 SIGKILL 兜底 → 复用 schedule 的两阶段杀

---

### 方向 5 · Agent 能力升级（大方向，分阶段 M4~M6）

**现状**：纯反应式工具循环，无规划/反思/进度感知，`MAX_TOOL_ROUNDS=20` 是唯一（最粗的）刹车。

**SOTA 依据**：ReAct (2210.03629) 显式 thought-then-act；**Reflexion** (2303.11366) 失败→口头复盘→写记忆→下轮改进；**ADaPT** (2311.05772) 卡住才递归拆子任务；**LATS** (2310.04406) 用 LM 价值函数评进度；Huang《Cannot Self-Correct Reasoning Yet》(2310.01798)——**自纠必须靠外部信号**，纯内在自评会变差；MemGPT 记忆分层；Anthropic《多 agent research system》orchestrator-worker（并行 + 结构化规约 + 引用式聚合，约 15x token）；UltraHorizon (2509.21766) 的 **in-context locking**（原地打转）；MAST (2503.13657)——**缺 verification 是多 agent 头号失败**。

**怎么做（渐进，全部锚在“只信工具真实返回”纪律上）**：
1. **ReAct 显式轨迹**（最小）：循环里鼓励先产出 thought/plan 再决定 tool_call，thought 记入轨迹。
2. **Reflexion 反思-记忆闭环**：子 agent/后台任务失败或用户否定时，自动写一条“为什么失败、下次怎么改”进一个新的 **episodic 记忆区**（与现有 memory.json 事实区分层），下轮同类任务先读。
3. **进度感知停止**：每 K 步用一次轻量 LM + 外部信号（工具结果/测试）给“是否在推进”打分，连续无进展就换策略/清上下文/触发反思——替代 20 轮硬刹车；**停止判据锚在外部客观信号**，不让模型自评“我做完了”。任务收尾加一次独立 verification（MAST）。
4. **ADaPT 按需分解**：卡住才调已有子 agent 递归拆小。
5. **多 agent 升级**：并行 spawn + 结构化子任务规约（目标/输出格式/工具指引/边界）+ 大结果存共享区只回传轻量引用；嵌套上限从常量 2 改可配置；高价值易错任务可选 debate/投票。


---

## 三、确认缺陷全表（43 条 · 可勾选修复清单）

> 22 中危 · 8 低危 · 13 改进点 · 0 高危。每条已对抗验证，`位置`可直接跳代码。修复方向为要点，详细依据见审计原始 JSON。


### 循环与状态回滚

| # | 严重 | 缺陷 | 位置 | 修复方向（要点） |
|---|---|---|---|---|
| 1 | 中危 | 压缩(maybe_compact)在 try/回滚块之外先就地改写 history，本轮失败 | `harness/agent.py:133` | 把压缩纳入回滚保护：在 133 行 maybe_compact 之前先 pre=list(history) 做整表浅拷贝（连同 todos_ |
| 2 | 中危 | _handle_tool_call 对模型返回的重复 tool_call_id 不去重，同一 | `harness/agent.py:169` | 在 run_once 分发前（或 _handle_tool_call 入口）对本轮 assistant.tool_calls 做 id 规范 |
| 3 | 中危 | spawn_subagent 用父 ctx 的 _model_fn 句柄，父在流式 repl | `harness/tools.py:122` | 让子 agent 走"安静"模型句柄，而非复用父的流式打印句柄 |
| 4 | 低危 | BaseException 回滚只还原 history 和 todos，_denied_ca | `harness/agent.py:176` | 把 _denied_calls 和 _repeat 一并纳入回滚快照即可闭合不一致：在 agent.py:134-135 进入 try 前  |
| 5 | 低危 | 流式 model_fn 被中断时，on_delta 已打印到终端的半截正文不会进入 hist | `harness/agent.py:304` | history 内部仍自洽、不会毒化 API/resume（回滚是有意为之，避免留悬空 tool_calls），故非高危；但它连"用户自己刚 |

### 传输与流式

| # | 严重 | 缺陷 | 位置 | 修复方向（要点） |
|---|---|---|---|---|
| 6 | 中危 | 流式重试把 reasoning-only + 断线误判为「一个字没吐」→ 重试重复生成/重复 | `harness/kimi_client.py:167` | 把 reasoning_content 纳入"已生成"判定：在 reassemble_stream 返回结构里透出 reasoning（或  |
| 7 | 中危 | 流式读循环无自身超时，永久阻塞只靠 curl 的 speed-time 兜底，可被慢速/ke | `harness/kimi_client.py:153` |  |
| 8 | 中危 | speed-time 空闲失速阈值等于总 timeout(默认90s)，首字节前的服务端静默 | `harness/kimi_client.py:79` | 两点：(1) speed-time 与总 timeout 解耦——空闲失速阈值应远小于 timeout（如设为 15~30s 的独立常量）， |
| 9 | 改进点 | 非流式 _post 用 encoding='utf-8' 但未设 errors='repla | `harness/kimi_client.py:102` | 给 harness/kimi_client.py:98-105 的 subprocess.run 补 errors='replace'(与流 |

### 权限与安全护栏

| # | 严重 | 缺陷 | 位置 | 修复方向（要点） |
|---|---|---|---|---|
| 10 | 中危 | check() 的路径硬护栏只认名为 "path" 的参数，MCP 工具用别名参数即可绕过越 | `harness/permission.py:104` | 在 check() 里不再只认 'path' 键：对 args 中所有 str 型值（及 list[str] 展开）逐一过 _within_ |
| 11 | 中危 | run_command 敏感词子串扫描对合法命令产生不可撤销的误拒（硬 deny，连人都无法 | `harness/permission.py:114` | 两条路择一或并用：(A) 把 run_command 的敏感词命中从硬 deny 降级为 ask（可覆盖），让用户/--allow 能在确认 |
| 12 | 中危 | MCP 工具的执行结果与调用完全不走 safe_path，路径敏感/越界护栏对 MCP 工具 | `harness/tools.py:320` |  |
| 13 | 改进点 | .pub 豁免先于敏感前缀判定，导致 credentials.pub / secrets.p | `harness/permission.py:58` | 让 .pub 豁免不再无条件覆盖前缀设防：把早退拆成"先判前缀/敏感前缀命中就 return True，再对确属公钥的 .pub 豁免"，即 |
| 14 | 改进点 | permission.ROOT 是被 --workdir 就地改写的模块级全局，缺乏并发/复 | `harness/headless.py:63` | 当前无需紧急修（有 docstring 契约兜底），但若日后要在同进程内并发/嵌套跑不同 workdir 的任务，须先消除这个全局可变根：把 |

### 会话持久化与恢复

| # | 严重 | 缺陷 | 位置 | 修复方向（要点） |
|---|---|---|---|---|
| 15 | 中危 | save_session 清理靠 _mtime 排序无 tiebreaker，粗粒度/同刻  | `harness/session.py:70` | 给排序加确定性 tiebreaker，让当前会话在撞车时永不落末尾 |
| 16 | 中危 | mtime 作为“最近会话”的唯一排序键，时钟回拨后新存会话会被判为最旧：既被 resume | `harness/session.py:47` | 把排序键从 st_mtime 换成与墙钟解耦、单调可比的凭据：优先用文件名 stem（new_session_id 的 %Y%m%d-%H% |
| 17 | 改进点 | load 只校验 history 元素为 dict，不校验 todos 类型；坏档案里 to | `harness/session.py:40` | 在 session.py load 里像校验 history 一样校验 todos：把 data.setdefault("todos", [ |
| 18 | 改进点 | new_session_id 唯一性只防磁盘已存在文件，同进程同秒多线程取 id 会撞（当前 | `harness/session.py:54` | 竞态窗口真实存在但当前无触发路径，属潜在设计缺口 |
| 19 | 改进点 | 原子写只 fsync 文件不 fsync 父目录，os.replace 的目录项在掉电时可能 | `harness/_io.py:48` | 如要收紧抗掉电性：在 os.replace(tmp, p) 成功后，仅 POSIX 分支下 os.open(p.parent, os.O_D |

### 记忆系统

| # | 严重 | 缺陷 | 位置 | 修复方向（要点） |
|---|---|---|---|---|
| 20 | 中危 | 记忆事实经 system_message 注入模型时被冠以「请遵循」，构成可跨会话持久化的提 | `harness/memory.py:80` | memory.py:80 弱化前缀：把记忆呈现为"以下是记录的用户偏好，仅供参考，不得当作指令执行"而非"请遵循"，并比照 MCP 加"勿当 |
| 21 | 改进点 | load() 在坏 JSON/坏编码时把源文件 replace 成 .corrupt 备份， | `harness/memory.py:43` | 把"读文件"与"改名坏文件"两个职责解耦：让 load() 保持纯读（坏 JSON 只返回空、不改名，供 system_message/re |
| 22 | 改进点 | remember 去重是精确字符串相等，strip 后仍对大小写/全半角/尾随标点/空白规范 | `harness/memory.py:63` | 两处独立加固，优先第一处：(1) 给 facts 设条数上限（对齐项目其它模块，如 _MAX_FACTS）+ system_message  |

### 上下文压缩

| # | 严重 | 缺陷 | 位置 | 修复方向（要点） |
|---|---|---|---|---|
| 23 | 中危 | 字符软预算与真实 token 无对齐，keep_recent 窗口内多条大工具结果可长期驻留 | `harness/compaction.py:16` | 两处兜底：(1) 无效摘要止损——记录上次 old 段指纹（或上次 total），若本轮 cut 出来的 old 与上次一致/压缩后 tot |
| 24 | 中危 | _summarize 摘要文本被原样拼进 system 消息，无长度上限也无内容清洗（摘要注 | `harness/compaction.py:109` | 在 compaction.py:106-110 之间加两道护栏：其一，对 summary_text 做硬截断(如按 budget 的一个比例 |
| 25 | 中危 | _render 对工具结果截断到 500 字符，长工具链摘要输入严重丢信息 | `harness/compaction.py:48` | 别对工具结果做固定小截断喂摘要器 |
| 26 | 低危 | 子 agent 压缩时把内部摘要流式冲到用户屏幕（quiet_summarizer 护栏被绕 | `harness/agent.py:133` | 给 _spawn_subagent 调 run_once 时补上 summarizer 参数，传裸 kimi_chat（不带 on_delt |

### MCP 客户端

| # | 严重 | 缺陷 | 位置 | 修复方向（要点） |
|---|---|---|---|---|
| 27 | 中危 | _rpc 用 bufsize=1(行缓冲)配 text 模式,但对二进制/含 NUL 或超长 | `harness/mcp_client.py:60` | 在 _pump 层做有界读，替换裸的 `for line in stdout`：改用底层缓冲区按块读（os.read / proc.stdo |
| 28 | 改进点 | 超时/EOF 触发 close() 后,_pump_stdout 的 EOF 哨兵 None | `harness/mcp_client.py:95` | 机制对、当前无触发路径，按纵深防御补一刀即可：给 MCPClient 加 self._closed 标志，close() 里置真；_rpc  |
| 29 | 改进点 | connect_configured 对缺少 name/command 键的条目用 s["n | `harness/mcp_client.py:259` | L259 改为 s.get("name")/s.get("command") 并在缺 command 时抛带字段名的明确错误(如 raise |

### 定时调度 M3

| # | 严重 | 缺陷 | 位置 | 修复方向（要点） |
|---|---|---|---|---|
| 30 | 中危 | 子进程启动失败(OSError)在 run_task 里未被捕获：不写历史、抛裸 trace | `harness/schedule.py:261` | 给 run_task 启动与执行段加兜底：(a)246~250 锁获取补 except OSError 分支，落一条 outcome=loc |
| 31 | 中危 | 失败的 stop 会遗留 .stopped 标记，毒化该任务的下一次正常运行使其被误记为 i | `harness/schedule.py:314` | 两处收口：一是 stop_task 落标记前先验活——校验 child_pid 是否真在跑（不在跑就返回 False 且不写标记），最好顺带 |
| 32 | 中危 | stop_task 按 pidfile 里的 child_pid 无存活校验直接 taskk | `harness/schedule.py:315` | stop_task 杀之前先做三件事：显式判 pid 为 None 则清残留 pidfile、warn「没在跑」、返回 False；用 pi |
| 33 | 低危 | 执行历史 jsonl 无上限/无轮转，read_history 每次全量 read_text | `harness/schedule.py:174` | 二选一或并用：1) append_history 落盘后做轻量轮转——超过阈值（如 5000 行/2MB）时保留末 N 行重写或滚动到 .1 |
| 34 | 改进点 | 同名任务 remove 后再 add，新运行的历史会追加进旧任务遗留的同名 history  | `harness/schedule.py:154` | 给档案加稳定世代标识（add_task 生成 task_id=uuid，或直接复用 created_at）并写进每条 history 记录， |

### 后台任务与进程

| # | 严重 | 缺陷 | 位置 | 修复方向（要点） |
|---|---|---|---|---|
| 35 | 中危 | POSIX 端只发 SIGTERM 无 SIGKILL 兜底，不响应信号的子进程变孤儿；与  | `harness/jobs.py:37` | 把 schedule.py 的 _kill_tree 两阶段逻辑复用/照搬进 jobs.py 的 _terminate（或让 shutdow |
| 36 | 中危 | status() 读取输出尾部时先 read() 整个日志再切片，日志巨大时内存/性能坑 | `harness/jobs.py:90` | status() 读尾部改为 seek 到文件末尾附近再读：先 os.path.getsize 或 fh.seek(0, os.SEEK_E |
| 37 | 低危 | start() 中 Popen 抛异常时，已建的临时日志文件泄漏、永不清理 | `harness/jobs.py:68` | 在 start() 里把 Popen 包进 try/except：任何异常时先 os.remove(path)（吞 OSError）再 ra |
| 38 | 低危 | shutdown 串行 wait(timeout=5)，多个卡死任务令 atexit 最坏阻 | `harness/jobs.py:107` | 给 jobs._terminate/ shutdown 补上与 schedule.py 一致的两阶段杀：POSIX 端 killpg SIG |
| 39 | 改进点 | _MAX_JOBS 上限在所有任务都长命运行时失效，_JOBS 可无界增长 | `harness/jobs.py:57` | 把软上限改成硬背压：start() 在 len(_JOBS)>=_MAX_JOBS 且 _evict_finished 无可回收（全是运行中 |

### 无头/入口/配置/IO

| # | 严重 | 缺陷 | 位置 | 修复方向（要点） |
|---|---|---|---|---|
| 40 | 中危 | config .env 值不剥引号，KIMI_API_KEY="sk-xxx" 把引号带进  | `harness/config.py:34` | 在 _load_env_file 里 strip 空白后，若 value 首尾是成对的同种引号（"" 或 ''）则剥掉一层引号；引号内的内容 |
| 41 | 低危 | config .env 解析不剥 UTF-8 BOM，Windows 记事本存的 .env  | `harness/config.py:19` | config.py:19 改用 encoding='utf-8-sig'（能正常读无 BOM 文件、也自动剥 BOM，无副作用）；在 tes |
| 42 | 低危 | --allow 里 mcp__ 前缀的工具名一律不校验，拼错也静默放行且不告警 | `harness/headless.py:64` | 把 mcp__ 名字的校验从 headless.py:64 挪到 connect_configured() 之后：no_mcp=True 时 |
| 43 | 改进点 | permission.ROOT 是模块级全局可变态，run_headless 用 workd | `harness/headless.py:57` | 当前无需紧急修（有「独占进程」契约兜底） |
---

## 四、调研来源附录（8 方向 · 82 来源 / 70 已 WebFetch 核实）

> ✅=WebFetch 亲自打开核实；⚠=检索确认存在但未亲自抓取全文。链接均为真实 URL。


### 智能体架构基础与综述（ReAct / Reflexion / 认知架构 / LLM agent survey / 设计模式）

- ✅ **ReAct: Synergizing Reasoning and Acting in Language Models**（2022 (ICLR 2023)）— https://arxiv.org/abs/2210.03629
- ✅ **Reflexion: Language Agents with Verbal Reinforcement Learning**（2023 (NeurIPS 2023)）— https://arxiv.org/abs/2303.11366
- ✅ **MemGPT: Towards LLMs as Operating Systems**（2023）— https://arxiv.org/abs/2310.08560
- ✅ **Cognitive Architectures for Language Agents (CoALA)**（2023 (TMLR 2024)）— https://arxiv.org/abs/2309.02427
- ✅ **The Rise and Potential of Large Language Model Based Agents: A Survey**（2023 (Science China Info Sci 2024)）— https://arxiv.org/abs/2309.07864
- ✅ **A Survey on Large Language Model based Autonomous Agents**（2023 (Frontiers of Computer Science 2024, 持续修订至2025)）— https://arxiv.org/abs/2308.11432
- ⚠ **Building Effective Agents**（2024）— https://www.anthropic.com/research/building-effective-agents
- ⚠ **The Landscape of Emerging AI Agent Architectures (Agentic Design Patterns 综述)**（2024）— https://arxiv.org/abs/2404.11584

  相对该方向 SOTA 我们缺：
  - 无显式 Planning 模块：小蛇是纯反应式工具循环，缺『先把任务分解成计划、再逐步执行』的能力。Wang/Xi/Masterman 三份综述都把 Planning 列为核心模块，SOTA agent 普遍有 plan-then-act 或 decomposition。
  - 无 Reflection / 自我纠错闭环：有被动记忆但没有 Reflexion 式『失败→口头反思→写回记忆→下轮改进』的试错学习环，也没有 Evaluator-Optimizer(生成后自评审再改)模式。
  - 上下文管理是单向有损压缩，缺 MemGPT 式主动分页：旧史压成摘要后无法回捞原文；SOTA 做法是分层内存+按需换页(主存/外存)，且按 token 而非字符计量。
  - 记忆分层不完整(对照 CoALA)：只有工作记忆+语义事实记忆，缺情节记忆(episodic，存整段经历供反思)与程序记忆(procedural，可复用技能/流程)。
  - 多 agent 只有同步阻塞子 agent，缺协作拓扑：无 Orchestrator-Worker 动态派活、无 agent 间通信/消息传递、无并行编排——Xi/Masterman 综述都把多 agent 协作与通信风格列为关键维度。
  - 无 Perception / 显式 Profiling：几乎无环境感知与多模态输入(Xi 的 Perception 维度空白)，角色设定只靠隐式 system prompt 而非 Wang 综述强调的显式 Profiling 模块。

### 记忆与上下文工程（Memory & Context Engineering）

- ✅ **MemGPT: Towards LLMs as Operating Systems**（2023）— https://arxiv.org/abs/2310.08560
- ✅ **Effective Context Engineering for AI Agents**（2025-09-29）— https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- ✅ **Context Engineering for AI Agents: Lessons from Building Manus**（2025-07-18）— https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- ✅ **Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory**（2025 (ECAI 2025)）— https://arxiv.org/abs/2504.19413
- ✅ **Zep: A Temporal Knowledge Graph Architecture for Agent Memory**（2025）— https://arxiv.org/abs/2501.13956
- ✅ **LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory**（2024 (ICLR 2025)）— https://arxiv.org/abs/2410.10813
- ✅ **Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks**（2026）— https://arxiv.org/abs/2601.06007
- ✅ **RAG-MCP: Mitigating Prompt Bloat in LLM Tool Selection via Retrieval-Augmented Generation**（2025）— https://arxiv.org/abs/2505.03275

  相对该方向 SOTA 我们缺：
  - 按字符压缩太粗：小蛇把整段旧史压成一个摘要，粒度粗且不可逆；SOTA 做法是选择性 tool-result clearing（只清原始工具输出、保留架构决策/未解问题）+ context 外结构化笔记，信息损失小得多。
  - 无 token 计量：按字符估算会与真实 token 预算/成本脱节，也无法做 cache-aware 的预算决策；至少应接 provider 的 usage 或本地 tokenizer 计量。
  - 无 prompt caching / 前缀不稳定：这是生产 agent 头号成本杠杆（命中 vs 未命中约 10x）。小蛇需保证系统提示+工具定义前缀稳定（无时间戳等动态串）、消息只追加、动态工具结果放末尾。
  - 记忆是平铺 JSON、无演化：memory.json 只是全量存取，缺『抽取显著信息→冲突消解/更新旧事实→按相关性检索注入』的管线（Mem0/Zep 路线），长期会膨胀且注入无关记忆。
  - 工具声明全量注入：接 MCP 后工具变多会 prompt bloat 且降选择准确率；缺按需检索/子集暴露工具的机制（RAG-MCP），且要与『别动态删工具毁 KV-cache』协调（用屏蔽而非移除）。
  - 无记忆/压缩的评测：压缩是否丢了关键信息、记忆召回好不好，目前全靠人肉；缺 LongMemEval 式回归基准来客观验收。
  - 无文件系统/外置记忆作为可逆压缩层：SOTA（Manus）把 workspace 当无限外存，压缩时丢内容留路径/URL 可回取；小蛇压缩即丢，不可逆。

### 工具使用 / 函数调用 / MCP（tool use, function calling, Model Context Protocol）

- ✅ **ReAct: Synergizing Reasoning and Acting in Language Models**（2022）— https://arxiv.org/abs/2210.03629
- ✅ **Toolformer: Language Models Can Teach Themselves to Use Tools**（2023）— https://arxiv.org/abs/2302.04761
- ✅ **ToolLLM: Facilitating Large Language Models to Master 16000+ Real-world APIs**（2023）— https://arxiv.org/abs/2307.16789
- ✅ **τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains**（2024）— https://arxiv.org/abs/2406.12045
- ✅ **Berkeley Function Calling Leaderboard V3 (BFCL V3) — Multi-Turn & Multi-Step**（2024）— https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html
- ✅ **MCP-Zero: Active Tool Discovery for Autonomous LLM Agents**（2025）— https://arxiv.org/abs/2506.01056
- ✅ **Model Context Protocol — Specification (2025-06-18)**（2025）— https://modelcontextprotocol.io/specification/2025-06-18
- ✅ **MCPSecBench: A Systematic Security Benchmark and Playground for Testing Model Context Protocols**（2025）— https://arxiv.org/abs/2508.13220
- ✅ **Repairing Tool Calls Using Post-tool Execution Reflection and RAG**（2025）— https://arxiv.org/abs/2510.17874
- ⚠ **TIDE-Bench / When Tools Fail: Benchmarking Dynamic Replanning and Anomaly Recovery（工具失败恢复类近期基准）**（2026）— https://arxiv.org/pdf/2606.05806

  相对该方向 SOTA 我们缺：
  - 无工具级错误恢复回路：小蛇把工具报错原样回给模型就结束，缺『错误→检索该工具排障知识(RAG)→带上下文重试』的结构化恢复（对标 2510.17874 / ReAct 的异常处理），也缺 ToolLLM 的 DFSDT 式失败回溯/多路径探索。
  - 工具注入即上下文膨胀：接多个 MCP server 后所有工具 schema 一次性塞进 prompt，既贵又降低选择准确率。缺 MCP-Zero 式『工具注册表 + 语义检索按需加载』层。
  - 缺参数/工具存在性校验：无 BFCL V3 的 Missing Functions / Missing Parameters 处理——工具不存在时应拒绝而非硬凑，参数缺失时应追问而非幻觉填值；小蛇权限闸门只判『能不能做』，不判『参数是否被模型编造』。
  - MCP 面向不可信 server 的防线薄弱：现行规范明确『工具注解须视为不可信』，MCPSecBench 显示 tool poisoning / 工具描述里的间接 prompt injection 现有防护拦截率<30%。小蛇有敏感文件硬拒，但对『被污染的工具描述诱导调危险工具』『server 返回内容夹带指令』无专门防御。
  - MCP 客户端能力不完整：只实现了 stdio + Tools 调用，缺 Resources/Prompts 原语、缺 client 侧 Roots/Elicitation/Sampling、缺 streamable HTTP 传输——按 2025-06-18 规范只算最小子集。
  - 无 agent 级可靠性度量：完全没有 τ-bench 式 pass^k 一致性 + 策略遵从度评测。SOTA 早已证明工具agent『单次对、多次不一致』是主要失效模式，小蛇现在连这把尺子都没有。

### 多智能体协作与编排（Multi-Agent Collaboration & Orchestration）

- ✅ **AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation**（2023）— https://arxiv.org/abs/2308.08155
- ✅ **MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework**（2023 (ICLR 2024)）— https://arxiv.org/abs/2308.00352
- ⚠ **CAMEL: Communicative Agents for "Mind" Exploration of Large Language Model Society**（2023）— https://arxiv.org/abs/2303.17760
- ✅ **ChatDev: Communicative Agents for Software Development**（2023 (ACL 2024)）— https://arxiv.org/abs/2307.07924
- ⚠ **Improving Factuality and Reasoning in Language Models through Multiagent Debate**（2023 (ICML 2024)）— https://arxiv.org/abs/2305.14325
- ✅ **How we built our multi-agent research system**（2025）— https://www.anthropic.com/engineering/multi-agent-research-system
- ✅ **OpenAI Swarm / Agents SDK（routines + handoffs 原语）**（2024-2025）— https://github.com/openai/swarm
- ⚠ **LangGraph 多智能体编排：Supervisor 与 Swarm 两种模式**（2025-2026）— https://docs.langchain.com/oss/python/langchain/multi-agent
- ✅ **Multi-Agent Collaboration Mechanisms: A Survey of LLMs**（2025）— https://arxiv.org/abs/2501.06322
- ⚠ **GAIA: a benchmark for General AI Assistants**（2023）— https://arxiv.org/abs/2311.12983

  相对该方向 SOTA 我们缺：
  - 无并行子 agent：小蛇是'同步阻塞单分身'，Anthropic/AutoGen/LangGraph 都靠并行 spawn 多个 subagent 换取最高 90% 提速；串行是硬瓶颈。
  - 无结构化子任务规约：SOTA 给每个子 agent 下发'目标+输出格式+工具指引+任务边界'（Anthropic）或 SOP/结构化中间产物（MetaGPT）；小蛇靠自由文本派活，易重复劳动/漏活/跑偏。
  - 结果聚合是'电话传话'：小蛇子 agent 结果直接文本回传父 agent，易失真。SOTA 用共享消息池（MetaGPT）或大结果存外部、只回传轻量引用（Anthropic）。
  - 无编排拓扑抽象：只有'父调子'一种硬编码，缺 supervisor/swarm/debate 等可选编排模式，也缺 handoff 原语（Swarm）让子 agent 去中心化交接。嵌套上限写死为常量 2 而非可配置策略。
  - 无成本/触发判据与 token 计量：多 agent 吃约 15x token（Anthropic），小蛇既无'何时该上多 agent'的判据，又按字符而非 token 计量、无 prompt caching，成本控制在多 agent 下会失控。
  - 无断点恢复与上下文续航：SOTA 从 checkpoint 恢复、上下文将满时 spawn 干净上下文的新子 agent 续航（Anthropic）；小蛇后台任务不跨重启、无子 agent 级 checkpoint。
  - 无编排效果评测：缺 GAIA/AgentBench 类端到端基准来量化'多 agent 是否真比单 agent 强'，无法用契约方式验收编排收益。
  - 无自主协作护栏：CAMEL 揭示的角色漂移/无限循环/提前假完成等失败模式，小蛇的子 agent 若放开多轮自主协作将直接踩中。

### 安全：提示注入与沙箱隔离（Prompt Injection & Sandbox Isolation）

- ✅ **Defeating Prompt Injections by Design (CaMeL: CApabilities for MachinE Learning)**（2025）— https://arxiv.org/abs/2503.18813
- ✅ **Design Patterns for Securing LLM Agents against Prompt Injections**（2025）— https://arxiv.org/abs/2506.08837
- ✅ **InjecAgent: Benchmarking Indirect Prompt Injections in Tool-Integrated Large Language Model Agents**（2024）— https://arxiv.org/abs/2403.02691
- ✅ **AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents**（2024）— https://arxiv.org/abs/2406.13352
- ✅ **Adaptive Attacks Break Defenses Against Indirect Prompt Injection Attacks on LLM Agents**（2025）— https://arxiv.org/abs/2503.00061
- ✅ **Making Claude Code more secure and autonomous with sandboxing（含 @anthropic-ai/sandbox-runtime）**（2025）— https://www.anthropic.com/engineering/claude-code-sandboxing
- ✅ **SecAlign / StruQ: Defending Against Prompt Injection with Structured Queries & Preference Optimization**（2024）— https://arxiv.org/abs/2410.05451
- ⚠ **MCP Tool Poisoning Attacks / MCP has prompt injection problems（Invariant Labs 披露）**（2025）— https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/
- ✅ **ReAct: Synergizing Reasoning and Acting in Language Models**（2022）— https://arxiv.org/abs/2210.03629

  相对该方向 SOTA 我们缺：
  - 无真沙箱是最大硬伤：run_command 直接在宿主执行，靠命令子串黑名单当安全边界——而《Adaptive Attacks》(2503.00061)证明这类启发式在针对性绕过下成功率>50%基本失效。SOTA 是 OS 级隔离(bubblewrap/Seatbelt/gVisor/microVM)，且要把‘子进程’也纳入隔离。
  - 无出站网络管控：小蛇 curl 直接出网，注入成功后可任意外传数据。Anthropic 沙箱的关键设计是‘网络只走白名单代理’，小蛇完全缺这层，敏感文件硬拒也挡不住经网络外传。
  - 单 LLM 直吃不可信工具返回，只加提示前缀——没有数据来源/污点(taint)标签，也没有‘源自不可信数据的高危动作强制升级确认’的数据流约束。CaMeL 与 6 大设计模式的共同结论是：可靠防御必须让不可信内容进不了能触发动作的路径，而非靠提示。
  - MCP 侧只防‘输出’、不防‘工具描述/schema’，且多 server 同会话无隔离——正对 Invariant Labs 的 Tool Poisoning / Tool Shadowing 靶心。工具描述本身就是不可信输入，需纳入污点范围并做 server 命名空间与信任分级。
  - 完全没有安全回归评测：无法量化护栏是否真有效、改动是否引入回归。业界有现成骨架 InjecAgent(害用户/偷数据两类)和 AgentDojo(任务成功率 vs 攻击成功率双指标)可直接对标，小蛇却在闭门自证。
  - 子 agent 未被用作安全隔离原语：小蛇已有子 agent，但没给它‘无高危工具 + 只回结构化摘要 + 处理不可信源’的约束——白白错过 Dual-LLM / Map-Reduce 模式几乎零成本的落地机会。

### 编码智能体与顶尖开源项目

- ✅ **SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering**（2024）— https://arxiv.org/abs/2405.15793
- ✅ **mini-SWE-agent（The 100 line AI agent that scores >74% on SWE-bench verified）**（2025）— https://github.com/SWE-agent/mini-swe-agent
- ✅ **OpenHands: An Open Platform for AI Software Developers as Generalist Agents**（2024）— https://arxiv.org/abs/2407.16741
- ✅ **The OpenHands Software Agent SDK: A Composable and Extensible Foundation for Production Agents**（2025）— https://arxiv.org/abs/2511.03690
- ✅ **Executable Code Actions Elicit Better LLM Agents (CodeAct)**（2024）— https://arxiv.org/abs/2402.01030
- ✅ **smolagents: a barebones library for agents that think in code**（2024-2025）— https://github.com/huggingface/smolagents
- ✅ **Aider — Building a better repository map with tree-sitter**（2023）— https://aider.chat/2023/10/22/repomap.html
- ✅ **Cline — Autonomous coding agent（Plan/Act 模式与逐操作审批）**（2024-2026）— https://github.com/cline/cline
- ✅ **Goose（codename goose）— Block 开源 agent**（2025）— https://block.xyz/inside/block-open-source-introduces-codename-goose
- ✅ **Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems**（2026）— https://arxiv.org/abs/2604.14228
- ✅ **Effective context engineering for AI agents**（2025）— https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- ✅ **Effective harnesses for long-running agents**（2025）— https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- ✅ **Terminal-Bench: Benchmarking Agents on Hard, Realistic Tasks in Command Line Interfaces**（2026）— https://arxiv.org/abs/2601.11868
- ⚠ **Harness-Bench: Measuring Harness Effects across Models in Realistic Agent Workflows**（2026）— https://arxiv.org/html/2605.27922
- ✅ **SWE-bench: Can Language Models Resolve Real-World GitHub Issues?**（2023）— https://arxiv.org/abs/2310.06770

  相对该方向 SOTA 我们缺：
  - 无真沙箱/容器隔离：OpenHands 用 Docker runtime、smolagents 用 E2B/Docker、mini-SWE-agent 把执行抽象成可替换的 subprocess→docker exec。小蛇执行与本地环境耦合、命令子串扫描可绕，是最突出的安全短板。
  - 上下文工程偏原始：小蛇按『字符预算把旧史压成摘要』；SOTA（Claude Code 五层 compaction 按 token 占用约 92% 触发、保架构决策丢工具输出；Aider 用 tree-sitter+图排序做 repo map；Anthropic 三技法）都是按 token 计量 + 结构化取舍 + 主动的代码库地图。小蛇缺按 token 计量、缺 repo map、缺结构化 note-taking。
  - 工具缺『ACI 人体工学』：SWE-agent 证明编辑即校验（写后自动 lint 回灌错误）、有边界的分页/搜索显著提升成功率。小蛇工具偏原样暴露，缺防错反馈闭环。
  - 权限交互不如 SOTA 细：Cline 展示 diff 后再批准 + Plan/Act 只读探索分离；Claude Code 强调『推理与权限执行是不同代码路径』防越狱绕过。小蛇三态权限缺 diff 预览、缺 Plan/Act 分离，且需确认闸门不被模型输出绕过。
  - 无多 provider/模型路由 + 未暴露为服务：OpenHands SDK 有 multi-LLM routing + REST/WebSocket、Goose 30+ provider、smolagents 走 LiteLLM。小蛇只接 Kimi、单机、无服务接口。
  - 缺长任务的续接/恢复仪式与客观基准：Anthropic harness 指南的 init.sh+progress 文件+git 基线+先验证再实现+以 commit 为回滚单元，小蛇都没有；也缺 Terminal-Bench/SWE-bench 这类容器化+验证测试的量化标尺，验收仍靠人工契约。

### 评估 / 可靠性 / 自我纠错（Agent Eval, Reliability & Self-Correction）

- ✅ **SWE-bench: Can Language Models Resolve Real-World GitHub Issues?**（2023 (ICLR 2024)）— https://arxiv.org/abs/2310.06770
- ✅ **τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains**（2024 (ICLR 2025)）— https://arxiv.org/abs/2406.12045
- ✅ **τ²-Bench: Evaluating Conversational Agents in a Dual-Control Environment**（2025）— https://arxiv.org/abs/2506.07982
- ⚠ **GAIA: A Benchmark for General AI Assistants**（2023）— https://arxiv.org/abs/2311.12983
- ⚠ **WebArena: A Realistic Web Environment for Building Autonomous Agents**（2023）— https://arxiv.org/abs/2307.13854
- ⚠ **AgentBench: Evaluating LLMs as Agents**（2023 (ICLR 2024)）— https://arxiv.org/abs/2308.03688
- ✅ **Terminal-Bench (Core / 2.0) + Harbor 评测框架**（2025）— https://www.tbench.ai/news/tb-science-announcement
- ✅ **Does SWE-Bench-Verified Test Agent Ability or Model Memory?**（2025）— https://arxiv.org/abs/2512.10218
- ✅ **Reflexion: Language Agents with Verbal Reinforcement Learning**（2023 (NeurIPS 2023)）— https://arxiv.org/abs/2303.11366
- ✅ **Self-Refine: Iterative Refinement with Self-Feedback**（2023 (NeurIPS 2023)）— https://arxiv.org/abs/2303.17651
- ✅ **Large Language Models Cannot Self-Correct Reasoning Yet**（2023 (ICLR 2024)）— https://arxiv.org/abs/2310.01798
- ✅ **Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena**（2023 (NeurIPS 2023)）— https://arxiv.org/abs/2306.05685

  相对该方向 SOTA 我们缺：
  - 零真实任务级 eval:小蛇只有单测(验单个函数/契约)+对抗复盘(人工想攻击),完全没有'把整套 harness 丢进真实任务集、用可执行/终态判据自动打分'的评测——SWE-bench / Terminal-Bench / τ-bench 都是这种。
  - 无可靠性/一致性度量:我们的验收是'单次通过'。SOTA 已用 pass^k(重复 k 次全过率)量化稳定性,τ-bench 显示 SOTA agent pass^8 常<25%。小蛇没有任何抗随机性/一致性指标。
  - 无执行判据式验收:主流 eval 靠'跑测试通过'或'数据库终态匹配'客观判分;小蛇靠中文测试名+人读契约,主观且不可规模化。
  - 无隔离沙箱做 eval:Terminal-Bench 用 Docker 沙箱跑 agent;小蛇已知'无真沙箱',既是安全短板也让 eval 无法安全地跑真实破坏性任务。
  - 无自我纠错回路:有记忆但没有'工具/测试失败 → 结构化反思 → 回灌下一次尝试'(Reflexion 式)的闭环;且缺'自纠必须依赖外部反馈'这一被 DeepMind 论文证实的设计原则的落地。
  - 无防数据污染意识:一旦自建 eval,若照搬公开基准会踩 SWE-bench-Verified 那种记忆/污染坑;我们尚无私有任务/时间切分/变体生成等防污染机制。
  - 无 LLM-as-judge 评非黑白输出的能力:对'解释质量/交互体验'这类没有可执行判据的维度,缺自动评审手段(且需防裁判偏置)。

### 长程自治 / 规划 / 何时停（long-horizon autonomy · planning · stopping criteria · 成本护栏）

- ✅ **ReAct: Synergizing Reasoning and Acting in Language Models**（2022）— https://arxiv.org/abs/2210.03629
- ✅ **Reflexion: Language Agents with Verbal Reinforcement Learning**（2023 (NeurIPS 2023)）— https://arxiv.org/abs/2303.11366
- ✅ **Tree of Thoughts: Deliberate Problem Solving with Large Language Models**（2023 (NeurIPS 2023)）— https://arxiv.org/abs/2305.10601
- ✅ **Language Agent Tree Search Unifies Reasoning Acting and Planning (LATS)**（2023 (ICML 2024)）— https://arxiv.org/abs/2310.04406
- ✅ **ADaPT: As-Needed Decomposition and Planning with Language Models**（2023 (NAACL 2024 Findings)）— https://arxiv.org/abs/2311.05772
- ✅ **MemGPT: Towards LLMs as Operating Systems**（2023）— https://arxiv.org/abs/2310.08560
- ✅ **Large Language Models Cannot Self-Correct Reasoning Yet**（2023 (ICLR 2024)）— https://arxiv.org/abs/2310.01798
- ✅ **Building Effective Agents（工程实践指南）**（2024）— https://www.anthropic.com/engineering/building-effective-agents
- ✅ **UltraHorizon: Benchmarking Agent Capabilities in Ultra Long-Horizon Scenarios**（2025）— https://arxiv.org/abs/2509.21766
- ✅ **Why Do Multi-Agent LLM Systems Fail? (MAST 失败分类法)**（2025）— https://arxiv.org/abs/2503.13657

  相对该方向 SOTA 我们缺：
  - 无进度评估 / 无价值信号：小蛇靠 MAX_TOOL_ROUNDS=20 硬刹车，没有任何『是否在朝目标推进』的判据。SOTA（LATS 的 LM 价值函数、Anthropic 强调的每步 ground truth）都用外部反馈评估进度来决定继续/回退/停止。
  - 无目标分解 / 无规划层：纯线性一问一答，缺 ADaPT 式『卡住才递归拆子任务』或 plan-and-execute 的规划层，复杂长任务只能一路撞到轮数上限。
  - 无失败反思外循环：有跨会话记忆但没有 Reflexion 式『失败→口头复盘→带教训重试』，也没有『内在自评无效需靠外部信号』（Huang 2023）的纪律，纠错能力弱。
  - 无循环/停滞检测：UltraHorizon 的『in-context locking』正是小蛇会踩的坑——重复动作、原地打转无人察觉、无机制打破。缺『连续 N 步无进展则换策略/清理上下文/触发反思』。
  - 被动字符压缩 vs 主动分级内存：长轨迹（数百次工具调用）下一刀切字符摘要会丢关键状态。缺 MemGPT 式让 agent 主动决定写入/调回外部记忆。
  - 停止判据与成本护栏太粗：只有轮数上限，缺 token/成本预算护栏、不可逆动作前的人类检查点、以及任务完成后的独立验证步（MAST 头号失败：无 verification），验证既是质量也是可靠的『何时停』信号。
---

## 五、下一步怎么走
1. **先清 6 个 quick win**（方向4，含修我引入的 #4）——半天到两天、零风险、稳地基。
2. **方向1 安全 + 方向2 上下文成本 双主线推进**——两条既补 SOTA、又兜住最多审计条，是最高价值处。每条我都能出到“可 TDD 的实现方案”粒度。
3. **方向3 eval 搭最小骨架**——之后每次改动有客观标尺（pass^k + Docker 沙箱）。
4. **方向5 能力升级**留作 M4~M6 正题，按 ReAct→Reflexion→进度感知停止→分解→多 agent 渐进。

> 原始材料：代码审计 43 条（含每条完整代码依据/验证依据/修复方向）与调研 82 来源的完整结构化结果，存在会话产出里，需要时可展开任意一条到实现级。
