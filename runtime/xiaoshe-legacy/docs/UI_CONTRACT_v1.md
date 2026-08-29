# 小蛇界面 · UI 契约 v1（冻结 2026-07-26）

> 本文档是「小蛇界面」前后端协议契约的**归档版**，从实施 SPEC v2 的 §2/§3/§5/§7/§8/§10/§11 抽成独立文档。
> v1 冻结：枚举封闭、路由封闭、事件封闭。任何变更需先升契约版本，再改实现。
> 机器校验：`python tests/ui_contract/validate_contract.py`（三道：样例驱动 / 字段溯源 / 枚举封闭）。
> 枚举唯一事实来源双份逐字一致：`harness/ui_schema.py` 与 `ui/js/lib/enums.js`（校验脚本比对）。

## 0. 修订决议（D1–D18，对 PLAN §4 的仲裁）

| # | 决议 |
|---|---|
| D1 | 路由统一为「8 新增 + 5 固化 = 13 条」（另有 2 条配套端点，见 §4） |
| D2 | 记忆文件实际在 `ROOT/memory.json`（带 .lock 旁车），不在 .state/ |
| D3 | 记忆分区字段名 **`zone`**，枚举中文六值（见 §6 ZONE）；API 字段 `zone`/`by_zone` |
| D4 | 审批指纹规则四值：`path` / `command` / **`coords`**（click_at/pick 绑坐标，不跨会话持久）/ `bare` |
| D5 | /api/pick/diff 数据源 = tools.py 仪表化 `ctx['_pick_diff_last']`（五字段结构化） |
| D6 | 视口 `screenshot_ref`/`created_at` 由 tools.py look/zoom 建视口时回写注册表 record |
| D7 | compaction 事件 **WS 载荷用契约形状** `{before:{msgs,chars}, after:{msgs,chars}}`（桥接层映射）；JSONL 落盘字段名（before_msgs/…）不动 |
| D8 | 消息无 seq → 桥接层给每条消息派 **msg_id**（会话内单调 int，ui_server 持有）；快照尾页与后续 append 编号连续 |
| D9 | stall 由 agent.py 写 `ctx['_stall']={count,limit,at}`，快照层读取 |
| D10 | 子 agent 清单 = tools.py 仪表化 `ctx['_subagent_runs']`（上限 50，并行批次共享 batch_id） |
| D11 | 审批回调签名不变；request_id/resolved_path/tainted/force_ask 由**总线审批分支**组装（§5） |
| D12 | /api/tools 的 category/display/registry_rev 由 ui_schema.py 提供；registry_rev = 注册表工具名集 sha256[:12] |
| D13 | jobs tail 按**末 N 行**切（默认 20，上限 200；读 log_path，解码走 _io.decode_cmd_output 回退链） |
| D14 | 小抄 **worked_count=hits；nominated=promoted(bool)**（冻结钉名） |
| D15 | serve/ui_server/ui_token 等全部新建（预期内） |
| D16 | 技能 `enabled` 恒 true（存在即启用）；`steps_count`=数 SKILL.md 正文步骤行 |
| D17 | marks 的编号键在 JSON 序列化后为**字符串键**（Python int 键自然转换） |
| D18 | user_tools 待审体系 v1 **不并入** /api/skills/pending（仅 selflearn/skills 体系），记 backlog |

## 1. WS 协议（主通道）

### 1.1 信封

```json
{"v":1, "seq":123, "ts":"2026-07-26T10:42:03+08:00", "type":"...", "sid":"sess-0726-42", "payload":{...}}
```

- 下行每条由 ui_bus 派单调 `seq`（持锁自增）；客户端发现 seq 跳空 → 拉 `GET /api/state` + `GET /api/messages` 重同步。
- 上行 seq 填 0。ts = ISO 8601 带时区（秒级）。

### 1.2 事件类型表（17 种，枚举封闭：下行 12 + 上行 5）

