# 小蛇插件身份与来源核验实施计划

> 用户已授权自主实施。执行保持手术式修改、测试先行、参考源只读和现有工作树保护。

**目标：** 在现有插件治理链路内提供可理解且不误导的插件身份与来源信息，不创建第二套插件系统。

**架构：** `CandidateResolver` 负责不可变字节、清单身份和来源描述；`PluginLifecycle` 把事实绑定到一次性确认；Host HTTP 只输出脱敏公共对象；Native Shell 只格式化。

## Task 1：三轮参考审计

- [x] 冻结 XS、DSH、legacy 和五个参考项目；
- [x] 第一轮扫描架构、产品能力和扩展点；
- [x] 第二轮跟踪真实调用链、持久化、权限与测试；
- [x] 第三轮反向扫描 XS/DSH、去重、许可证与风险；
- [x] 决定只实施插件身份/来源缺口；
- [x] 写出审计与设计。

## Task 2：先写失败测试

- [x] `plugin-governance`：身份字段清理、repository/homepage 脱敏；
- [x] `plugin-governance`：本地/固定/浮动/外部来源分类；
- [x] `plugin-governance`：披露不把“运行权限”写成“来源可信”；
- [x] Host HTTP：公共候选包含 identity/provenance 且不泄漏绝对路径、URL 凭据；
- [x] Native Shell：候选与 challenge 呈现以人类名称为主、包标识为辅；
- [x] 运行目标测试并保存预期红灯。

## Task 3：实现 Host 契约

- [x] 新增 `CandidateIdentity`、`CandidateProvenance`；
- [x] 对可选清单文本、author、keywords 和 URL 做有界清理；
- [x] 对 CandidateSource 生成不泄密的来源标签和选择方式；
- [x] Resolver 返回身份/来源，生命周期 challenge 绑定相同事实；
- [x] 更新披露文案，分开来源保证、字节摘要、Host 权限与系统沙箱；
- [x] 保持事务存储 schema、Profile 变更和健康回滚不变。

## Task 4：实现 Client 呈现

- [x] 更新公共 Candidate/Challenge 类型；
- [x] 增加纯 `pluginCandidatePresentation`；
- [x] 审计卡显示名称、用途、包标识、开发者/许可证、来源与核验；
- [x] 确认卡继续不包含 token；
- [x] 已安装运行模块继续按能力组去重。

## Task 5：分层验证

- [x] plugin-governance test/typecheck/build；
- [x] native-shell-legacy-adapted test/typecheck/build；
- [x] Product Bundle 与全仓测试；
- [x] 隔离 Profile add/start/remove/restart；
- [x] 浏览器真实 mount、DOM 与 console；
- [x] 可重定位工件、参考哈希与三棵工作树复核。

## Task 6：证据与交接

- [x] 写入 Windows 命令、退出码、证据文件与未验证项；
- [x] 更新 `交接工具/当前状态.md` 和 `从这里开始.md`；
- [x] 生成并解包复验唯一最新交接包及 SHA-256 sidecar；
- [x] 工作目录不保留交接压缩包；
- [x] macOS 实机明确为 `PENDING`。

## 完成标准

- 三轮扫描和不实施理由可追溯；
- 新能力由现有插件治理插件拥有，卸载边界不变；
- 来源不被误写成可信，摘要不被误写成签名；
- 敏感 URL/路径不进入公共 API 或 UI；
- Windows、Profile、浏览器、重定位与交接都有可重跑证据；
- 不把 macOS 待验收或参考项目能力写成已经交付。
