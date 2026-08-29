# 壳对比 · 小蛇 × Hermes × OpenClaw · 可学点

> 方法：**直接读两个开源 agent 的真源码**（不靠网上二手介绍），6 个并行考古 agent 按维度深挖 + 合成。
> Hermes = NousResearch 的 `hermes-agent`（**Python**、MIT、原生 Windows、自称"唯一自带学习闭环"）——与小蛇同语言、可比性最高。
> OpenClaw = `openclaw/openclaw`（TS、字节/飞书、多渠道个人助理、~40 技能）。
> 状态：**探索/可学点记录，先不做，待拍板取用。**

## 0. 三个壳一句话
- **小蛇**：Python 标准库、近零依赖、单用户终端、Kimi 主脑、自己干活、原生 UIA/WinRT 视觉。**窄而硬。**
- **Hermes**：Python、多 provider、六执行后端(local/docker/ssh/modal/daytona/singularity)、自学习闭环(自造技能+curator 记忆)、PTC 脚本调工具、六聊天渠道、TUI。**功能极全的"研究级"agent（还兼训练数据生成 harness）。**
- **OpenClaw**：TS 巨型 monorepo、Gateway 控制面、20+ 聊天渠道、多设备节点、技能注册中心 ClawHub、委派给别的 coding agent。**"个人助理"生态，最宽。**

---

## 1. 🥇 头号发现：PTC「脚本经 RPC 调工具」——对 Kimi 最大的省钱杠杆（全新、不在计划）
**Hermes `tools/code_execution_tool.py`**：注册一个 `execute_code` 工具。父进程按已启用工具生成一个 `hermes_tools.py` 桩模块，spawn 子进程跑模型写的脚本；脚本里 `from hermes_tools import web_search, terminal` 调工具 → 走 RPC 回父进程、**用与普通工具调用相同的 dispatch 派发（审批/安全照旧生效）**；**只有脚本 stdout 回灌给模型，所有中间工具结果永不进上下文**。模型被 description 硬判据引导："≥3 个工具调用且中间有处理逻辑 / 要过滤大输出 / 要条件分支或循环 → 用 execute_code；单个无处理的调用 → 用普通工具"。
- **对小蛇**：现在"每工具=一轮 API + 上下文越滚越贵"，10 步管线=10 次 Kimi 计费请求。PTC 压成 **1 轮**。**这是小蛇当前架构最大的省钱点。**
- **能落，且比 Hermes 简单**：小蛇单用户 Python，不必上 subprocess+socket——脚本走**进程内回调**（同进程函数调用、零序列化）。**但绝不用裸 `exec`**：PTC 从第一版起就**与 CaMeL 受限解释器绑成同一次施工**（`ast.parse` 解析 + `NodeVisitor` 受限执行、禁 `import`/禁属性访问逃逸/节点白名单），**不存在"先裸 exec 跑通、后加固"的中间版**——只看本文的施工者若先发一个不安全的 `exec` 版，正是这里要堵死的洞。交叉引用：见 **[[A11 六维前沿]] 乙4/乙5 + Top5#1**（受限解释器是 PTC 的前置硬约束，不是后续优化项）。
- **PTC 桩不能直接回调 `tools.execute`**（它不做权限检查、会绕过审批/污点）：`xiaoeshe_tools.*` 桩必须复用现有 `_handle_tool_call` 的**完整权限/污点管道**（审批、taint_gate、命令硬扫照旧生效），与普通工具调用同走一条 dispatch。务必照搬两条 description 判据 + "只回 stdout"语义。要真沙箱隔离再上 subprocess。
- 不要抄它的远程文件式 RPC（req_/res_ 轮询跑 Docker/Modal）——多后端才需要。

---

## 2. 直接喂现有计划的可学点

