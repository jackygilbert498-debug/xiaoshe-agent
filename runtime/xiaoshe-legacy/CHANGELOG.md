# CHANGELOG

本项目从本文件起开始记录变更。格式：[里程碑] 按日期倒序。

## [M6] — 2026-08-01 · 安全九单元 + UI 四轮 + 蛇瞳 S 品牌定稿

### 安全与能力（S1–S5 / C1–C2 / E1·E3；细节见换机手册 v14，21902e1）

- S1 出站白名单代理：子进程最小干净 env（擦凭据/继承代理）+ 默认零出网 fail-closed；模型 curl 与工具出网物理分离。
- S2 Docker 沙箱优雅降级：docker→seatbelt/AppContainer→bare 降级链，仅容器算隔离，显式选择 fail-closed。
- S3 Mac seatbelt 沙箱：deny-default FS/断网/零 mach/最小 env，对齐 Win AppContainer 语义（红队逃逸四杀坐实）。
- S4 统一信任标签层：污点全部行带来源入库；`trust.label_gate` 来源禁写/执行/网络升 ask。
- S5 StruQ/Spotlighting 子集：会话随机边界包裹 tool 数据；真链 27 次实测与旧标记持平无回退（如实记录）。
- C1 ReAct 显式轨迹（`REACT_ENABLED` 默认开，9 条红线测试钉死）；C2 ADaPT 按需分解（停滞软提醒升级为真分解引导，深度/次数双闸）。
- E1 friction 消费压缩事件（按真实扁平 schema 解析）；E3 Mac OCR 置信度门控真机验收（产品代码零改动）。
- Mac 全量测试 20min 挂起修复：zoom 等模块真发 API（VLM 兜底闸未注入桩）+ 大图假截图缩尺寸——2052 全绿 80s。

### 前端 UI（B/C/D 三轮 + 双主题重做）

- B 项目分组+会话管理：两级树（项目→会话）/新建/移入移出/删除项目保会话/即时过滤；后端 projects CRUD 落 `.state/projects.json`。
- C 三层记忆面板：长期/项目/短期 + 实时编辑（增改忘复，supersede 审计链）+ 注入净化与 XSS 字面渲染；编辑改多行自适应 textarea。
- D 模型切换下拉（会话级不落盘）+ 会话级自主模式（ask 自动过/deny 照拦/force_ask+污点仍问，常驻醒目横幅）。
- 双主题重做：暗「暗夜影院」+ 亮「云白薄荷流光」（tokens 令牌层整换）；空态巨型蛇鳞流光字标 + 蛇形渐变水印 + 提示 chips，系统提示折叠细条。
- 杂修：theme-toggle 未接监听 + eye-btn 双注册双 toggle；侧栏/状态栏 tooltips 补齐；Mac 双击启动器两个对齐 Windows bat。

### 品牌：蛇瞳 S 定稿（档案：docs/小蛇logo-wip/蛇标定稿-蛇瞳S.md）

- 定稿：粗 S 一笔成型（stroke-width 5）+ 头部方瞳负空间 + 镜桥缝（同 mask 工艺），蛇（小蛇）× 视觉（瞳孔）× S（Snake）；
  品牌位/空态水印/icons.svg/tauri/启动 PNG 全套替换。
- 关键坑位（排障结论，后人勿踩）：
  - 静态资源必须全量 `Cache-Control: no-cache` + `?v=` 版本戳——浏览器启发式缓存会让用户刷新也看不到新标（ce8cf37/bdc44ab）。
  - 水印幽灵方块根因：根 `<svg>` 上的 stroke 会被 mask 内容继承，方孔/缝被画出 1.5 单位渐变环——stroke 必须挂在 S path 上（d5051a9）。
  - Chrome/Edge 不解析 `<use>` 克隆内容里的 `mask="url(#…)"`（mask 放 symbol 内或 sprite 顶层均失效，实测复现）——品牌位必须纯内联 SVG（6c7113e）。
  - 布尔方瞳是 mask 真负空间，低透明度下依然清晰；空态水印定档 320px（窄屏 220px）、透明度亮 .10 / 暗 .14（577ebb9）。