| 方向 | type | payload |
|---|---|---|
| 下行 | `session.snapshot` | `{contract_v:1, messages_tail:[§1.3], state:{§3 全量十键}, pending_approvals:[§5], negotiated:{v:1}}` |
| 下行 | `message.append` | 单条消息（§1.3，含 msg_id） |
| 下行 | `tool_call.start` | `{call_id, name, args, permission:"allow\|ask\|deny", approval_key, reason?}` |
| 下行 | `tool_call.end` | `{call_id, status:"ok\|error\|denied", is_error, duration_ms}` |
| 下行 | `approval.request` | `{request_id, tool, args, reason, approval_key, resolved_path, tainted, force_ask}`（八件） |
| 下行 | `approval.resolved` | `{request_id, decision:"y\|n\|a\|p"}` |
| 下行 | `state.patch` | `{todos?/notes?/vision_pending?/approved_tools?/denied_calls?/stall?/usage?/compaction_recent?/pick_diff?}` |
| 下行 | `compaction.event` | `{kind:COMPACTION_KIND, before:{msgs,chars}, after:{msgs,chars}, cleared:int\|null, depth}`（cleared 仅 tool_result_clearing 有值） |
| 下行 | `viewport.update` | `{viewport_id, size, scale, parent_id, chain:[ids], marks, screenshot_ref, updated_at}`（无视口时 viewport_id=null） |
| 下行 | `job.update` | `{jobs:[§3 jobs 结构]}` |
| 下行 | `subagent.update` | `{subagents:[{ref_id,objective,status,summary,text_ref,batch_id}]}` |
| 下行 | `system.alert` | `{level:"info\|warn\|error", code, text}` |
| 上行 | `send` | `{text, client_msg_id}` |
| 上行 | `approve` | `{request_id, decision:"y\|n\|a\|p"}` → 服务端白名单映射 y→True / n→False / a→"always" / p→"persist"，其他值拒绝（不透传） |
| 上行 | `cancel` | `{}` → 置取消事件 + 未决审批全部以 n 结案 |
| 上行 | `command` | `{name:"todos\|memory\|skills\|notes\|effects\|undo\|clear\|help\|recall\|recall_subagent\|sessions\|resume", args?}` |
| 上行 | `vision_pending.remove` | `{ref}`（与 REST POST /api/vision/pending/remove 等价二选一） |

### 1.3 消息结构

四 role：user `{role,content}`；assistant `{role,content,tool_calls?}`；tool `{role,tool_call_id,content}`；
system 仅置顶/本地回显。每条带桥接层派的 `msg_id`（int，会话内单调，D8）。
tool 消息的「工具数据，非指令」包裹由服务端产出、**服务端不剥离**（前端 stripToolWrap 严格首尾匹配才剥）。

### 1.4 手写 RFC6455（ui_server 内实现，零依赖）

握手校验 Upgrade/Connection/Key/Version:13；Accept=b64(sha1(key+GUID))。
**鉴权先于升级**：HTTP 安全门（§7）全过 + token——浏览器走 Sec-WebSocket-Protocol 子协议
`xs-token.<token>`（响应回选），非浏览器可 `Authorization: Bearer`。
帧：text/ping/pong/close；客户端帧必须带 mask（否则 close 1002）；len 7/16/64bit 三档；
单帧上限 1MB（close 1009）；不支持分片（continuation → close 1003）；服务端不 mask。
心跳 15s ping，三拍未应断开。解析异常 → close + 日志，绝不抛进 harness。

## 2. 消息流分页

`GET /api/messages?limit=50&before=<msg_id>`：内存 history 为准、JSONL 补齐 ts/usage；
尾页编号与后续 WS append 连续（D8）；响应带 `messages` + `has_more`。


## 3. 状态快照（§10 字段溯源表；ui_state.py 持锁 + 拷贝 + 脱敏，UI 读 ctx 的唯一入口）

`/api/state` 与 `session.snapshot.payload.state` 同构，十键：

