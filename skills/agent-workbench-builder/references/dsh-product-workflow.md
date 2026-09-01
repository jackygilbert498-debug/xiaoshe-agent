# 外部 DSH 产品工作流

## 受支持边界

官方仓库：<https://github.com/deepseek-ai/deepseek-harness>。XS/Builder 当前实测边界为 `0.1.0-rc.8`，它不是当前最新版本。DSH 官方说明其处于开发者预览并可能发生破坏性变更，因此使用 `git clone --branch dsh-v0.1.0-rc.8 https://github.com/deepseek-ai/deepseek-harness.git` 加 doctor，不使用未经证明的 main 或宽松版本范围。

Builder 不拥有 DSH 安装：

- 不把 DSH 源码、构建产物、`node_modules` 或 Profile 状态放入 Skill、项目或 ZIP。
- 不提供下载器，不在脚手架阶段执行 `git clone`、`npx` 或包安装。
- 用户从官方链接独立安装；Builder 只读取 `--dsh-root` 并在临时 `DSH_HOME` 验证。

## DSH 的正式扩展点

一个 DSH 产品使用三层：

1. **外部运行时**：`dsh-base` 与 `dsh-web-app` 提供 Agent 循环、会话、模型、工具、审批、沙箱、持久化与 Web。
2. **Product Bundle**：项目 `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`；patch 设置产品身份并插入产品插件。
3. **能力实现**：产品插件注册能力目录、每项能力的只读 plan 工具，并只为需要写入的能力注册 commit 工具；业务状态与输出由产品拥有。

`focused-agent` 只有一项能力。`workbench` 以同一产品目的组织多项能力；DSH 工具名、schema、审批说明和能力适配器必须一一对应，不能用一个“万能字符串工具”吞掉所有任务。

不要直接改 DSH 源码。新产品通过独立 Bundle 接入 Profile，机器本地 Profile 状态放在项目忽略的 `.runtime/dsh-home` 或用户选择的其他 `DSH_HOME`。

## 审批与写入

危险工具在 `tools/pre-execute` 监听器中返回：

```js
{ kind: 'ask', reason: '明确描述将发生的业务写入' }
```

DSH 将其交给一次性 approval seam；审批通道缺失、取消或拒绝都关闭式失败。工具实现收到执行权后仍只写工作区内的声明目录，并使用原子写、稳定幂等键和冲突拒绝。不要让模型提供任意输出路径或 shell 字符串。只读能力不能伪装成需要审批的写工具，危险能力也不能因位于 workbench 中而绕过审批。

## 隔离验收

验收使用临时 `DSH_HOME`：

1. 用官方 `dsh plugin --profile web add <product>` 接入本地 Bundle。
2. `dsh web --dump-config` 必须包含产品包名与 DSH 六类关键能力。
3. 对每条代表场景执行领域夹具；workbench 证明能力覆盖集合与合同完全一致。fresh starter 的夹具可以验证框架，但领域门仍为 `PARTIAL`。
4. 从产品 workspace 启动 Web，轮询固定 loopback 端口得到 HTTP 200 与完整 HTML。
5. 通过 bootstrap stdin 哨兵进入 DSH 的 SIGTERM 清理路径并等待退出码 0；直接 terminate/kill 只作失败回退。
6. 全程关闭遥测，不继承模型密钥，不发真实模型请求。

Windows 上若 Product Bundle 路径含空格或非 ASCII，Builder 只把项目源文件暂存到 ASCII 无空格临时目录，排除 evidence、dist、work、`.runtime`、`_handoff` 和 `node_modules`，并核对源/暂存树摘要。DSH checkout 始终不复制、不修改。

这证明 Profile 解析、Bundle 装载、能力工具、代表场景、Web 宿主和退出生命周期。真实模型、真实账号、MCP 或业务 API 需另开验收门。

## 交接

ZIP manifest 的 `externalDependencies` 只记录官方链接、实测版本和 `bundled=false`，并记录产品形态、能力数与代表场景数。接收者先安装外部 DSH，再运行 doctor、项目测试、acceptance 和毕业评估。解压后不得依赖作者机器的 Profile、缓存或绝对路径。
