# __PROJECT_TITLE_TEXT__

这是一个由 `agent-workbench-builder` 创建的可移植 Agent 工程基线。它实现的场景是：**__PROJECT_SCENARIO_TEXT__**。

## 场景合同

- 主要使用者：__PROJECT_PRIMARY_USER_TEXT__
- 触发条件：__PROJECT_TRIGGER_TEXT__
- 输入：__PROJECT_INPUT_DESCRIPTION_TEXT__
- 可观察输出：__PROJECT_OBSERVABLE_OUTPUT_TEXT__
- 受控写动作：__PROJECT_DANGEROUS_WRITE_TEXT__

项目内置的 `ReferenceProvider` 是确定性的离线适配器，用来证明审批、幂等、恢复、界面和交接链路。当前 `development.stage=starter`，因此毕业评估预期为 `PARTIAL`。它不是外部大模型，也不证明任何第三方账号已经就绪。把项目用于真实业务前，请替换 `agent_workbench/domain.py`、`fixtures/domain-cases.json` 和领域测试，覆盖正向与拒绝边界，最后才改为 `domain-adapted`。

## 运行基线

要求 Python 3.11–3.13；不依赖第三方包。

```bash
python3 -m unittest discover -s tests -v
python3 tools/acceptance.py --output evidence/acceptance.json
python3 tools/package_handoff.py --output-dir dist
```

运行一次批准路径：

```bash
python3 -m agent_workbench.cli \
  --input demo/input/request.json \
  --approve \
  --run-id manual-approved
```

不传 `--approve` 时默认拒绝业务写入：

```bash
python3 -m agent_workbench.cli \
  --input demo/input/request.json \
  --run-id manual-denied
```

启动只读状态页：

```bash
python3 -m agent_workbench.server --host 127.0.0.1 --port 8765
```

然后打开 `http://127.0.0.1:8765/`。健康接口为 `/api/health`，状态接口为 `/api/status`。

## 安全与恢复

- 业务写入只发生在显式 `--approve` 后；默认路径为拒绝。
- 同一请求的幂等键已写入账本，重复运行只返回既有结果，不重复创建业务产物。
- 原子写入失败不会留下半个 JSON；账本与产物不一致时返回 `IDEMPOTENCY_CONFLICT`，不会盲目覆盖。
- 本地运行数据位于 `work/`，验收使用临时目录，不触碰真实运行数据。
- 回退：停止本地进程并删除项目目录即可；模板不安装服务、不修改系统配置。

## 毕业

模板生成不是毕业。请从 Builder Skill 运行 `scripts/evaluate_project.py`，以 `evidence/graduation.json` 的 `PASS`、七个硬门、20 分维度和交接 ZIP 哈希为准。自动 PASS 仍不等于独立真人盲测或真实供应商验收。
