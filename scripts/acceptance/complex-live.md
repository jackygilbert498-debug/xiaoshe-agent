# 隔离运行原有五个复杂任务

这是 macOS 验收入口，不是日用 Profile、正式发行许可或新的任务评分器。原 `harness-performance-complex-smoke.mjs` 的五个场景、任务提示和判断条件继续使用。新入口只负责独立实例、执行边界、计量、留证和清理。

先运行零模型准备：

```sh
npm run test:agent:complex:safety
npm run test:agent:complex:isolated -- --prepare-only
```

准备模式创建五个无对话内容的测试会话，验证真实插件挂载和版本身份，然后释放自有实例；不读取 API key、不发送 prompt、不发起搜索。`prepared` 不等于五个任务通过。

只有获得真实 API 使用授权后才运行：

```sh
npm run test:agent:complex:isolated -- --live-authorized
```

模型路由固定为现有官方 DeepSeek-V4-Flash，不使用日用 3080、不复制用户 Profile、不启动 Electron、不触剪贴板或登录网站。Chat 总计最多 64 次实际调度、每次最多 2048 输出 token；搜索另有最多 8 次官方 Messages 请求、每次最多 5 次服务端搜索。两条账本分别记录，不把请求次数当费用上限；缺失用量保持未知。不自动重试整个任务求通过。

模型文件工具仅能访问当前场景的指定合成文件，只有代码场景的 `src/normalize.mjs` 可修改。原 npm 三门和父进程的独立 Node 测试使用同一真实 Seatbelt profile：夹具只读、仅独立执行临时目录可写、禁止网络、子孙进程继承、执行环境清空。它不改变日用沙箱的原合同，也不声称防御恶意同 UID 进程同时替换安装工具链。

每轮单独写入 `output/stabilization/complex-live-<UUID>/`。顶层 `report.json` 区分 `prepared`、`pass` 和 `fail`；`scenarios/` 保留原五场景报告、原始 RPC 响应、完整分页历史和最终文件副本；另留 chat/search 原始账本、工具权限清单、源码身份、配置及脱敏宿主日志。任何未知结果不能当作通过。

结束只释放本轮 PID 组、随机端口和自有临时根。资源释放或留证无法证实时保留临时根并记录路径，不删除日用数据或历史证据。启动前及结束后的源码身份必须一致；Mac 安装、附件、Windows 和签名验收不能由这五个任务代替。
