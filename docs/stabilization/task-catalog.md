# 30 项固定任务与证据边界

机器定义唯一来源为 `scripts/quality/task-catalog.mjs`。每项包含固定 ID、真实目标、必须通过的检查、所需执行方式和外部条件。目录定义本身不代表执行；30 项定义不能写成 30 项通过。

## 执行方式

- `live_model`：当前模型实际选择并调用工具完成目标。
- `product_no_model`：实际产品交互、浏览器或生命周期流程，不调用模型。
- `component_fixture`：测试程序串联组件或替身；即使读写文件和网页真实发生，也不能证明模型会完成任务。
- `manual`、`unknown`：保留参考，不替代上述固定任务要求。

高频主线 `material-browser-delivery` 要求资料读取、结构结果回读、网页提交、服务器存储核对、新页面回读、原资料未修改全部通过。`run-material-workflow` 的组件证明只记为 `fixture_only`，不会增加真实模型任务通过数。

## 最小报告格式

执行者产生 `xiaoshe-task-run/v1` JSON；索引器只读显式指定的报告，不读取报告中的文档、会话、账号、工具参数或产物路径。

```json
{
  "schema": "xiaoshe-task-run/v1",
  "runId": "unique-run-id",
  "createdAt": "2026-09-07T01:01:00.000Z",
  "finishedAt": "2026-09-07T01:02:00.000Z",
  "binding": { "sourceSha256": "64 lowercase hex characters", "runtimeIdentity": null },
  "executionKind": "component_fixture",
  "tasks": [{
    "taskId": "material-browser-delivery",
    "state": "pass",
    "checks": [
      { "id": "source-read", "state": "pass" },
      { "id": "structured-output-readback", "state": "pass" },
      { "id": "browser-submitted", "state": "pass" },
      { "id": "server-value-matched", "state": "pass" },
      { "id": "page-readback-matched", "state": "pass" },
      { "id": "original-input-unchanged", "state": "pass" }
    ],
    "metrics": {
      "durationMs": null, "retryCount": null, "humanInterventions": null,
      "inputTokens": null, "outputTokens": null, "cost": null
    }
  }],
  "cleanup": [{ "id": "owned-fixture-cleanup", "state": "pass" }]
}
```

所有必需检查与清理均通过才具有完整证据。未知测量为 `null`；有实际账单时费用为 `{ "amount": 0.02, "currency": "USD" }`。`live_model` 与 `product_no_model` 的当前通过还必须与调用方已核对的 `runtimeIdentity` 匹配；没有运行身份不会默认为健康。

本工具验证报告的结构、来源文件内容哈希、候选绑定、时间和任务契约，不是第三方认证或反篡改签名系统。执行者仍须提供真实独立观察；手填通过不能创造真实模型证据。

## CLI 与现有门禁连接

```sh
node scripts/quality/task-evidence.mjs \
  --source-sha <当前源码SHA256> --since <本候选开始ISO时间> \
  --report <明确指定的报告.json> \
  --output <证据索引.json> --summary <中文摘要.md>
```

`--report` 可重复，也可不提供；不提供时输出 30 项未执行。`--runtime-identity` 传入当前隔离实例的已核对身份。`--root` 默认本项目 Git 根；CLI 会重新核对实际源码，错误 SHA 或索引期间源码变化会拒绝写入。项目内输出必须同时位于 `output/` 且通过实际 `git check-ignore` 核验；目录名字本身不算忽略规则，未创建的新路径也会检查，已跟踪文件拒绝覆盖。也可显式输出到项目外；不得覆盖输入报告。两种输出都在任何写入前预检，避免新报告进入源码清单污染其自身的候选身份。`--until` 可固定不晚于执行时刻的截止时间生成可重复结果。

正常生成部分索引退出码为 0，但 `complete:false`；完整性错误退出 1。需要覆盖门时显式加 `--require-complete`，此时不足 30 项完整当前任务证据也退出 1。这不是签名、发行或通用能力成功率门。

现有 `verify:internal` 报告仅记录构建/类型/测试阶段证据，不推导任何固定任务通过。复杂 live 报告复用原 scenario/checks、cleanup 与 gate 提供的 acceptanceBinding；需真实 `finishedAt` 才能计入当前证据。缺少时间/绑定的旧版报告保留为历史或未绑定参考，不使用文件修改时间代替执行时间。

可导入 `buildTaskEvidence({ sourceSha256, runtimeIdentity, since, until, reportPaths })` 与 `renderTaskEvidenceSummary(index)`。导入接口不扫描源码，由现有 gate 在源码前后身份一致后提供真实候选 SHA；CLI 自行执行相同核对。索引不会启动服务或运行模型。

同一报告路径、内容或 runId 重复会报完整性错误。不同运行的同一任务只算一项；同一候选窗口的失败不会被后续成功覆盖。修改后应使用新源码身份和新候选窗口，历史失败保留为参考。