| 键 | 结构 / 数据源 |
|---|---|
| `todos` | `[{content, status:"pending\|in_progress\|completed"}]` ← ctx['todos'] |
| `notes` | `[str]`（≤30 条）← ctx['_notes'] |
| `jobs` | `[{id,command,pid,log_path,status,started_at,returncode,ended_at, tail}]` 八键 + tail（末 20 行，D13）← jobs.list_jobs() |
| `subagents` | `[{ref_id,objective,status:"running\|done\|failed",summary,text_ref,batch_id}]` ← ctx['_subagent_runs']（D10） |
| `vision_pending` | `[{ref, target\|null}]` ← ctx['_vision_pending'] 逐 ref + vision.meta()['target'] |
| `approved_tools` | `[{key, scope:"session\|persist"}]` ← ctx['_approved_tools'] ∪ approvals.load() |
| `denied_calls` | int ← ctx['_denied_calls'] |
| `stall` | `{count,limit,at}` 或 null ← ctx['_stall']（D9） |
| `usage` | `{input_tokens,output_tokens,cache_read?,window?,turn}` 仅计数（脱敏） |
| `compaction_recent` | 最近一条 compaction 事件或 null（读会话 JSONL 尾 20 行筛 role=system event=compaction） |

附加顶层键：`sid`、`pending_approvals`（同 session.snapshot）。
其他派生端点快照：`viewport_current(ctx)`（注册表尾=当前，chain 沿 parent_id 上溯 根→当前，marks 字符串键，空态 `{viewport_id:null, marks:{}}`）、
`pick_diff(ctx)`（`{ratio, status, pair:{before_ref,after_ref}, target:{no,screen_cx,screen_cy}, at}`，无记录时 unknown 空态）、
`memory_stats()`（`{total, by_zone, injectable, superseded, items:[{id,zone,text,created_at,superseded_by}]}`，D2/D3）、
`skills_pending()`（`{pending:[{name,description,when,steps_count,source:"selflearn",created_at}], active:[{name,when,steps_count,enabled:true}], cheatsheet:[{id,text,worked_count,updated_at,nominated}]}`，D14/D16/D18）。

**脱敏纪律**：不导出 .env 内容、ui_token、config 的 key/代理串、_tainted 原文、运行时句柄键
（_model_fn/_approver/_log_file/_cancel_event/16 个 _*_runner 等）。

## 4. REST 13 路由 + 2 配套端点

**响应形状铁律**：REST 响应 = `{v:1, server_time} + 域字段平铺顶层`；集合型域字段保留命名键
（jobs/messages/tools/items/pending/active/cheatsheet）；/api/state 平铺十键外附加 sid/pending_approvals；
**禁止**把域对象包进 state/memory/viewport 这类包装键。
错误统一 `{"error":{"code","message","hint"}}`；/api/tools 与图片端点 ETag+304；图片 Cache-Control: private。

| # | 路由 | 方法 | 说明 |
|---|---|---|---|
| 固 1 | /api/messages | GET | 消息分页（limit/before，has_more） |
| 固 2 | /api/state | GET | 状态快照十键 + sid + pending_approvals |
| 固 3 | /api/images/{ref} | GET | 图片二进制（?thumb=1 缩略；?token= 例外放行——仅此类二进制端点接受 query token，因 \<img\> 无法带头） |
| 固 4 | /api/send | POST | `{text, client_msg_id?}` → `{ok:true, accepted, client_msg_id(原样 echo)}`；上一轮未收尾 → `accepted:false, reason:"busy"` + system.alert busy |
| 固 5 | /api/approve | POST | `{request_id, decision}` → `{ok:true, request_id, decision}`（含 args 指纹一致性校验，§5-4；非法 decision → 400 统一错误形状） |
| 新 1 | /api/tools | GET | `{count, tools:[38+], registry_rev}`；每条 {name,description,args_schema,category,category_label,permission_default,approval_key_rule,persistable,taint_high_risk,display:{icon,arg_format}}；ETag+304 |
| 新 2 | /api/viewport/current | GET | 当前视口平铺（§3 viewport_current） |
| 新 3 | /api/viewport/{id}/screenshot | GET | 视口截图二进制（无 ref → 404） |
| 新 4 | /api/pick/diff | GET | 差分读回平铺（§3 pick_diff，DIFF_STATUS 三态） |
| 新 5 | /api/jobs | GET | `{jobs:[八键+tail]}` |
| 新 6 | /api/jobs/{id}/log | GET | `{job:八键, log}`（?lines=N，1–200） |
| 新 7 | /api/memory/stats | GET | 记忆统计平铺（§3 memory_stats） |
| 新 8 | /api/skills/pending | GET | 技能/小抄平铺（§3 skills_pending） |
| 配 1 | /api/vision/pending/remove | POST | `{ref}` → `{removed}`（与 WS vision_pending.remove 等价） |
| 配 2 | /api/token/reset | POST | 安全门配套：需旧 token 过闸；换新、旧即作废、落盘 0600 |

