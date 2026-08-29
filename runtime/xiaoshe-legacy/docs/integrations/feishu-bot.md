# 小蛇飞书机器人接入实施方案

> Plan 11 Task 7（2026-08-16）：已实现**默认关闭**的受控收件适配器与本机回环
> `POST /integrations/feishu/events` 入口。入口按官方顺序完成原始请求签名、5 分钟时间窗、
> AES-256-CBC 解密、Verification Token/tenant/app/发送者/会话白名单和有界 nonce
> 请求账本；完全一致的官方重试可从 pending/result 状态恢复原回执，nonce 相同但请求体
> 不同则拒绝。业务幂等绑定 tenant + app + `message_id`，`event_id` 只保留散列投递审计。
> pending 使用独立配额和 12 倍回调窗口的恢复 TTL；超时后转为仅含散列的 expired 摘要并
> 释放容量，旧版账本行按普通回调窗口清理，因此异常退出或旧数据库都不会永久占满入口。
> 随后只写入 `TaskIntent`/`InboxReceipt`；不会运行工具、创建 Task 运行、
> 代替 PlanGate/Permission 审批或回传本机正文。该入口仍绑定 `127.0.0.1`，供受控本机
> 网关使用，不意味着已经开放公网服务。
>
> 真实飞书租户走查：`not_run / hold`。本机没有经确认可用的专用测试应用凭据，未伪造
> `event_id`、`task_id` 或飞书投递证据。下文长连接 worker、真实租户、Windows 安装与
> 运维设计仍是后续发布门，不因本地单元测试通过而视为完成。

> 状态：受控 webhook 收件适配器已实现；官方 SDK 长连接 worker、专用测试应用与真实租户
> 接通尚未完成。最初设计核对：2026-08-09；实现状态核对：2026-08-16。
>
> MVP 决策：企业自建应用 + 应用机器人 + 飞书官方 Python SDK 长连接；Windows 本地 worker 只建立出站连接，不开放公网回调地址或任何新入站端口。飞书是 Task v2 的受限消息入口，不是权限或审批的替代品。

## 1. 结论与不可破坏的边界

首版固定链路如下：

```text
飞书用户（单聊 / 群内 @ 小蛇）
          │
          ▼
企业自建应用机器人
          │ 飞书官方 SDK WebSocket 长连接（仅出站）
          ▼
Windows 本地 feishu_worker
          │ 先写 SQLite inbox 并在 3 秒内返回
          ▼
本地异步 bridge / outbox ── Task v2 / 飞书消息与卡片 API
```

[飞书官方长连接文档](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)明确：长连接由 SDK 建立 WebSocket 通道，只需运行环境能访问公网，不需要公网 IP、域名或内网穿透；只支持企业自建应用。MVP 因此遵守以下硬边界：

1. 不监听 `0.0.0.0`，不新增 Windows 防火墙入站规则，不配置公网 Webhook，也不使用内网穿透。
2. 只运行一个长连接 client。官方说明同一应用最多 50 个连接，多 client 是集群随机投递而非广播；MVP 单实例可减少并发去重和排障复杂度。
3. 回调线程只做结构校验、授权初筛、SQLite 原子落盘和快速响应；**不在回调中调用模型、运行脚本、等待 Task v2 或发送第二个网络请求**。
4. 飞书消息只创建 Task v2 草稿/收件项，不自动进入 Ready、Queue 或 Running。
5. 飞书卡片不能批准脚本执行、外网访问、写文件、发布、恢复、不可逆效果或其他危险副作用。此类审批仍必须在小蛇桌面 UI 完成。
6. `App ID`、`App Secret`、Encrypt Key、Verification Token 和任何 tenant/user token 不进入 Git、安装包、命令行参数、页面响应或日志。
7. MVP 不启用用户 OAuth，不接飞书原生审批。两者均属于后续阶段，不能借应用机器人身份冒充用户身份或租户管理员。
8. worker 服从现有运行控制的联网开关：`off` 时主动关闭已经建立的 WebSocket、撤销重连和网络 worker，`proxy` 时只使用受控代理，`open` 时允许 SDK 直连；切换不删除 inbox/outbox，也不改用公网回调绕过策略。

## 2. 官方来源矩阵

下表链接已在 2026-08-09 逐项打开核对。飞书动态文档页同时用 `larksuite` 官方 SDK 仓库的 README 或示例源码交叉确认；没有用博客替代平台行为或权限结论。