### → A2 自我扩展：Hermes/OpenClaw 给了完整落地蓝图
- **技能格式**（抄 Hermes `skill_utils.py` + OpenClaw `SKILL.md`）：`SKILL.md` = YAML 头(`name`+`description`≤60字)+ 正文 + 四类支持目录 `references/templates/scripts`；支持目录不当独立技能。
- **依赖自声明**（OpenClaw `metadata.openclaw.install:[{kind:brew/node,formula,bins}]` + `requires.bins/anyBins` + `os:["darwin"]`）：技能自带跨平台安装配方——正是"让 agent 自己装工具"要的。
- **⭐"用中自改进"= 后台 fork 写技能**（Hermes `background_review.py`）：每轮后若工具调用累积到阈值(=复杂任务)，fork 一个 daemon 子 agent、**工具白名单只留 memory+skill**、重放对话跑 review prompt、直接写技能库，主对话/缓存不受污染。**小蛇已有 spawn_subagent + Reflexion，接上成本极低**——这就是"看一遍就学会"想象跳跃的现成落地。
- **⭐禁抓负面断言**（review prompt）：别把"环境缺某二进制""X 工具坏了"这类负面断言固化成技能——几个月后会变成 agent 自我引用的拒绝理由。**直接治小蛇 episodic 教训"越攒越像自缚"的病。**
- **/learn 零依赖思路**：没有独立蒸馏引擎，只构造一个 prompt 让活着的 agent 用现有工具自己写 SKILL.md。契合近零依赖。
- **Curator 生命周期**（`curator.py`）：自造技能 active→stale→archived，纯函数按时间戳降级(无 LLM)、**只归档不删除、pinned 免疫、只动 created_by==agent**——给自造技能防腐+防膨胀的 GC。

### → A3 跨会话记忆：Hermes 给了双文件结构化范本 + 零依赖历史搜索
- **⭐双文件结构化**（`memory_tool.py`）：`MEMORY.md`(agent 的环境/项目/坑笔记)+ `USER.md`(用户偏好/沟通风格)。`§` 分隔条目、**字符数上限**(模型无关)、单 `memory(action=add/replace/remove)` 工具靠短唯一子串匹配。**冻结快照**：会话开始注入一次、中途写盘即持久但不改系统提示(保 prefix cache)、下会话才刷新——**比小蛇每会话重注入全量 200 条更省缓存**。
- **会话末/后台提炼回写**（`background_review.py`）：fork daemon 重放对话问"有什么值得存记忆吗？"，只聚焦①用户暴露的偏好②对我行为的期待，没有就回 "Nothing to save."。比小蛇 Reflexion(只失败时写)更主动——**成功会话也提炼**。
- **周期性 nudge**（`turn_context.py`）：整数计数器，每 N 个用户轮触发一次记忆复盘，计数从持久历史 hydrate(防 resume 后永不触发)。零模型成本，**直接抄**。
- **⭐FTS5 历史对话搜索**（`session_search_tool.py`）：SQLite + FTS5 全文索引，**纯 DB、零 LLM 调用**。**Python 标准库 `sqlite3` 自带 FTS5** → 小蛇零新依赖就能给历史会话加全文召回。
- **MemoryProvider 钩子清单**（`memory_provider.py`）：`on_session_end/on_pre_compress/on_delegation/on_memory_write`——即使不做插件，这是"何时该写记忆"的完整检查表。

### → A7 权限模式 + 持久放行
- **service-gated（check_fn）**（Hermes `registry.py`）：工具注册带 `check_fn`+`requires_env`，**没配好前置的工具模型根本看不见**——比小蛇"先暴露再闸门"干净。
- **权限档位**（OpenClaw）：`on|off|ask|full` 四档按会话切 + `allow-once|allow-always|deny` 三态，allow-always 落持久条目。
- **⭐持久放行绑上下文不绑工具名**（OpenClaw `ExecAllowlistEntry` = pattern+commandText+argPattern+cwd+lastUsedAt+lastResolvedPath）：小蛇现在按**工具名**放行(_approved_tools)太粗；跨会话持久应按**归一化命令模式 + cwd**存、记 lastUsedAt 供审计/过期。
- **凭据落盘 fail-closed**（Hermes `credential_persistence.py`）：写盘前脱敏，**只存 sha256 指纹不存明文**，白名单决定什么能落盘；撤销要"粘住"防重载复活。

