# Plan 01–03 最终交付闭包

> 来源：对 `ab36d6c..7f8f068` 的独立 clean-HEAD 终审。只修复终审可复现的交付依赖，不夹带当前工作树中的后续 tasking/schema 开发。

## Task A — `tasking_mode()` clean-HEAD 启动闭包

**Files:**
- Modify: `harness/config.py`（仅现有 8 行 `tasking_mode()` hunk）
- Create: `tests/test_final_delivery_closure.py`

1. RED 必须在 clean HEAD 直接证明 `UISession` 初始化因 `config.tasking_mode` 缺失而失败；测试不得用 `mock.patch(..., create=True)` 绕过真实依赖。
2. 配置契约必须验证：未配置时为 `off`；`off/on/shadow` 三值逐次运行时读取并接受；空白/大小写按规范归一；其他值稳定拒绝。测试用占位配置且不得读取真实 `.env`。
3. GREEN 只提交 `tasking_mode()` 依赖和专项测试；重跑完整 UI server、Plan01/02 聚焦集与 clean-HEAD 组合集。不得提交 `config.py` 的 provider/tasking 之外 hunk。
4. 独立审查通过后才进入 Task B。

## Task B — queue schema 迁移测试闭包

**Files:**
- Modify: `tests/test_task_queue.py`（仅 v11 迁移测试 hunk）

1. RED 必须在 clean HEAD 复现产品 `TaskStore.SCHEMA_VERSION == 13`、测试仍硬编码 `12` 的失败。
2. GREEN 将测试命名改为“迁移到当前 schema”，版本断言引用 `TaskStore.SCHEMA_VERSION`；同时验证 schema 13 的 `lease_owner`、`lease_generation`、`lease_expires_at` 列及 `queue_items_expired_lease` 索引，并保留原任务数据。
3. 当前工作树后续 schema 16、budget ledger、额外 queue 用例均不属于本提交；必须用精确 index patch 隔离。重跑单测、TaskStore/Queue 聚焦集、clean-HEAD 组合集。
4. 独立审查通过后，重新运行全量 Python、前端 Node、UI 契约、compileall 与 smoke，并再次做最终总审查。

## Task C — 新建会话存档签名闭包

**Files:**
- Modify: `harness/session.py`（仅 `tasking_project_id` 可选参数与非空持久化）

1. RED 在 clean HEAD 通过真实 `/api/sessions/new` 复现 `session.save_session(..., tasking_project_id=...)` 与签名不匹配导致 HTTP 500；模型使用占位配置且不得发送请求。
2. GREEN 让 `save_session` 向后兼容原位置参数，并仅在非 `None` 时记录 `tasking_project_id`；空值与旧档案行为不变。
3. 当前工作树的 `task_id`、`run_id`、`load_session` 元数据补齐属于后续开发，不得进入本提交。重跑 session/UI session/new 与兼容回归，独立审查后提交。

## Task D — clean 测试包与 provider 隔离闭包

**Files:**
- Modify: `tests/ui_server/test_autonomy_model.py`（仅旧默认 model_fn 用例）
- Modify: `tests/ui_server/test_contract_unit.py`（仅 UTF-8 子进程调用）
- Modify: `tests/test_task_store.py`（仅旧 schema 12 断言）
- Create: `tests/ui_contract/fixtures/state.json`
- Create: `tests/fixtures/tasking/schema_v1.sql`

1. RED 在无真实 provider 环境的 clean HEAD 复现：旧测试 patch 已废弃 `kimi_chat` 后进入真实 `ModelClient` transport；缺 `state.json` 与 `schema_v1.sql`；Windows validator 输出被错误解码；v1 fixture 补齐后旧测试仍将当前 schema 13 写死为 12。
2. GREEN 让旧模型用例直接 mock 当前 `ModelClient.chat` 并验证会话模型 ID 转发，禁止任何 curl/provider 调用；fixture 只含固定样例，无密钥；validator 子进程显式 `-X utf8` 并严格 UTF-8 解码；迁移测试引用 `TaskStore.SCHEMA_VERSION`，不得伪造 fixture 或回退产品版本。
3. 不得提交模型管理新用例、validator 新字段、schema 16 或其他当前工作树修改。重跑 clean 完整 UI server、TaskStore、契约、provider-no-call 探针并独立审查。
4. Task D 通过后才运行最终全量回归和总审查。

## Acceptance

- clean HEAD 可直接创建 UI session，不依赖任何未提交文件。
- clean HEAD 的 v11 fixture 可迁移到提交中的当前 schema，租约结构与索引真实存在。
- clean HEAD 新建会话返回成功并可保存项目绑定；测试包不读取真实 provider 凭据，也不会发送模型请求。
- 四个实现 Task 均无 `.env`、`.state`、密钥、模型调用或无关工作树 hunk；staged 在每次提交后为 0。