## [M2–M4] — 2026-07-26 · 前端全量 + 桌面壳脚手架

### 前端（ui/，无构建 vanilla ESM、零依赖、零外链）

- 设计系统：三层 token（色板/语义/组件），暖纸默认 + `data-theme="ink-jade"` 墨玉变体（localStorage `xs-theme` 持久）；
  原型缺口全部补齐（--card-hover/--accent-bg/独立琥珀 warn/err 与 accent 解耦/墨玉 ink2 与 serif/--mark token 化）；
  `prefers-reduced-motion` 全局关停；细线 S 形蛇标 SVG（像素蛇退役）+ 52 枚细线图标 sprite。
- 消息流：四角色渲染、thought 折叠、工具卡**双行状态 16 格矩阵**（权限×执行；硬拒+被拒渲染为 deny 条）、
  `stripToolWrap` 严格首尾剥离 + 「数据非指令」徽章（中段不剥）、压缩标记四 kind 分色 + recall 入口、
  图片消息（缩略图 + 灯箱）、子 agent 流内组卡（并行批次聚合）。
- 审批卡三变体：常规四键 / tainted 红框 a·p 禁用 + 不可信来源说明 / 无头只读；
  meta 行真实 approval_key + **realpath 规范化路径**（GhostApproval 硬落地）+ 指纹分级说明；
  y/n/a/p 全局键定位最新未决卡、已决灰显徽标不收起、aria-live assertive。
- 输入与导航：Enter 发送 / Shift+Enter 换行 / 自适应增高 / Esc 中断 / `:` 本地命令；
  ⌘K 两组命令（harness 8 条上行有回执 + 界面命令）+ 工具目录模态（/api/tools 动态渲染，38 个按 8 类分组，无写死数字）+
  恢复存档 / 导出日志（jsonl）/ 重置配对 token；待发图条〔ref｜target〕+✕+缩略图 hover。
- 长会话：100 事件阈值窗口化（视口 ±2 屏、变高项测高缓存、80px 贴底锚定、「↓ 新消息」浮标、
  before 游标翻页不跳滚动）+ ⌘K 会话内搜索补偿 Cmd+F 盲区。
- 右栏三 tab：状态（todos 进度条/notes/jobs 四色点+日志 tail 终端着色/subagents/白名单指纹两色 scope 标/
  待发图/用量 + denied·stall 信号灯）；记忆（zone 六中文分区 + superseded 灰显删除线 + revive /
  技能两列待人审 approve·reject 走人审门 / 小抄奏效计数 + 已提名徽标 + 时间线）；
  系统（连接/会话/用量/平台能力诚实标注 Mac「待验证」）。
- 蛇眼观测台 ◉：模态四段——面包屑视口链 / 画布截图 + marks 三源编号框（uia 实线/ocr 虚线/uia+ocr 双色）
  +行↔框双向联动 / HUD 坐标链结果 + 差分比例条（suspected_noop 红色告警）/ 编号表引擎标；
  空态文案、数字键直选、双主题共用。
- 四态纪律：19 组件数据/骨架/空/错全覆盖；全键盘闭环 + 可访问性清单（focus 描边/aria-live/对比度）。

### 桌面壳（tauri/，M4 代码交付，安装包构建见 BUILD.md）

- Tauri 2 薄壳脚手架：单实例 / 侧车 `run.py serve` 拉起（python 逐级发现 + 就绪行解析）/
  托盘（关窗不杀服务、退出杀进程树）/ 错误面如实报错不白屏 / CSP 与桥接一致。
- `scripts/export_icons.py`：纯标准库 SVG 栅格化（4× 超采样）产出 16/32/128/256/512 PNG 全套。

### 审查与硬化（独立审计 3🔴7🟡 全修复）

- depth-0 统一规则：子 agent 内部事件不进主消息流（可观测性走 subagent.update）。
- runner-busy 闸：clear/resume/undo 在回合进行中拒绝并提示。
- POST /api/send、/api/approve 响应形状对齐黄金样例（契约校验补 POST 用例，堵绿灯假象）。
- 基线零副作用复核（pick_diff 仪表化短路）、ptc-N 合成、慢订阅者踢出强制重连、
  快照锁外磁盘 I/O、审批暂存 0600 原子写、resume sid 白名单、视口注册表并发重试。