### → compaction 升级（小蛇已有，可强化，Hermes `context_compressor.py`）
- ⭐**小上下文模型把压缩触发点抬到 75%**（`_effective_threshold_percent`，<512K）——**正对 Kimi 262K**，小蛇 50% 触发会因不可压地板反复抖动。**便宜快赢。**
- 按 **token 预算护尾** 而非固定 8 条；压缩前**廉价预压**（md5 去重工具结果、把旧工具输出换成一行 `[terminal] npm test → exit 0, 47 lines`、在解析后 JSON 内截断超长 tool_call 参数防 400）；**防抖动**（连续两次省<10% 就停）；结构化摘要模板 + **时间锚定**（已完成动作改写成过去时防重做）。
- **context_references**（`@file:path:12-40 / @git / @diff` 按需拉入，带 token 预算护栏 + 凭据 deny-list）：与小蛇 recall/blob 的"外置指针"正好组成"**输入侧按引用拉、输出侧按指针推**"对称体系。

### → 子 agent（喂 spawn/recall_subagent）
- **⭐"子 agent 摘要是自述、非已核实事实"**（`delegate_tool.py`）：要求子 agent 对有副作用操作返回可验证句柄(URL/ID/绝对路径/HTTP 状态)、父自行核验。+ 语言污染提醒。**直接抄进 recall_subagent 提示。**
- **leaf/orchestrator 角色隔离** + `max_spawn_depth`：防无限嵌套。
- **ACP 委派**：可把成熟外部 coding agent(copilot --acp/codex)当一个"provider"接进来，换脑不换壳。

### → 跨 Windows shell（小蛇也在 Win，值得自查，Hermes `local.py`）
`MSYS_NO_PATHCONV=1`(否则 Git Bash 把 `/FO` 改写成路径、`tasklist`/`schtasks` 崩)、优先便携 Git Bash 别命中 WSL bash(静默失败)、`npm→npm.cmd`(否则 WinError 193)、`stdin` 写字节绕 `\n→\r\n`、`CREATE_NO_WINDOW` 消黑窗。→ 合成后应核小蛇 run_command 在 Win 上 spawn 是否踩这几条。

### → 执行后端抽象（小蛇可轻量借，Hermes `tools/environments/base.py`）
`BaseEnvironment(ABC)`：子类只实现 `_run_bash()`+`cleanup()`，基类统一 `execute()`。小蛇可把 run_command 抽成 `execute(cmd)->{output,returncode}` 接口，默认只装 LocalEnvironment，未来接容器/远程无需改调用点。"每次 spawn 一个 `bash -c` + 一次性快照文件续传 env/cwd"比常驻 PTY 简单，适合近零依赖。

---

## 3. 🏆 小蛇反而更强 / 更干净（别妄自菲薄，也别抄它们的外壳）
- **命令文本硬扫**：Hermes `file_safety.py` 自认"读拒不是安全边界……模型总能 shell out"、**根本不扫命令文本**；OpenClaw 把 prompt injection 划在信任模型外。小蛇 `_cmd_hits` + SendKeys 展开 + glob 绕过检测 + press_keys/type_text 同扫——对单用户是实打实更密的网。**保留。**
- **污点追踪**：`taint_gate`(穷人版 CaMeL) 在 Hermes/OpenClaw **均无对应物**。小蛇的参数级污点更具体。
- **base64 图永不进 history**：架构级硬不变式；Hermes 无等价物，只能事后有损把图从 history 剥掉、靠字符数猜图 token 兜底。**小蛇更干净更硬。**
- **记忆原子写 + 损坏隔离 + git 冲突自动合并**：比 Hermes 更硬核。
- **摘要中和剔零宽/控制字符**：小蛇更 paranoid。
- **原生 UIA/WinRT 零坐标视觉、跨 Win/Mac**：OpenClaw 的 peekaboo 要 `brew install` 外部 CLI 且只 macOS；小蛇原生零依赖更硬。
- **近零依赖**：两者都是重装(OpenClaw 几百 npm 依赖 / Hermes 六后端+多 provider+Honcho SaaS)；小蛇 Python 标准库。

