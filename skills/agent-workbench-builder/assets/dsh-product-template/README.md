# __PROJECT_TITLE_TEXT__

这是一个以外部 DeepSeek Harness（DSH）为底座的 `__PROJECT_PRODUCT_KIND_TEXT__` 产品工程。DSH 不在本项目、Builder 或交接包中；请从[官方仓库](https://github.com/deepseek-ai/deepseek-harness)单独安装。

## 产品合同

- 产品类型：`__PROJECT_PRODUCT_KIND_TEXT__`
- 统一目标：__PROJECT_PURPOSE_TEXT__
- 主要使用者：__PROJECT_PRIMARY_USER_TEXT__ 等
- 能力模块、代表性场景及每条场景的触发、输入、可观察结果：见 `agent_project.json`
- 受控写动作：__PROJECT_DANGEROUS_WRITE_TEXT__

`focused-agent` 可以只有一个能力和一条主场景；`workbench` 必须有多个能力模块以及至少三条代表性场景。代表性场景用于验收，不限制用户只能提出这些任务；真正可处理的任务仍受已注册能力、权限与现场约束。

## 第一次运行

1. 固定克隆实测标签：`git clone --branch dsh-v0.1.0-rc.8 https://github.com/deepseek-ai/deepseek-harness.git`。这是 XS/Builder 的兼容边界，不代表当前最新 DSH；同时需要 pnpm `11.7.0`、Node `22.19+` 或 `24+`。
2. 把外部 checkout 位置临时放入 `DSH_ROOT`；不要把它复制到本项目。
3. 运行本地测试与外部运行时验收：

```sh
python3 tools/test_project.py
python3 tools/acceptance.py --dsh-root "$DSH_ROOT" --pretty
```

4. 只为本项目创建隔离的 Profile 状态并接入本地 Bundle：

```sh
export DSH_HOME="$PWD/.runtime/dsh-home"
pnpm --dir "$DSH_ROOT" dsh plugin --profile web add "$PWD"
pnpm --dir "$DSH_ROOT" dsh web --dump-config
pnpm --dir "$DSH_ROOT" dsh web --no-open
```

`.runtime/` 只有可重建的 Profile 状态，已被排除在版本控制与交接包外。`plugin add` 只把本项目 Bundle 接入外部 DSH，不下载或复制 DSH 源码。

## 产品边界

- DSH 负责 Agent 循环、会话、模型、工具流水线、审批、沙箱和 Web。
- `agent_project.json` 是产品目标、能力和代表性场景的事实源。
- `src/domain.mjs` 校验统一任务输入并选择场景；`src/capabilities.mjs` 承载能力适配。
- `src/plugin.mjs` 为每个能力注册只读 plan 工具；只有标为 `approval-required` 的能力才有 commit 工具，并在 DSH `tools/pre-execute` 返回 `ask`。
- `src/workflow.mjs` 负责默认拒绝、原子写、幂等账本、冲突拒绝和可追踪收据。
- `cordis.patch.yml` 是 Product Bundle 层，不修改 DSH 内核。

当前 `development.stage=starter`。模板夹具只能验证工程框架，毕业评估预期为 `PARTIAL`。必须把 `src/capabilities.mjs`、`fixtures/domain-cases.json` 和 `tests/domain-fixtures.test.mjs` 换成目标领域的真实行为，覆盖每条场景、每项能力和至少一个拒绝边界；全部通过后才改为 `domain-adapted`。接入真实模型、账号或第三方工具后，另做真实账号验收。

## 打包与回退

```sh
python3 tools/package_handoff.py --pretty
```

交接 ZIP 带逐文件与归档 SHA-256，并断言 DSH、`node_modules`、`.runtime` 和机器绝对路径不进入归档。回退时停止 DSH，只删除本项目的 `.runtime/` 与 `work/`，再恢复上一份交接包；不要删除外部 DSH。