## [M5] — 2026-07-26 · E2E 场景回归与发布文档

### 新增

- `scripts/e2e/run_e2e.py`：SPEC §13 全部 8 条 E2E 场景，WS/REST 协议层驱动（不依赖浏览器），
  `python scripts/e2e/run_e2e.py` 直接跑、退出码非 0 即失败；69 项断言、连跑 3 次全绿。
  场景③压缩四 kind 走 serve 全链路（假 history + 假溢出 400 驱动真实压缩路径）；
  场景④ look→zoom→pick→差分为 runner 注入模拟级（复用 tools.py 的 `_*_runner` 依赖注入句柄）。
- `docs/GUIDE.md`：5 分钟上手指南（启动/审批四键/⌘K/观测台/主题/演示模式/FAQ）。
- `docs/LOCAL_VERIFY.md`：本地回归核对清单（1900+ 基线对比、无 sink 行为一致、
  安全门五条攻击 curl 复测、契约校验、8 条 E2E、真机专项）。
- `docs/UI_CONTRACT_v1.md`：UI 契约归档版 v1（信封/17 事件/13+2 路由/枚举全表/审批生命周期/安全门五条），
  标「v1 冻结 2026-07-26」。
- `CHANGELOG.md`：本文件。

### 实况勘定（开发中发现、已绕开或已注明，不改后端行为）

- jobs 终态翻转无独立监工线程：running→done 由 check_background/status() 调用触发
  （E2E 场景⑦按真实用法驱动翻转，文档已注明）。
- token 锁定期间（连错 10 次锁 60s）正确 token 同样 429（TokenManager.check 实测；
  服务端提示语与行为略有出入，GUIDE FAQ 按实测行为写）。

## [M1] — 2026-07-26 · 契约层：13 路由 / 审批链 / 元数据

- `harness/ui_schema.py`：迷你入参校验器（type/required/enum/max_len/one_of）+ 38 工具元数据表
  （category/approval_key_rule/display 中文模板）+ 14 枚枚举（唯一事实来源）。
- REST 13 路由 + 2 配套（token/reset、vision/pending/remove）全部落地；响应形状铁律
  「域字段平铺顶层」；/api/tools 与图片端点 ETag+304。
- 审批链：总线审批分支（request_id/resolved_path/tainted/force_ask 八件）、decision 白名单映射、
  args 指纹一致性校验、未决审批原子落盘、断线重连经 session.snapshot 带回、
  会话/持久白名单分级（坐标指纹不跨会话）。
- 快照层 `harness/ui_state.py`：状态十键持锁拷贝 + 脱敏纪律（不导出 token/密钥/污点原文/运行时句柄）。
- 契约校验三道：`tests/ui_contract/validate_contract.py`（样例驱动/字段溯源/枚举封闭）
  + 21 份黄金 fixtures + `scripts/check_live.py` 活服务比对。

## [M0] — 2026-07-26 · 地基：观测钩子 / 事件总线 / ui_server / 安全门

- 观测钩子（agent.py/tools.py/jobs.py 仪表化）：全部经 ui_bus 转发，**未注册 sink 时恒 no-op**
  （红线：默认关闭、行为零变化、失败不扩散）。
- `harness/ui_bus.py`：sink 注册/事件派序（持锁单调 seq）/ mark_dirty+flush 广播 / 审批登记与回执队列。
- `harness/ui_server.py`：纯 stdlib ThreadingHTTPServer + 手写 RFC6455 WS（mask 强校验/1MB 帧上限/
  15s 心跳），REST+WS+静态三合一。
- 安全门五条：仅绑 127.0.0.1 / 配对 token（0600 落盘、连错锁定、自动掩码、reset）/
  Host 白名单（421）/ Origin 白名单（403）/ CSP + 入参校验 + 静态穿越 containment。
- `scripts/smoke_serve.py`（32 项）+ `scripts/wsprobe.py`（WS 客户端，供 E2E 复用）+
  `scripts/serve_demo.py`（假模型演示模式，不烧 API）。