---

## 4. 设计哲学（Hermes `AGENTS.md`）= 独立印证 + 升级小蛇纪律
- **⭐Footprint Ladder（新能力决策阶梯）**：选能解决问题的最省那级——①扩现有代码 →②CLI+技能 →③服务门控工具 →④插件 →⑤MCP server →⑥新核心工具(最后手段)。**A2 该把这阶梯写进去。**
- **"边缘扩张、腰部收紧"**：产品表面放开长，但**核心 agent + 模型工具 schema 死守窄**（每个工具每次 API 都要带）。比"近零依赖"更聪明的分寸。
- **和小蛇半年教训高度重合**（=第三方独立验证）：E2E 真路径验证别只 mock、缓存/角色交替/系统提示字节稳定、验证前提再叫 bug、行为契约 vs 快照测试、.env 只放密钥。
- **一条能马上用的新戒律**：给模型读的**指令类内容(技能/提示/playbook)绝不分页**——模型会只读第 1 页跳过其余。小蛇 recall 对**数据**分页没错，但技能/指令要一次整读。

---

## 5. 明确不抄（过度设计，对单用户近零依赖是负担）
Honcho 辩证用户建模(SaaS+OAuth+网络)、六执行后端里的 modal/daytona/singularity/scale-to-zero(多租户云)、Gateway 多渠道 16 集成点、TUI 双进程(Node+React)、ClawHub/agentskills.io 多注册表聚合+发布流、credential_pool 109KB OAuth 全家桶、context 的 SQLite 分布式锁租约、远程文件式 RPC。**取判据/模板/接口骨架，别搬架构与实现。**

---

## 6. 🫀 看家本领·心跳 + 主动 + 学习闭环（甲方追问补挖，2026-07-12）
> 上面第 2 节的"自造技能"只挖到学习循环的一半；**心跳/routines/主动提议这一整块之前漏了，这里补全**。这才是 Hermes/OpenClaw 真正的看家本领——让 agent 从"你问才动"变成"主动帮你干活、还不烧钱"。

- **心跳本体 = `cron/scheduler.py` 的 `tick()`**：gateway 后台线程**每 60 秒调一次 `tick()`** 跑到期任务；跨进程文件锁，**Windows 走 `msvcrt`、Unix 走 `fcntl`**（跨平台已处理）。
- **Routines = 三种触发**（它明说比 Claude Code Routines 早俩月）：① cron 表达式/人话间隔 ② GitHub 事件(webhook 订阅) ③ API 触发(POST 带 HMAC 的 webhook 路由)；结果投递到任意平台。
- **⭐ Script injection + `[SILENT]`（`hermes-already-has-routines.md`）**：定时触发时**先跑一段便宜 Python 脚本**(抓取/diff/计算)，stdout 当上下文；脚本判定没变化就回 `[SILENT]`，**只有真有事才唤醒贵的模型**。→ 对按请求计费的 Kimi 是**省钱神器**：心跳很密但绝大多数 beat 只花几分钱跑脚本、不惊动模型。
- **⭐ Suggestions 主动建议自动化（`cron/suggestions.py`）**：Hermes **主动把"要不要设个定时任务"推给用户、一键接受**（consent-first；拒了 latch 不再骚扰）。来源含四类，其中 **`usage`=后台自改进 review 发现用户反复问同一件事 → 提议做成定时任务**。
- **`daemon_pool.py`（`DaemonThreadPoolExecutor`）**：daemon 线程池不阻塞解释器退出——治"wedged worker 让 CLI 退出卡几分钟"，正是小蛇踩过的"daemon 卡退出"的干净解，值得对照再核。
- **⭐⭐ 真正的闭环（两块接起来才是看家本领）**：**学习循环发现规律 → 主动提议一个定时任务 → 心跳跑它时用 `[SILENT]` 脚本过滤省钱**。一条"观察你→学到→主动帮你自动化且不烧钱"的循环。

