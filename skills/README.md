# 小蛇配套 Skills

这里公开的是小蛇项目沉淀出的两套可复用 Skill。它们面向 Codex 等支持本地文件与命令执行的编程 Agent；不同产品的 Skill 安装方式可能不同，但 `SKILL.md`、脚本、测试与参考资料本身都是普通文件。

## 选择哪一个

| Skill | 适合的任务 | 不负责什么 |
| --- | --- | --- |
| [`agent-workbench-builder`](agent-workbench-builder) | 把真实工作或生活场景做成可验证、可重跑、可交接的 focused Agent 或多能力工作台 | 不承诺复制小蛇外观，也不把刚生成的 starter 判为毕业项目 |
| [`xiaoshe-project-history`](xiaoshe-project-history) | 只读配置、诊断、盘点、比较、补缺和导出小蛇项目历史证据 | 不修改来源工作树，不自动恢复 stash，不把“未发现”写成“不存在” |

如果你是 AI 辅助编程新手，先从 `agent-workbench-builder` 的 `focused-agent` 路线开始：只解决一类真实问题，固定输入、可观察结果和危险写动作，再让 AI 按 Skill 的停止条件逐步施工。只有同一产品目的确实需要多项能力时，才选择 `workbench`。

## 获取与安装

先克隆仓库：

```bash
git clone https://github.com/jackygilbert498-debug/xiaoshe-agent.git
cd xiaoshe-agent
```

把所需 Skill 目录复制或链接到你的 Agent 所使用的 Skills 目录；也可以直接让 Agent 在本仓库中完整读取对应 `SKILL.md`。安装位置由具体 Agent 决定，不要把本机 API Key、历史来源配置或运行期数据提交到仓库。

Builder 使用外置 DeepSeek Harness。当前经过这套 Skill 与参考项目验证的固定边界是 `dsh-v0.1.0-rc.8`，不是“自动兼容最新 main”：

```bash
git clone --branch dsh-v0.1.0-rc.8 https://github.com/deepseek-ai/deepseek-harness.git
```

## 自检

以下命令只依赖 Python 3.11–3.13 标准库；Skill 元数据快速校验另需 Codex 自带的 `quick_validate.py`。

```bash
python -m unittest discover -s skills/agent-workbench-builder/tests -p "test_*.py" -v
python skills/xiaoshe-project-history/scripts/run_tests.py
```

发布前验证覆盖 Builder 21 项测试、History 67 项测试，以及 Builder 的 focused-agent、workbench 两条 AI 辅助干净复现。复现报告位于 `agent-workbench-builder/evals/`。这些结果证明脚本化合同与参考流程可重复，不替代独立真人新手盲测；真人盲测未执行时必须保持 `HUMAN-BLIND-TEST: NOT-RUN`。

## 使用边界

- Starter 只是结构完整的起点，毕业评估应为 `PARTIAL`；完成领域改造与七个硬门后才可能为 `PASS`。
- 发布、发送消息、付费调用、删除、覆盖以及其他危险写操作，仍需调用者明确授权。
- DSH、真实模型账号、macOS/Windows 设备、签名安装和外部分发分别验证；一个通过不能替代另一个。
- 本仓库当前公开可读不等于自动获得未声明的再分发许可；使用前请同时检查仓库许可证状态。