| 决策或事实 | 官方依据 | 落地含义 |
|---|---|---|
| 长连接只需出网，不需公网 IP/域名；仅企业自建应用；处理函数 3 秒内完成且不抛异常 | [使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case) | Windows worker 只出站；回调先入账再快速返回 |
| 事件至少投递一次；失败会按 15 秒、5 分钟、1 小时、6 小时重推，最多 4 次；v2 用 `event_id` 标识投递 | [事件概述](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview?lang=zh-CN) | 所有消费均幂等；不能把“已收到一次”等同于“只会收到一次” |
| 接收消息事件类型是 `im.message.receive_v1`；特殊情况下应使用 `message_id` 去重，不只依赖 `event_id` | [接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN) | 消息业务主键优先采用 tenant + `message_id` |
| 新版卡片回传交互是 `card.action.trigger`；旧版是 `card.action.trigger_v1` | [处理卡片回调](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks?lang=zh-CN) | 只订阅新版，避免新旧版同时投递两次 |
| 长连接卡片回调也须 3 秒内响应 | [接收回调](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks?lang=zh-CN) | 卡片先记录、返回“已收件”，后续异步处理 |
| 官方 Python SDK 的长连接使用 `lark.ws.Client`，事件与卡片分别注册对应 handler | [长连接 Python 示例](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)、[长连接回调 Python 示例](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/configure-callback-request-address?lang=zh-CN) | 实现时固定 SDK 版本并使用 typed dispatcher，不手写 WebSocket 协议 |
| 官方 SDK 源码同时包含 `register_p2_im_message_receive_v1` 与 `register_p2_card_action_trigger` | [`larksuite/oapi-sdk-python` 示例](https://github.com/larksuite/oapi-sdk-python/blob/v2_main/samples/event/flask_sample.py) | 事件名和 handler 名已用一手源码交叉核对 |
| 应用身份与用户身份权限边界不同；`tenant_access_token` 不是管理员特权 | [如何选择 Token](https://open.feishu.cn/document/faq/trouble-shooting/how-to-choose-which-type-of-token-to-use?lang=zh-CN)、[权限概述](https://open.feishu.cn/document/server-docs/application-scope/introduction?lang=zh-CN) | MVP 只用应用身份；不申请用户 OAuth |
| 发送/回复消息需要机器人能力和 `im:message:send_as_bot` 等权限；卡片类型为 `interactive` | [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)、[回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply?lang=zh-CN) | 只申请最小发送权限；使用应用机器人 API |
| 发送和回复支持 `uuid` 一小时去重；同一用户/群内机器人共享 5 QPS | [发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)、[回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply?lang=zh-CN) | `send`/`reply` 分别使用不超过 50 字符的端点专用 `uuid`；同一 outbox 项逐字节复用，本地限速低于平台上限 |
| 群自定义 Webhook 只能向当前群单向推送，不能接收消息、单聊或做卡片交互 | [机器人概述](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot-overview)、[自定义机器人指南](https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN?lang=zh-CN) | Webhook 可做临时通知备选，但不能作为小蛇交互入口 |
| 权限、事件或能力变更后需要创建版本、设置可用范围并发布/审核 | [添加事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/subscription-event-case?lang=zh-CN)、[发布与使用应用](https://open.feishu.cn/document/client-docs/h5/development-guide/step-4?lang=zh-CN) | “后台已勾选”不等于生效；验收必须包含已发布版本与真实可见范围 |
| SDK 封装 token 获取维护、事件分发和请求模型 | [`larksuite/oapi-sdk-python` README](https://github.com/larksuite/oapi-sdk-python/blob/v2_main/README.zh.md) | 不自行拼 token 请求或把 tenant token 持久写日志 |

### 2.1 经核对的名称

| 对象 | 当前名称 | MVP 用法 |
|---|---|---|
| 消息事件 | `im.message.receive_v1` | 订阅应用身份 v2.0 事件 |
| 卡片回调 | `card.action.trigger` | 订阅新版回调；不订阅 `_v1` |
| Python 消息 handler | `register_p2_im_message_receive_v1` | 只入 inbox，不跑模型 |
| Python 卡片 handler | `register_p2_card_action_trigger` | 入 inbox 后返回 `P2CardActionTriggerResponse` |
| 发送权限 | `im:message:send_as_bot` | 应用身份发送文本/卡片 |
| 单聊接收权限 | `im:message.p2p_msg:readonly` | 只接用户发给机器人的单聊 |
| 群接收权限 | `im:message.group_at_msg:readonly` | 只接群内用户 @ 机器人，不读群内所有消息 |

## 3. 三种身份/机器人必须分开

### 3.1 群自定义 Webhook

它是群设置里产生的一个 webhook URL，只能向**当前群**单向推送。它没有企业或用户数据访问权限，不支持接收用户消息、机器人单聊或卡片回传交互。Webhook URL 本身相当于发送凭据，官方也要求避免公开。

结论：它不满足小蛇双向交互需求，不进入 MVP。若以后只做监控通知，也要单独建 secret ref、签名校验、发送 allowlist，不能复用应用机器人的 App Secret。

### 3.2 企业自建应用机器人（MVP）

机器人以应用身份调用 OpenAPI，SDK 用 App ID/App Secret 建连并维护应用侧 token。它可接收已授权范围内的消息并向机器人所在会话回复，但权限由应用 scope、应用可用范围、机器人是否在群中以及群发言设置共同限制。

结论：MVP 采用该身份。任何 `open_id` 只表示“此用户相对于此应用的标识”，不能据此推断用户是管理员或已经获准执行本机操作。

### 3.3 用户 OAuth（二期）

`user_access_token` 表示完成 OAuth 授权的真实用户，访问范围受该用户与已授权 scope 共同限制。它有过期与刷新生命周期，不等同于应用机器人身份。

结论：MVP 不请求授权码、`user_access_token`、`refresh_token` 或 `offline_access`。只有确需“以用户身份访问用户资源”时另立方案、另做权限审查和撤销流程。

### 3.4 飞书原生审批（二期）

原生审批是飞书业务能力，不是小蛇 Task v2 的同义词。二期最多先做“审批通知/结果镜像”；在风险分级、身份绑定、撤销、过期和双向一致性得到单独设计前，原生审批结果不得直接越过小蛇的权限检查、桌面人工审批或外部副作用账本。

## 4. 飞书后台逐步配置

以下步骤由企业应用管理员在正式实现完成后手工执行；本方案没有创建应用。

1. 登录飞书开放平台开发者后台，创建**企业自建应用**，记录应用所属租户和负责人。
2. 添加“机器人”能力。名称、头像和说明明确写“任务收件与状态通知”，不要暗示机器人能绕过桌面审批。
3. 在“权限管理”仅申请：
   - `im:message.p2p_msg:readonly`；
   - `im:message.group_at_msg:readonly`；
   - `im:message:send_as_bot`。
4. 不申请 `im:message.group_msg`（读取群中所有消息）、通讯录全量读取、用户身份发消息、审批、云文档或其他与 MVP 无关的 scope。
5. 在“事件与回调 > 事件配置”选择**使用长连接接收事件**，以应用身份添加 `im.message.receive_v1` v2.0。不要同时添加旧版同类事件。
6. 在“回调配置”同样选择长连接，添加新版 `card.action.trigger`。删除或不要配置历史“消息卡片请求网址”和 `card.action.trigger_v1`，避免双投递。
7. 首个版本把可用范围限制为指定试用人员/部门。权限范围、可用范围、事件和回调逐项截图留档，但截图先遮盖所有凭据。
8. 创建版本并提交企业管理员审核。官方说明事件配置只有发布后才生效；验收不能停在“已保存”。
9. 审核发布后，试用用户可与机器人单聊；群场景由群管理员把**应用机器人**添加到指定群，不要误加“自定义机器人”。
10. 开放平台日志检索只用于核对平台是否投递。生产日志禁止复制完整事件体或凭据。

### 4.1 最小权限表

| 需求 | 权限/能力 | 是否 MVP | 说明 |
|---|---|---:|---|
| 用户与机器人单聊 | `im:message.p2p_msg:readonly` | 是 | 只读单聊消息 |
| 群内明确呼叫机器人 | `im:message.group_at_msg:readonly` | 是 | 只处理 @；不旁听群聊 |
| 回复文本和卡片 | `im:message:send_as_bot` | 是 | 仅应用身份 |
| 读取群中全部消息 | `im:message.group_msg` | 否 | 敏感且非必要 |
| 以用户身份发送/读取 | 用户 OAuth scope | 否 | 二期单独设计 |
| 原生审批 | 审批域 scope/事件 | 否 | 二期；不得替代 Task v2 审批 |

## 5. 3 秒确认与异步处理

3 秒不是内部猜测，而是飞书平台约束。事件长连接 handler 必须在 3 秒内处理完成且不抛异常；卡片回调也须在 3 秒内响应。为了留出调度、磁盘抖动和 SDK 编解码余量，小蛇另设更严格的**内部 SLO：p99 在 500 ms 内完成本地入账并返回**。

### 5.1 消息 handler

```python
def on_message(event):
    envelope = validate_and_minimize(event)
    inbox.insert_once(envelope)  # 单个短 SQLite 事务
    wake_worker.set()
    return None                  # 不抛异常即确认成功
```

只允许 `validate_and_minimize` 做以下工作：检查 schema/event type、configured app/tenant、sender type、单聊或 @ 场景、尺寸上限；提取最小字段；按唯一键写入 inbox。它不得读取模型配置、调用 TaskAPI、发回复或等待后台 worker。

SQLite 忙、磁盘满、schema 不兼容或无法可靠持久化时，handler **不得假装成功**：记录脱敏计数后抛出受控异常，让平台按官方机制重推。无效、未授权或机器人自身消息则写一条最小拒绝记录并成功返回，避免无限重推和机器人自回路。

### 5.2 卡片 handler

```python
def on_card_action(event):
    envelope = validate_card_action(event)
    inbox.insert_once(envelope)
    wake_worker.set()
    return P2CardActionTriggerResponse({
        "toast": {"type": "info", "content": "已收件，请稍后查看任务状态"}
    })
```

该 toast 只表示“本地已持久收到”，不表示任务已完成、已批准或副作用已执行。卡片回调不能同步等待模型；MVP 的最终状态由 outbox **另发一条回复或新卡片**，不原地更新既有卡片。

## 6. 幂等、乱序、重连与本地账本

### 6.1 唯一键与映射

| 层级 | 主键/标识 | 用途 |
|---|---|---|
| 事件投递 | `tenant_hash + event_id_hash` | 只识别同一次 v2 投递，用于投递去重和审计，不参与卡片动作的一次性业务键 |
| 消息业务 | `tenant_key + message_id` | 按官方建议，消息创建任务的首要幂等键 |
| 卡片动作 | `tenant_hash + action_token_hash` | 独立唯一约束；同 token 即使换了 `event_id` 也只能消费一次 |
| Task v2 创建 | `client_token = fs_<sha256(primary_key)>` | 外部请求到内部 task 的稳定幂等键 |
| Task v2 状态动作 | `request_id = req_fs_<sha256(primary_key + action)>` | 每次内部变更的稳定请求键 |
| 新发消息 | `uuid = fsm1_ + sha256("send\\0" + outbox_id)[:40]` | 固定 45 字符；调用发送消息接口时复用 |
| 回复消息 | `uuid = fsr1_ + sha256("reply\\0" + outbox_id)[:40]` | 固定 45 字符；调用回复消息接口时复用 |
| 更新既有卡片 | MVP 禁用 | 不把发送/回复的 `uuid` 语义错误套给卡片更新 |
| 排障 | 飞书响应 `X-Tt-Logid`/request id 的脱敏摘要 | 只保存定位信息，不保存 token 或完整 payload |

哈希用于稳定键，不是权限证明。日志中的标识使用独立的 HMAC 日志盐脱敏，不能把原始 `open_id`、`chat_id`、`message_id` 或 `tenant_key` 打到普通日志。

发送与回复使用下面同一个可运行函数，但端点前缀和哈希输入均分离。40 位十六进制摘要提供 160-bit 空间，生日碰撞量级约为 `2^80`；数据库仍保留 `uuid UNIQUE`，若不同 outbox 记录发生冲突则以 `FEISHU_UUID_COLLISION` 失败关闭，绝不覆盖旧记录或随机换值继续发送。

```python
import hashlib

_UUID_PREFIX = {"send": "fsm1_", "reply": "fsr1_"}


def feishu_message_uuid(operation: str, outbox_id: str) -> str:
    if operation not in _UUID_PREFIX:
        raise ValueError("operation must be send or reply")
    if not isinstance(outbox_id, str) or not outbox_id:
        raise ValueError("outbox_id must be non-empty")
    digest = hashlib.sha256(f"{operation}\0{outbox_id}".encode("utf-8")).hexdigest()[:40]
    value = _UUID_PREFIX[operation] + digest
    assert len(value) == 45 and len(value) <= 50
    return value


# 固定测试向量：稳定、端点分离、长度不超过飞书 50 字符上限。
assert feishu_message_uuid("send", "outbox-example") == (
    "fsm1_a29a66f764fd2b7d93c416affcf20379ac7246ae"
)
assert feishu_message_uuid("reply", "outbox-example") == (
    "fsr1_a2e09fc25c3445dae06a4b9bd65463956bb2c24c"
)
assert feishu_message_uuid("send", "outbox-example") == feishu_message_uuid(
    "send", "outbox-example"
)
assert feishu_message_uuid("send", "outbox-example") != feishu_message_uuid(
    "reply", "outbox-example"
)
```

`uuid` 在 outbox 创建事务中生成并持久化；重试逐字节读取原值，不根据可能变化的 payload、目标名称或当前时间重算。`operation`、目标和 payload hash 在入账后不可变。

### 6.2 上线前必须补齐的 Task v2 缺口

当前 `POST /api/v2/tasks` 还没有外部 `client_token`，任务创建和桥接账本也不是同一个事务。因此首版代码在完成以下改造前必须保持 `enabled=false`：

1. 在 Task v2 所在 SQLite 数据库增加 `external_requests` 表；唯一约束至少覆盖 `(provider, tenant_hash, kind, primary_id_hash)` 和 `client_token`。
2. 增加 `create_or_get_external_task(...)`，在**同一数据库事务**中写 external request、创建 Task、记录 `task_id`。不得采用“先写桥接库、再调普通 create API”的双提交。
3. 对后续状态动作使用已有或新增的 `request_id` 唯一约束，并保留 `expected_version` 比较。版本冲突回到收件箱等待桌面处理，不在飞书端覆盖较新状态。
4. crash-recovery 扫描 `received/bridging` 记录：能根据 `client_token` 找到既有 Task 就补齐映射，找不到才创建；任何分支都不能产生第二个 Task。

建议表结构（实现时由 migration 管理）：

```sql
CREATE TABLE feishu_event_deliveries (
    tenant_hash TEXT NOT NULL,
    event_id_hash TEXT NOT NULL,
    event_type TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (tenant_hash, event_id_hash)
);

CREATE TABLE external_requests (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider = 'feishu'),
    tenant_hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind = 'message'),
    primary_id_hash TEXT NOT NULL,
    event_id_hash TEXT NOT NULL,
    client_token TEXT NOT NULL UNIQUE,
    request_id TEXT,
    task_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('received', 'bridging', 'bridged', 'rejected', 'failed')),
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (provider, tenant_hash, kind, primary_id_hash)
);

CREATE TABLE feishu_card_action_bindings (
    tenant_hash TEXT NOT NULL,
    action_token_hash TEXT NOT NULL,
    task_id TEXT NOT NULL,
    allowed_action TEXT NOT NULL,
    expected_version INTEGER NOT NULL,
    actor_scope_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    result_code TEXT,
    request_id TEXT UNIQUE,
    PRIMARY KEY (tenant_hash, action_token_hash)
);

CREATE TABLE feishu_outbox (
    id TEXT PRIMARY KEY,
    external_request_id TEXT NOT NULL,
    destination_hash TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('reply', 'send')),
    reply_message_id_hash TEXT,
    uuid TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'uncertain', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    not_before TEXT NOT NULL,
    issue_intent_at TEXT,
    resolved_at TEXT,
    resolution_code TEXT,
    last_error_code TEXT,
    platform_message_id_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (operation = 'send' AND reply_message_id_hash IS NULL) OR
        (operation = 'reply' AND reply_message_id_hash IS NOT NULL)
    )
);
```

`payload_json` 必须是经过 allowlist 重建的最小结构，不能直接保存完整 SDK 对象。消息文本按第 6.7 节的本地保留策略用 DPAPI 保护的记录密钥加密并限长；图片、文件、语音和富文本首版拒绝并提示改用桌面，不下载附件。`resolution_code` 只能取本地枚举，不能保存平台响应原文。

`feishu_card_action_bindings` 是本机服务端 binding，在发送带按钮的新卡片时预先插入 `task_id`、`allowed_action`、`expected_version`、过期时间和只含 HMAC 标识的 `actor_scope_json`。卡片 value 只携带 envelope `version` 与不透明 action token；回调中的 task id、action 名称或 expected version 即使存在也一律丢弃，不进入授权或匹配。回调事务先按 `event_id` 插入 `feishu_event_deliveries`；该插入只判断是否为相同投递。真正的业务消费只按 `(tenant_hash, action_token_hash)` 读取服务端 binding：

```python
def consume_card_action(conn, event, now):
    with begin_immediate(conn):
        if not insert_event_delivery_once(conn, event.tenant_hash, event.event_id_hash):
            return "duplicate_delivery"

        if event.value.version != 1:
            return "invalid_or_expired"
        binding = load_action_binding(conn, event.tenant_hash, event.action_token_hash)
        if binding is None or binding.expires_at <= now:
            return "invalid_or_expired"
        if not binding.actor_scope.matches(
            sender_hash=event.sender_hash,
            chat_hash=event.chat_hash,
        ):
            return "invalid_or_expired"

        changed = conn.execute(
            """
            UPDATE feishu_card_action_bindings
               SET consumed_at = ?, result_code = 'accepted'
             WHERE tenant_hash = ? AND action_token_hash = ?
               AND consumed_at IS NULL AND expires_at > ?
            """,
            (now, event.tenant_hash, event.action_token_hash, now),
        ).rowcount
        if changed != 1:
            return "already_processed"

        enqueue_local_action_in_same_transaction(conn, binding)
        return "accepted"
```

在 `changed == 1` 之前不得创建 Task、改变通知订阅或执行任何副作用；成功后也只使用 `binding.task_id/binding.allowed_action/binding.expected_version`。同一个 `action_token` 换一个新 `event_id` 再来时，投递记录可以新增，但消费更新必为 0，直接返回“已处理”，不创建 Task、不重复入队。找不到 binding、版本不支持、过期或 actor scope 不匹配一律 fail closed，并返回相同通用失败以避免枚举；回调 payload 伪造 task/action/version 不影响结果。

### 6.3 重复、乱序和重连

- 相同 `message_id` 即使 `event_id` 不同，也只产生一个 Task。
- 卡片 action token 默认 15 分钟过期，独立绑定 tenant + task + allowed action + target user/chat；`event_id` 只去重投递。同 token 不同 `event_id`、并发双击、旧卡、跨用户或过期 token 都不能再次消费。
- 不假设重连后不会补投，也不假设不同会话或普通消息严格有序。收件按 `received_at` 处理，业务状态以 Task v2 version 为准。
- 同一应用不启动第二个 worker。若将来做高可用，必须先实现数据库 lease；不能假设飞书会把一条消息广播给每个实例。
- SDK 连接断开只影响新消息接收；已入账 inbox/outbox 必须继续可恢复。worker 退出由本地 supervisor 退避重启。

### 6.4 按端点分离的出站契约

[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)与[回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply?lang=zh-CN)都支持最长 50 字符的 `uuid`，但目标参数和本地业务键不同，不能混成一个模糊的“发卡片”操作：

| operation | 平台调用与参数 | 幂等键 | 本地不可变条件 |
|---|---|---|---|
| `send` | `POST /open-apis/im/v1/messages?receive_id_type=...`；body 为 `receive_id`、`msg_type`、`content`、`uuid` | 第 6.1 节 `fsm1_...`，45 字符 | `receive_id_type`、目标 hash、payload hash 与 uuid 入账后不变 |
| `reply` | `POST /open-apis/im/v1/messages/{message_id}/reply`；body 为 `msg_type`、`content`、`uuid` | 第 6.1 节 `fsr1_...`，45 字符 | 原始 `message_id` 由受保护引用读取；其 hash、payload hash 与 uuid 入账后不变 |
| 更新既有卡片 | **MVP 不调用、`feishu_outbox` 不允许该 operation** | 不假设支持发送/回复的 `uuid` | 见下方二期门禁 |

文本和 interactive card 都可以作为 `send`/`reply` 的 `msg_type`/`content`，但这仍是“新发消息或回复消息”，不是更新既有卡片。MVP 的“查看最新状态”会另发一条回复或新状态卡片。

二期若要原地更新卡片，必须先选定并引用准确的官方卡片更新 API、权限、限流、token 时限与原生幂等语义；在此之前功能保持关闭。即使未来接口没有原生 `uuid`，本地也必须使用独立记录：`card_id_ref`（受保护原值）、`card_id_hash`、`expected_card_version`、`target_card_version`、`payload_hash`，并设置 `UNIQUE(card_id_hash, target_card_version)`。发送前比较当前版本必须等于 `expected_card_version`；相同目标版本 + 相同 payload hash 视为已提交，相同版本 + 不同 hash 进入冲突，远端结果不确定且无原生幂等能力时进入死信而不是盲重试。该记录绝不复用 `feishu_outbox.uuid`。

### 6.5 出站重试、限流与死信

1. 本地按用户和群分别使用不超过 4 QPS 的令牌桶，低于官方同一用户/群 5 QPS 上限。
2. 对明确的 429、`230020` 或可重试 5xx 使用带抖动的指数退避，例如 1、2、4、8、16、30 秒，遵从服务端返回的更长等待提示。
3. 只有可证明发生在 HTTP issue 之前的失败才可自动重试；同一 outbox 项逐字节复用持久化的端点专用 `uuid`，不得转换 operation。
4. HTTP 已 issue 但没有确定响应时，无论是否仍在官方一小时去重窗口内都标记 `uncertain`，**不自动重发**。只有未来实现并验证了准确的官方查询接口时才能据查询结果自动 resolve；否则必须由桌面人工对账：确认成功转 `sent`，确认未发送或放弃则转 `dead` 并记录脱敏 `resolution_code/resolved_at`。相同 uuid 不能证明一次重发必然安全。
5. 权限不足、机器人不在群、接收者不在可用范围、内容非法或凭据撤销属于不可自动修复，直接进入死信并显示稳定错误码和处理建议。
6. 死信不包含原始 token、完整用户消息或绝对本机路径。

### 6.6 联网控制状态机与线性化协议

单例 `RuntimeControlStore` 持久化 `desired_state/effective_state/epoch`，并在进程内维护 writer-preferred permit gate、`admission_open`、旧 epoch cancellation、active Task permit 计数和 active HTTP registry。`online permit` 是绑定某个 epoch 的只读 permit；只代表“允许跨越 Task commit 或 HTTP issue 线性化点”，不代表能撤回已经写上网络的请求。WebSocket handler 永远只验证并写最小 inbox，不取得 online permit、不建 Task、不发 OpenAPI。

| effective state | permit gate | bridge / sender | 允许的收口 |
|---|---|---|---|
| `disconnected` | 关闭 | 不取任务、不取 outbox | 本地 receipt、对账与清理 |
| `opening` | 关闭 | 不动作 | 创建并验证唯一新 client |
| `online(epoch=n)` | 开放 | 只能持 `n` 的 permit 工作 | 正常 Task commit / HTTP issue |
| `closing(epoch=n)` | writer 等待或独占，新 permit 禁止 | 停止取新，旧操作回滚或有界 drain | inbox、receipt、`uncertain` 账本 |
| `disconnect_failed` | 关闭 | 不动作 | 继续关闭本地 transport；不得报告已断开 |

Task bridge 的唯一协议是：在 Task v2 事务 `BEGIN` **之前**取得当前 epoch 的读 permit，并一直持有到 `COMMIT/ROLLBACK`；进入事务时与 `COMMIT` 紧前各检查 `admission_open`、permit epoch 和 cancellation。任一检查失败就回滚。若 commit 先完成并释放读 permit，它线性化在关闭之前；若关闭意图先关闭 admission，则事务必须回滚。不得在释放 permit 后补写 Task 或映射。

sender 的唯一协议是：停止状态不领取新项；在线时先取得带期限的 outbox lease，再在真正调用 transport issue 之前取得同 epoch online permit。持有 permit 和 lease 时原子写 `sending/issue_intent_at` 并登记 active HTTP，最后再调用 transport；issue 调用就是出站线性化点。尚未 issue 就看到关闭意图时只回到本地待处理，不发网。issue 后释放 online permit，但 active registry 保留到确定响应或关闭收口；进程在 `issue_intent_at` 后 crash 也按 `uncertain` 恢复，不能猜测请求未发出。

切到 `network_mode=off` 使用以下固定时序：

1. 在 transition mutex 下把 `desired_state=closing`、原子关闭 admission、设置旧 epoch cancellation；writer preference 从此拒绝新 online permit，bridge/sender 停止取新。
2. 请求 RuntimeControlStore 的写 permit。旧 Task 读 permit 必须在有界事务期限内 commit-before-close 或看到 cancellation 后 rollback；取得写 permit是 `off` 的线性化点，此后递增 epoch，任何旧 epoch 都不能提交 Task 或 issue HTTP。
3. 取消 reconnect/bridge/sender 调度；对 active HTTP 仅在 transport 明确支持时请求取消，并等待配置的有界 drain deadline。**不承诺取消能撤回已 issue 的远端请求**。deadline 内确定的响应只写本地 receipt；无响应的项转 `uncertain`、停止自动重发。若本地 transport/callback 仍不能退出，报告 `disconnect_failed`。
4. 主动关闭 SDK WebSocket/client；若 SDK 没有可验证的停止接口，则使用专用子进程并由 supervisor 终止、等待。旧 epoch 最后一帧仍只可写 inbox 并标 `held_offline`。
5. 只有 WebSocket 消失、client/HTTP transport 已 join、active Task permit 与 active HTTP 都为 0、旧 timer/worker 全部退出后才写 `effective_state=disconnected`。晚于关闭意图到达的 HTTP response 只能把对应 receipt/`uncertain` 更新为可证明的本地结果，绝不触发 Task、另一个发送或重试。

从 `off` 切到 `proxy/open` 时，在 transition mutex 与写 permit 下创建新 epoch；确认旧 client、transport、active registry 和 timer 均为 0 后才进入 `opening`，验证唯一新 client 后开放 admission。`proxy` 缺少精确受控代理即失败关闭，只有 `open` 允许直连；旧 epoch 回调永远只能走本地收口路径。

竞态测试必须在“permit 前/后、Task `BEGIN` 后、`COMMIT` 紧前/后、HTTP issue 紧前/后、response 紧前/后”逐点设置 barrier。逐项证明：Task 只可能 commit-before-close 或 rollback；issue-before-close 只可能得到 receipt 或 `uncertain`；issue-after-close 为 0；drain 超时不谎报 disconnected；crash 在 issue intent 后恢复为 `uncertain`；晚响应不产生 Task/发送；快速 `off → open → off` 无旧 epoch 重连且全程最多一个 client。

### 6.7 留存、清理与失败语义

TTL 从记录达到可证明的终结状态后开始；`received/bridging/pending/sending/retry/uncertain`、未决死信或仍关联未完成 Task 的记录**一律不因年龄自动删除**。

| 数据 | 冻结 TTL | 终结/清理条件 |
|---|---:|---|
| inbox 最小加密 payload | 7 天 | `bridged/rejected/failed` 且 Task 映射已持久化；随后删除内容，仅留去重摘要 |
| `external_requests` 与消息去重映射 | 90 天 | 关联 Task 已 Archived 或外部请求已 rejected/failed；入口拒绝 `create_time` 早于当前 24 小时的事件 |
| `feishu_event_deliveries` | 30 天 | 关联消息/action 已终结；未终结不删 |
| 未消费 action token | 15 分钟可用 | 到期即不可消费；到期后保留 hash 30 天防重放 |
| 已消费/拒绝 action 记录 | 30 天 | 本地动作已终结；未决动作不删 |
| `sent` outbox | 14 天 | 已保存平台结果摘要；`pending/sending/retry` 不删 |
| `uncertain` outbox | 对账前不限期 | 不自动重发；只在官方查询或人工对账得到证据后转 `sent/dead` 并记录本地 resolution |
| dead letter | 人工处置前不限期；处置后 30 天 | 明确标记 `resolved/abandoned` 后才开始计时 |
| 脱敏审计计数 | 90 天 | 不含原文、原始 ID、token 或绝对路径 |
| DPAPI 凭据 | 无自动 TTL | 仅显式停用并轮换/撤销后删除 |

清理任务每天在单实例 lease 下分批执行，启用 SQLite `secure_delete`，删除后 checkpoint/truncate WAL；空闲维护窗口再压缩数据库。应用生成的备份、诊断包、发布包和日志明确排除 integration SQLite、payload、DPAPI blob 与 WAL/SHM。外部系统级备份不承诺物理远程擦除，需由设备备份策略另行治理。

清理用短事务且可崩溃重入；失败不回退 TTL、不删未终结项。连续 24 小时无法清理已过期敏感 payload 时健康状态变为 `retention_blocked`，按第 6.6 节主动断开长连接并停止新收件，待桌面修复后显式恢复。

## 7. Task v2 桥接语义

### 7.1 消息到任务

MVP 只接受两类入口：可用范围内用户的机器人单聊，以及 allowlist 群内明确 @ 机器人。`sender_type=bot` 一律忽略，防止机器人互相触发。

桥接结果固定为：

- 新建或复用一个 `Draft` Task；
- 标题使用安全截断后的首行，正文标为 `source_trust=external_untrusted`；
- `acceptance` 默认为空，等待桌面补齐；
- 不自动提案、批准计划、创建隔离工作区、入队或启动 run；
- 回复“已进入任务收件箱”及脱敏任务短号，不宣称已执行。

飞书文本必须视为不可信外部输入。即使文本写着“忽略规则”“已经批准”“关闭沙箱”或伪造系统消息，也只能成为任务目标文本，不能改变运行控制、模型配置、权限、凭据或审批状态。

### 7.2 卡片动作

MVP 卡片只开放：

- `查看最新状态`：异步读取 Task 摘要后另发一条回复或新状态卡片，不原地更新旧卡；
- `在桌面打开`：返回本机操作提示，不暴露远程管理 token；
- `停止通知`：只停止该 Task 的飞书通知订阅，不停止任务本身。

卡片 value 只携带 envelope 版本和不透明 action token；该版本仅用于解析 envelope，不是 Task version：

```json
{
  "version": 1,
  "action_token": "fact_example_opaque_value"
}
```

不把 App Secret、会话 bearer、Task v2 expected version、task id、action 名称、文件路径、命令或审批 capability 放入卡片。消费时 task/action/expected version 只从第 6.2 节服务端 binding 读取，回调里同名字段完全不用。任何新增“取消任务”“回答问题”“批准”按钮都必须另做威胁建模和逐路由授权；危险副作用批准在 MVP 永远返回“请在桌面小蛇完成”。

### 7.3 本地接口落点

建议实施文件与职责如下：

| 文件 | 职责 |
|---|---|
| `harness/feishu_config.py` | 配置 schema、启停、脱敏公共状态；不返回凭据 |
| `harness/feishu_secrets.py` | 复用现有 DPAPI codec，存取集成 secret refs |
| `harness/feishu_ledger.py` | inbox/external request/outbox/lease/migration |
| `harness/feishu_events.py` | SDK typed handler、最小字段重建、3 秒快速确认 |
| `harness/feishu_bridge.py` | `client_token`/`request_id` 映射及 Task v2 原子桥接 |
| `harness/feishu_sender.py` | 分离的 send/reply、端点专用 uuid、限流、退避、死信；MVP 无 update-card |
| `harness/runtime_control.py` | `RuntimeControlStore`、writer-preferred online permit、epoch/cancellation、active HTTP registry |
| `harness/feishu_worker.py` | 单实例生命周期、主动断连、有界 drain、异步 worker、优雅退出 |
| `harness/task_store.py` | external request 与 Task 原子事务/migration |
| `harness/task_api.py` | 只暴露桌面可见的脱敏集成状态和死信处置；不得接收飞书公网回调 |
| `ui/js/panels/feishu.js` | 配置状态、连接健康、死信、停用/轮换入口；秘密只写不读 |

建议本机管理 API 只挂在既有回环 UI 服务，并继续使用现有本机鉴权：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/v2/integrations/feishu` | `GET` | 只返回 `enabled/configured/connected/last_event_at/outbox_counts` |
| `/api/v2/integrations/feishu/configure` | `POST` | 本机 UI 明确操作；secret 字段 write-only |
| `/api/v2/integrations/feishu/disable` | `POST` | 关闭 permit admission，线性化 Task/HTTP，主动断开 socket/transport；返回 closing/disconnected/disconnect_failed |
| `/api/v2/integrations/feishu/dead-letters` | `GET` | 脱敏摘要 |
| `/api/v2/integrations/feishu/dead-letters/:id/retry` | `POST` | 仅可证明未 issue 的 send/reply；`uncertain` 禁止调用，须先查询或人工对账 resolve |

## 8. 本地配置与密钥

### 8.1 配置 schema

非秘密配置落在被 Git 忽略的 `.state/integrations/feishu.json`。示例只含占位符和 secret ref，不含真实 ID：

```json
{
  "version": 1,
  "enabled": false,
  "transport": "websocket",
  "app_type": "self_built",
  "credential_ref": "feishu/main",
  "project_id": "prj_example",
  "ingress": {
    "direct_message": true,
    "group_at_only": true,
    "reject_attachments": true,
    "max_text_chars": 4000
  },
  "authorization": {
    "mode": "allowlist",
    "tenant_hash": "hmac-sha256:example",
    "sender_hashes": ["hmac-sha256:example"],
    "chat_hashes": ["hmac-sha256:example"]
  },
  "tasking": {
    "create_status": "Draft",
    "auto_queue": false,
    "auto_run": false,
    "dangerous_approval": "desktop_only"
  },
  "outbox": {
    "per_destination_qps": 4,
    "max_attempts": 8
  },
  "retention_days": {
    "inbox_payload": 7,
    "message_dedupe": 90,
    "event_delivery": 30,
    "sent_outbox": 14,
    "resolved_dead_letter": 30,
    "redacted_audit": 90
  }
}
```

实现时必须拒绝未知字段、非法枚举、绝对路径、非 HTTPS 自定义 API 地址以及 `auto_run=true`。MVP 不允许用户自定义 SDK WebSocket 或 OpenAPI 域名。

### 8.2 密钥保存

沿用项目现有 Windows 当前用户 DPAPI 实现，但为集成单独使用 `.state/integration_secrets.bin`；不要把飞书凭据混进模型 profile 或 `model_secrets.bin`。建议 secret bundle 包含：

- `app_id` 与 `app_secret`；
- configured tenant 的校验值；
- 日志 HMAC 盐；
- 配置凭据时的 Windows `owner_sid`；
- 若未来切换 HTTP callback，才另存 Encrypt Key / Verification Token。

长连接 dispatcher 按官方示例把 Encrypt Key 和 Verification Token 参数留为空字符串，不需要为 MVP 收集这两个值。SDK 取得的 tenant token 默认只在进程内使用；不得写入 JSON、SQLite、安装包或日志。若 SDK cache 需要持久化，必须另做 DPAPI 封装和过期清理后才能启用。

`S feishu configure` 的未来实现必须在本机交互式隐藏输入中接收秘密，并把当前 `WindowsIdentity.User.Value` 作为受 DPAPI 保护的 `owner_sid` 一同保存；不能支持 `--app-secret xxx`、URL query、剪贴板回显或普通环境变量长期保存。UI 保存后只显示“已配置/需轮换”，绝不回显、复制或导出原值。

worker 在导入 SDK、读 App ID/Secret 或创建任何 socket **之前**，必须比较当前进程 SID 与受保护的 `owner_sid`，并做一次 DPAPI 解密探测。SID 不一致或解密失败时以稳定错误 `FEISHU_OWNER_SID_MISMATCH` 失败关闭：不建连、不回退环境变量、不把期望/实际 SID 打到日志。

### 8.3 日志脱敏

允许记录：事件种类、HMAC 后的主键、状态、耗时桶、稳定错误码、重试次数、飞书诊断 ID 的脱敏摘要、队列长度。

禁止记录：Authorization、App ID/Secret、tenant/user token、Encrypt Key、Verification Token、完整 SDK event、原始消息文本、用户/群/租户原始 ID、卡片 action token、绝对路径、DPAPI blob。生产 SDK 日志级别使用 `WARN` 或更高，并接入项目现有 redactor；不得照抄官方示例里的 `print(JSON.marshal(data))`。

## 9. Windows 安装与后台运行草案

本节命令是**实现后的执行草案，当前没有运行**。官方 SDK 文档当前给出 `lark-oapi==1.4.0` 的长连接卡片示例；落地时应生成带所有 transitive SHA-256 的锁文件，不在生产机执行不受约束的 `pip install -U`。

### 9.1 依赖与配置

```powershell
$repo = (Resolve-Path 'C:\Users\example\Desktop\小蛇').Path
py -3 -m venv (Join-Path $repo '.venv-feishu')
& (Join-Path $repo '.venv-feishu\Scripts\python.exe') -m pip install --require-hashes -r (Join-Path $repo 'requirements-feishu.lock')

Set-Location $repo
S feishu configure
S feishu doctor --redacted
```

锁文件、SDK 许可证和软件成分清单进入 Git；`.venv-feishu`、`.state/integration_secrets.bin`、配置、SQLite 与日志均被忽略。`doctor --redacted` 只检查 configured、DPAPI 可解、SDK 可导入、Task v2 migration、出网状态和版本发布清单，不打印标识或秘密。

### 9.2 MVP：当前用户登录后台 worker

现有秘密受“当前 Windows 用户”DPAPI 保护。把进程直接改成 LocalSystem/LocalService 会无法解密或迫使降低密钥保护，因此 MVP 使用同一用户的 Task Scheduler 登录触发任务；它是后台 worker，**不冒充 Windows Service**，也不需要管理员权限或保存账号密码。

```powershell
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$ownerSid = $identity.User.Value
if ([string]::IsNullOrWhiteSpace($ownerSid)) { throw '无法解析当前交互用户 SID' }

$repo = (Resolve-Path 'C:\Users\example\Desktop\小蛇').Path
$python = Join-Path $repo '.venv-feishu\Scripts\python.exe'
$action = New-ScheduledTaskAction `
  -Execute $python `
  -Argument '-m harness.feishu_worker --config-ref feishu/main' `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $ownerSid
$principal = New-ScheduledTaskPrincipal `
  -UserId $ownerSid `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask `
  -TaskName 'Xiaoshe-FeishuWorker' `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force

function Resolve-AccountSid {
  param([Parameter(Mandatory = $true)][string]$Value)
  try {
    return ([System.Security.Principal.SecurityIdentifier]::new($Value)).Value
  } catch {
    return ([System.Security.Principal.NTAccount]::new($Value)).Translate(
      [System.Security.Principal.SecurityIdentifier]
    ).Value
  }
}

$registered = Get-ScheduledTask -TaskName 'Xiaoshe-FeishuWorker'
$registeredSid = Resolve-AccountSid $registered.Principal.UserId
$registeredRunLevel = [string]$registered.Principal.RunLevel
$registeredLogonType = [string]$registered.Principal.LogonType
if ($registeredSid -ne $ownerSid) { throw '计划任务 principal SID 与 DPAPI owner 不一致' }
if ($registeredRunLevel -ne 'Limited') { throw '计划任务不是 Limited 权限' }
if ($registeredLogonType -notin @('Interactive', 'InteractiveToken')) {
  throw '计划任务不是交互用户 token 登录类型'
}

Start-ScheduledTask -TaskName 'Xiaoshe-FeishuWorker'
Get-ScheduledTask -TaskName 'Xiaoshe-FeishuWorker'
Get-ScheduledTaskInfo -TaskName 'Xiaoshe-FeishuWorker'
S feishu doctor --redacted
```

worker 自身还必须在 `.state/integrations/feishu-worker.lock` 取得单实例 lease；Task Scheduler 的 `IgnoreNew` 不是跨手工启动的完整互斥。验收读取注册后的 `Principal.UserId/RunLevel/LogonType`，解析回 SID 后与 DPAPI owner 比较，并实际完成一次不回显内容的解密探测；只核对触发器用户名不算通过。

### 9.3 二期：真正 Windows Service

真正 SCM 服务只能在完成“专用低权限服务账号 + 服务身份可解密的独立凭据库 + service control handler + 安装/升级签名”后启用。不得把当前用户 DPAPI 文件复制给 LocalSystem，也不得在 `sc.exe` 命令行写服务账号密码。

届时由签名后的 service host 安装，命令形状才可为：

```powershell
sc.exe create XiaosheFeishuWorker binPath= '"C:\Program Files\Xiaoshe\xiaoshe-feishu-service.exe" --config-ref feishu/main' start= auto
sc.exe config XiaosheFeishuWorker obj= "NT SERVICE\XiaosheFeishuWorker"
sc.exe failure XiaosheFeishuWorker reset= 86400 actions= restart/60000/restart/300000
sc.exe start XiaosheFeishuWorker
sc.exe query XiaosheFeishuWorker
```

这些命令当前**不可执行**：service host 尚不存在，虚拟服务账号专用凭据库及其 ACL 也未实现。正式安装器必须让虚拟服务账号通过受控安装流程**重新导入**凭据，创建仅该服务 SID 可读、其他本地用户不可读的独立凭据库；不能复制或继续指向当前交互用户的 DPAPI 文件。MVP 验收不得把计划任务报告成 Windows Service。

## 10. 威胁模型

| 威胁 | 约束/缓解 |
|---|---|
| 飞书消息提示注入 | 全部标记 `external_untrusted`；只生成 Draft，不改变系统提示、权限、运行控制或配置 |
| 未授权成员触发 | 应用可用范围 + bot 所在群 + tenant/sender/chat allowlist 三层校验；缺一即拒 |
| 机器人互相循环 | `sender_type=bot` 拒绝；自己发出的 `message_id` 不再次桥接 |
| 平台至少一次投递/重连补投 | 消息按 `message_id` 幂等建 Task；`event_id` 只做投递审计；卡片业务消费独立按 action token 唯一，Task `client_token` 原子映射 |
| 卡片重放或转发 | value 只有 version/token；服务端 binding 单次、短期并绑定 actor scope/task/action/version，回调业务字段不用 |
| 飞书端越权审批 | MVP 卡片没有危险批准动作；Task v2 权限与桌面审批始终为权威 |
| App Secret 泄漏 | 当前用户 DPAPI、write-only UI、无命令行秘密、无日志、可轮换；停用后再轮换 |
| tenant token 泄漏 | 只在 SDK 进程内短期存在；不持久化、不回显、不记录 |
| 跨租户事件 | 校验 configured app/tenant；原始 tenant 只进受保护状态，日志仅 HMAC |
| 本机数据库被复制 | Windows 用户 ACL + `.state` Git 忽略；敏感 payload 最小化并设保留期；后续可加列级 DPAPI |
| 出站重复消息 | pre-issue 才可重试；issue 后无确定响应转 `uncertain` 且必须查询/人工对账，MVP 禁用 update-card |
| 关闭竞态产生迟到副作用 | writer-preferred online permit + epoch；Task pre-commit 双检，HTTP issue 登记；晚响应仅写本地 receipt |
| worker 被远程利用开端口 | 架构中无 HTTP listener；验收对比监听端口；只允许 SDK 出站连接 |
| 凭据撤销/应用停用 | 建连失败退避；稳定显示 disconnected；不删除 inbox，不静默切换其他应用 |

## 11. 分阶段实施

### 阶段 A：离线契约与账本

- 新增配置/secret schema、SQLite migration、event minimizer、幂等与 outbox 测试；
- 使用合成事件，不安装 SDK、不创建应用；
- 给 Task v2 增加 external `client_token` 原子创建，解决第 6.2 节阻断项；
- 验证所有 API 和日志只返回脱敏状态。

### 阶段 B：官方 SDK 长连接 worker

- 固定并锁定 `lark-oapi` 版本与 hashes；
- 注册 `im.message.receive_v1` 和 `card.action.trigger` typed handler；
- 回调只落账和确认，bridge/sender 独立线程处理；
- 接 Task Scheduler 单实例、优雅停止、重连健康状态。

### 阶段 C：小范围真实租户试点

- 管理员按第 4 节创建企业自建应用并限制可用范围；
- 用一名单聊用户、一个 allowlist 群做真实投递、重推、断网和凭据轮换验收；
- 确认没有新增公网/LAN 入站端口；
- 试点证据全部脱敏，不保存真实密钥或完整消息。

### 阶段 D：后续能力

- 用户 OAuth：仅在有明确用户资源需求时另行设计；
- 飞书原生审批：先做通知/镜像，再评估风险级别映射；
- 高可用多 worker：先做 lease/共享账本，再利用平台集群投递；
- 原地更新卡片：先锁定并引用准确的官方 API、权限、限流与并发语义，再按第 6.4 节建立独立版本账本；不得复用消息 outbox 的 uuid；
- 附件、语音、流式回复：分别增加内容安全、大小、下载和保留策略。

## 12. 验收清单

### 12.1 离线自动化

- [ ] 未知 event type、错误 schema、跨 tenant、非 allowlist sender/chat 均失败关闭。
- [ ] 同一 `message_id` 配不同 `event_id` 重放 100 次，只得到一个 Task。
- [ ] 卡片 value 只有 version/token；伪造 payload task/action/expected version 完全不影响服务端 binding 选择。缺失/过期 binding、跨 actor scope、同 token 换 `event_id` 或并发点击均 fail closed，只有一次合法消费。
- [ ] handler 人工注入 10 秒模型延迟，确认耗时仍 p99 < 500 ms；回调线程从不触发模型。
- [ ] SQLite 忙/磁盘写失败时 handler 不确认成功，恢复后平台重推可入账。
- [ ] 在 inbox commit、Task create、mapping update、outbox commit 各 crash point 重启，均不重复建 Task/发消息。
- [ ] 用 barrier 覆盖 permit、Task `BEGIN/COMMIT` 和 HTTP issue/response 前后：Task 只 commit-before-close 或 rollback；关闭线性化点后 Task commit 与新 HTTP issue 都为 0。
- [ ] HTTP issue 后 crash、取消失败、drain 超时或进程退出均恢复为 `uncertain` 且不自动重发；官方查询未实现时只能人工对账，晚 response 只更新 receipt，不触发 Task/发送。
- [ ] Task v2 version 冲突进入待处理，不覆盖桌面较新状态。
- [ ] 飞书消息只创建 Draft；没有 plan approval、queue item、run 或副作用记录。
- [ ] 卡片伪造“批准危险命令”始终拒绝并提示桌面处理。
- [ ] 固定向量验证 `send`/`reply` uuid 均为 45 字符且互不相同；429/`230020`/5xx 退避时，同一 outbox 项逐字节复用其端点专用 uuid，超窗不确定项进死信。
- [ ] 留存清理只删除第 6.7 节允许的终结记录；crash 后可重入且不提前删除未决项，连续 24 小时失败会进入 `retention_blocked` 并主动断开连接。
- [ ] 单元测试抓取日志、API、诊断包、崩溃报告，确认无凭据、token、原始 ID、原文或绝对路径。
- [ ] `git diff --cached` 和 tracked file secret scan 无 App ID/Secret、token、`.state`、SQLite、日志。

### 12.2 Windows 本机

- [ ] `requirements-feishu.lock` hashes 可从干净环境复现安装，许可证/SBOM 齐全。
- [ ] `S feishu doctor --redacted` 只显示 configured/connected/版本，不回显标识或秘密。
- [ ] 新登录后计划任务的 `Principal.UserId` 解析为受保护 `owner_sid`，`RunLevel=Limited`、`LogonType=Interactive`，实际 DPAPI 解密探测成功；第二实例被单实例 lease 拒绝。
- [ ] worker 断网显示 disconnected，恢复后重连；已入账 inbox/outbox 不丢失。
- [ ] `Get-NetTCPConnection -State Listen` 前后对比没有小蛇飞书新增监听端口。
- [ ] 已连接时切到 `off` 会关闭 permit admission，等待/回滚 Task 事务并有界 drain HTTP；只有 socket、transport、active permit/request、旧 worker/timer 全归零才显示 disconnected，超时显示 disconnect_failed。快速 `off → open → off` 无迟到重连。

### 12.3 飞书真实试点

- [ ] 应用是企业自建、已开启机器人能力、使用长连接，且只包含第 4.1 节最小权限。
- [ ] 新版本已审核发布，可用范围只有试点人员；群中添加的是应用机器人。
- [ ] 允许用户单聊产生一个 Draft Task，并收到“已进入收件箱”；不允许用户不产生任务。
- [ ] 群内普通消息不触发，只有 @ 机器人触发；机器人消息不触发。
- [ ] 人工制造 handler 超时后，平台重推仍只产生一个 Task。
- [ ] “查看最新状态”会另发回复或新状态卡片，不调用原地更新卡片 API；任何危险批准动作都只能在桌面完成。
- [ ] App Secret 轮换后旧值失效、新值恢复连接；Kimi/DeepSeek 等模型配置不受影响。

## 13. 故障排查

| 现象 | 优先检查 | 处理 |
|---|---|---|
| worker 启动但未连接 | 出网、系统时间、App 凭据、应用是否企业自建、SDK 版本 | 保持断开并退避；不要开放公网端口 |
| 已连接但收不到消息 | 是否发布新版本、是否添加 `im.message.receive_v1`、scope、可用范围 | 在开放平台“事件日志检索”核对是否投递 |
| 单聊有消息、群里没有 | bot 是否在群、是否 @、`group_at` scope、群发言权限 | 不升级为 `group_msg` 来绕过配置问题 |
| 卡片点击无响应/重复 | 是否只订阅新版 `card.action.trigger`、handler 是否超 3 秒、action token 状态 | 删除旧版/历史请求地址；回调只入账 |
| 重复 Task | `message_id` 唯一约束、external request 与 Task 是否同事务、是否多 worker | 停用接入，修复/回放账本后再启用 |
| 回复被限流 | 目标 5 QPS、错误 `230020`、本地令牌桶和重试时间 | 降速并逐字节复用该 reply outbox 的 `fsr1_...` uuid；不要并发补发或改走 send |
| 回复 230002/230013 | bot 不在群；用户不在应用可用范围 | 修正群成员或版本可用范围，不扩大权限 |
| DPAPI 解密失败 | worker 是否换了 Windows 用户、状态目录 ACL | 停止 worker；用原用户轮换，不复制明文 |
| Task Scheduler 显示运行但连接数异常 | 是否有手工 worker、锁文件 lease、同应用其他机器 | 保留一个实例；不要用平台随机投递当广播 |
| `uncertain`/死信持续增长 | issue/receipt 时间、稳定错误码、凭据/发布/权限、出站 API 状态 | `uncertain` 先查询或人工对账；不批量盲重试 |

## 14. 停用与回滚

回滚顺序必须先阻止新输入，再处理本地未决项：

1. 在桌面点击“停用飞书接入”，原子写 `enabled=false`，并严格执行第 6.6 节 permit/epoch 关闭时序：Task 只允许关闭前提交或回滚；已经 issue 的 HTTP 有界 drain，未知结果转 `uncertain`，不声称能撤回、不自动重发。所有 socket、transport、active 项和 timer 归零后才报告 disconnected。
2. 停止并移除登录任务：

   ```powershell
   Stop-ScheduledTask -TaskName 'Xiaoshe-FeishuWorker'
   Unregister-ScheduledTask -TaskName 'Xiaoshe-FeishuWorker' -Confirm:$false
   ```

3. 导出**脱敏**的 inbox/outbox/dead-letter 计数和哈希清单；不要导出消息原文或凭据。未确认出站项默认不重发。
4. 在飞书后台创建回滚版本，移除事件/回调或缩小可用范围，并完成审核发布。只停止本地 worker 不等于撤销飞书侧权限。
5. 轮换/作废 App Secret。确认不再需要后，通过本地“删除集成凭据”清除 DPAPI secret bundle；不得删除 Kimi/DeepSeek 或其他模型密钥。
6. 严格按第 6.7 节清理已达到终结状态且 TTL 到期的飞书内容；未决 inbox/outbox/dead-letter、仍关联未完成 Task 的记录不得因停用或年龄删除。保留不含敏感数据的迁移版本与审计计数。

若只是临时断网或飞书故障，不自动删除配置或切换群自定义 Webhook；界面如实显示 disconnected，并保留可恢复账本。

## 15. 上线门禁

以下任一项未满足，接入保持 `enabled=false`：

- Task v2 外部 `client_token` 原子幂等未实现；
- 3 秒 handler 仍包含模型、Task v2 或网络发送；
- 飞书卡片可以直接批准危险副作用；
- 凭据能从 UI/API/log/安装包/Git 回显；
- 应用权限超过第 4.1 节且没有单独批准；
- 应用版本未发布或可用范围未限制；
- worker 会监听入站端口、自动开启公网回调或可并发多实例；
- 重复、crash、断网、限流、轮换和回滚验收未通过。