> 口径说明：SPEC §11 把 vision/pending/remove 计入「8 新增」；实现侧注释按「REST 13+2」记账
> （13 契约路由 + token/reset 与 vision/pending/remove 两条配套）。本表并列全部 15 条，分组仅作标签。

一切入参先过 `ui_schema.check`（type/required/enum/max_len/one_of 迷你校验器），路径类再过 `permission.safe_path()`。


## 5. 审批生命周期（唯一跨帧等待）

1. serve 启动注册总线审批（`agent.set_bus_approver`）。`_approved` 判定需问用户 → 总线分支组装 request：
   `request_id="ap-N"` 单调；`approval_key` = 指纹（§6 KEY_RULE 四规则）；`resolved_path` = 仅 path 类
   （write_file/edit 及 pathlike 候选）逐一 `permission.resolve()`——单值字符串 / 多值列表 / 无路径参数 null /
   resolve 异常 → `{"error":"path_error","raw":原始串}`；`tainted` = taint_gate 结果；`force_ask` = _approved 入参。
2. `ui_bus.register_approval(req)`（原子落 `.state/ui_pending_approval.json`）+ 广播 `approval.request`。
3. **阻塞等回执**：queue 轮询 timeout=0.3s（Ctrl+C 可打断）；KeyboardInterrupt/会话结束/cancel → 以 n 结案 + 日志（fail-closed）。交互审批无超时。
4. 客户端 approve → 入参校验 + decision 白名单映射 + **args 快照一致性校验**（重算 approval_key 与登记不一致
   → 以 n 结案并 system.alert）→ resolve_approval 唤醒。
5. verdict 回 `_approved` 走既有逻辑：`a` 记会话白名单、`p` 记会话+持久白名单（仅真指纹且非 click_at/pick——
   坐标语义随布局朽坏不跨会话；裸名工具 p 降级为本会话）；tainted/force_ask 时 a/p 不落白名单。
6. 结案广播 `approval.resolved` + 删持久化文件 + JSONL 审计行（role=system event=approval：
   `{approval_key,resolved_path,tainted,decision,ts}`）。
7. headless 不注册总线审批（恒拒原样）；serve 进程绝不进 headless_mode；分支泄漏时兜底 approver 恒拒（stdin 非 TTY）。
8. 子 agent 内工具调用强制非交互 approver——UI 不弹卡，tool_call.end status=denied 如实显示。

**唯一入口纪律（红线）**：UI 批准回执只喂注入的 approver，执行永远走 `agent._run_tool`；
禁止「UI 已批 → 直调 tools.execute」。

## 6. 枚举全表（封闭；ui_schema.py ≡ ui/js/lib/enums.js 逐字一致）