### 🆕 新点子·睡眠时整理记忆（idle-time memory consolidation，甲方直觉提出）
把**空闲心跳**和**记忆整理**接起来：**agent 像人睡觉一样，趁空闲(idle 心跳)在后台跑一次"记忆巩固"**——合并重复、修正过时、剪枝、把散落的会话提炼进结构化项目大脑(A3)。
- 组件都现成：idle 检测(OpenClaw `scale_to_zero.go_dormant` 的空闲判定)+ 记忆整理(A3 提炼剪枝 + Hermes curator + `consolidate-memory` 式反思 pass)+ 心跳调度(小蛇已有 cron)。
- **成本要认账（不是免费）**：记忆巩固要调 Kimi 读/合并/改写，这些后台调用（睡眠整理、GEPA、心跳唤醒模型）与交互**从同一个 token 池扣、共享 5 小时滚动配额**——"空闲才整理"只是**错峰**（不占用户交互、避开忙时争抢），**不是不花钱**。故后台调用**必须设 token 预算闸门**（超预算就跳过这轮巩固），**成本看板要分列"后台/交互"**两条线，别把后台开销混进交互账。
- **写回并发安全**：后台记忆写入走**基于 id 的增量 delta（改哪条写哪条、不整份覆盖）**，并与交互态 `remember` **共用同一把锁**——否则后台持一份整份快照、跨多次 Kimi 调用（耗时长）后写回，会把这期间用户交互写入的记忆**整份盖掉（lost-update）**。
- 诚实：这是把之前分开提的"休眠 idle(省电)"+"会话末提炼(A3)"+"Hermes 后台学习"**合成一个连贯机制**，非现成论文，属想象补强，先记着。

### 小蛇现在到哪、缺哪（心跳维）
- **有底子**：M3 cron 调度(schtasks/launchd) + M4 后台任务(跨重启、pid 探活)。
- **缺的三点**：① **script-injection + `[SILENT]`**(便宜脚本过滤、只在有事时惊动模型) ② **suggestions**(主动提议自动化) ③ 学习的**主动写技能**(小蛇 Reflexion 只失败时写、且不主动造技能)。
- **睡眠整理记忆**：全新，把 idle + A3 提炼 + 心跳接起来。

## 推进排序（拍板用，都零/近零依赖、对着已知点）
1. **⭐PTC 脚本调工具（同进程回调最小版）**——最大省钱杠杆，压多步管线成 1 轮。新方向、值得最先评估。
2. **compaction 三连**（75% 触发点抬升 + token 预算护尾 + 防抖动）——便宜快赢，直接省钱抗抖。
3. **A2 自造技能闭环**（后台 fork 写技能 + 禁抓负面断言 + SKILL.md 格式）——把"看一遍就学会"落地，接现有 spawn_subagent。
4. **A3 记忆升级**（USER.md 维度 + 会话末提炼 + sqlite FTS5 历史搜索 + nudge 计数器）——全零依赖。
5. **子 agent 护栏两条**（自述非事实→要可验证句柄 / leaf-orchestrator 分级）——直接抄进 recall_subagent。
6. Windows shell 自查、A7 持久放行绑命令模式——排期。
7. **⭐ 心跳三件套**：给现有 cron 加 **script-injection + `[SILENT]`**(便宜脚本过滤、只在有事才唤醒模型)+ **suggestions**(主动提议自动化)+ **睡眠时整理记忆**(idle 心跳跑记忆巩固)——把小蛇从"你问才动"变成"主动帮你干活还不烧钱"，是"心跳+学习"的看家本领落地。

（来源：6 个并行考古 agent 读 `C:\Users\example\Desktop\壳对比\{hermes-agent-main,openclaw-main}` 真源码，文件佐证见各 agent 报告。关联 [[A2 自我扩展]] [[A3 跨会话项目记忆结构]] [[A7 权限模式]]。全部先不做、待拍板。）