| 枚举 | 取值 |
|---|---|
| ROLE | `user` / `assistant` / `tool` / `system` |
| EVENT_TYPE | §1.2 全表 17 种 |
| DECISION | `y` / `n` / `a` / `p` |
| PERMISSION | `allow` / `ask` / `deny` |
| TOOL_STATUS | `ok` / `error` / `denied` |
| CATEGORY | `file` / `process` / `memory` / `vision` / `web` / `subagent` / `sandbox` / `misc` |
| KEY_RULE | `path` / `command` / `coords` / `bare` |
| MARK_SOURCE | `uia` / `ocr` / `uia+ocr` |
| JOB_STATUS | `running` / `done` / `interrupted` / `failed` |
| SUBAGENT_STATUS | `running` / `done` / `failed` |
| DIFF_STATUS | `effective` / `suspected_noop` / `unknown` |
| COMPACTION_KIND | `auto_compact` / `force_compact` / `emergency_truncate` / `tool_result_clearing` |
| ZONE | `目标` / `决策` / `现状` / `待解` / `已完成` / `其它` |
| ALERT_LEVEL | `info` / `warn` / `error` |
| APPROVAL_SCOPE | `session` / `persist` |

**审批指纹四规则（KEY_RULE）**：path（write_file/edit 绑目标路径）/ command（run_command、run_in_background、
run_script 绑整条命令/脚本正文）/ coords（click_at 绑 x,y；pick 绑 viewport_id+mark_no+解析后屏幕坐标，
不跨会话持久）/ bare（其余工具裸名）。persistable = {write_file, edit, run_command, run_in_background, run_script}。

**38 工具元数据表**（ui_schema.py，运行时校验覆盖注册表全集）：category 与 approval_key_rule 逐工具钉死；
permission_default 运行时查 SAFE_TOOLS/_USER_TOOL_SAFE；taint_high_risk = permission._TAINT_HIGH_RISK ∪ mcp__ 前缀；
display.arg_format 38 条中文模板 + display.icon。注册表出现表外工具 → category=misc/rule=bare 且 validate_contract.py 报警（防漂移）。

## 7. 安全门五条（上线硬门槛）

| # | 规则 | 实现要点 | 攻击测试预期 |
|---|---|---|---|
| S1 | 仅绑 127.0.0.1 | ThreadingHTTPServer(("127.0.0.1",port))；无 0.0.0.0 配置项 | 非回环连接被拒 |
| S2 | 配对 token | `secrets.token_hex(16)` 写 `.state/ui_token`（0600 原子写）；启动日志打印带 token 完整 URL；REST 取 `Authorization: Bearer`、WS 取子协议（图片二进制端点例外接受 ?token=）；无 token **401**、错 **403**、**连续 10 次错锁 60s（429，锁期内正确 token 也 429）**；日志 token 自动掩码；POST /api/token/reset 需旧 token | 无 token→401；错→403；11 次→429；WS 无 token→握手 401 |
| S3 | Host 白名单 | 仅 `127.0.0.1:<port>` / `localhost:<port>`（规范化大小写/尾点）；其他 → **421** | 恶意 Host（DNS 重绑定）被拒 |
| S4 | Origin 白名单 | 有 Origin 仅放行本服务自身源；无 Origin 放行（curl/同源导航）；跨源 → **403** | 跨源 fetch/WS 被拒 |
| S5 | CSP + 入参校验 + 静态 containment | HTML 响应头 `default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://… http://…; font-src 'self'; frame-ancestors 'none'`；一切入参过 ui_schema.check，路径类过 permission.safe_path；静态文件 realpath 限定 ui/ 树内 | `.state/../.env` 穿越被拒；`/api/images/../ui_token` 404；静态 `/.state/ui_token` 404 |

## 8. 契约三道机器校验（validate_contract.py）

1. **样例驱动**：tests/ui_contract/fixtures/*.json（13 路由 + 全 WS 事件 + 工具卡 16 格状态矩阵 +
   压缩四 kind + 审批三变体）经迷你 schema 校验；`--server` 模式对活服务跑输出 ≡ 样例比对
   （一键：`python scripts/check_live.py`）。
2. **字段溯源**：脚本内置 §3 溯源表清单，逐字段对快照实际取值验证非缺失。
3. **枚举封闭**：ui_schema.py 枚举 vs fixtures/enums_mirror.json vs ui/js/lib/enums.js 三方逐字比对
   （enums.js 缺失只 WARN——前端合并后自动转硬校验）。
4. 防漂移加检：tools.REGISTRY 每个工具在元数据表有条目，表外条目 WARN。
