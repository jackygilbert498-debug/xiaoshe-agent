# 壳对比其余项目外部能力参考审计（三轮）

**日期：** 2026-08-30
**参考根：** `C:\Users\example\Desktop\壳对比`（全程只读）
**排除：** `codex-main` 已在同日完成独立审计与集成；DSH 是现有运行内核，不作为本轮外部候选。
**实施目标：** `C:\Users\example\Desktop\XS`

## 1. 边界与冻结快照

XS、DSH、legacy 三棵工作树在扫描前分别冻结；未 reset、clean、stash、切分支或覆盖现有未提交内容。参考项目中的既有 dirty/untracked 状态属于参考源所有者，本轮没有修改。

| 项目 | 定位 | 冻结状态 | 有意义文件 / 字节 | 许可证结论 |
|---|---|---|---:|---|
| `cc-haha` | 桌面 Agent 工作台、质量门 | `main@6e6c87aa`，既有 tracked 变更 15 | 3,426 / 147,125,663 | 来源自述涉及泄露代码，仅研究抽象机制，禁止复制代码、资产和文案 |
| `CodeWhale` | Rust Agent、策略、工作区快照 | `main@542719b1`，既有 tracked 变更 35 | 919 / 20,181,542 | MIT |
| `hermes-agent-main` | Gateway、记忆、技能、迁移 | 非 Git 快照 | 6,244 / 138,411,362 | MIT |
| `kimi-code` | 插件目录、来源分层、TUI | `main@93f16c32`，既有 tracked 变更 6、untracked 3 | 2,384 / 22,345,611 | MIT |
| `openclaw-main` | 多通道 Gateway、配对、Doctor | 非 Git 快照 | 22,975 / 263,400,801 | MIT + 第三方声明 |

### 1.1 入口锚点 SHA-256

| 项目 / 文件 | SHA-256 |
|---|---|
| cc-haha `README.md` | `904aa3c5bfa1c9a4575a95a8d7abee7b8ef647b45b8fba33f30e7fffa87be039` |
| cc-haha `README.en.md` | `23cf57c550b8dc95fb885d277caf9399d598afa4adcde3ee02957bf76ce76078` |
| cc-haha `LICENSE` | `e8c36b1273cca5cfcd75caee51cde74dd0332172ef902a8b1ef0e14e5140ca79` |
| cc-haha `THIRD_PARTY_LICENSES.md` | `8184a9f83ccbb152cf18ce2e1645dc180cf6cfff77632f26e97ca7a61e10c58d` |
| cc-haha `package.json` | `9a0cfa60a95bbb53347003da5da5460029b8ab41d9a046bff694f36488a17f59` |
| CodeWhale `README.md` | `cc2ce903d8637c1d3b60dfe39462fc4b2cfb17d93411e9d6fe2b3e2082b18d5c` |
| CodeWhale `README.zh-CN.md` | `e48ac4987c4d37e0cd0c86192e37ff52f1f605fdb3016b57bca56732f6a3b3e9` |
| CodeWhale `LICENSE` | `91873e17f073f4dcddc63799a0a6fdeb44a281440b6c5e0b9d8ea2aa7f7ffd95` |
| CodeWhale `package.json` | `b9c60f05a2595b0d61b098c67419eeb583bd6f48e286ecc1b43496c425948dae` |
| CodeWhale `Cargo.toml` | `326981b458443ddddc6c32a898d16691db1aa601c05d640b7c276a6612c11ff8` |
| Hermes `README.md` | `cc1d82f1d07a7817999cb28b67002a717236ea8b4af0074be81b4ae1e665edcd` |
| Hermes `README.zh-CN.md` | `2b829c8a21c4fcb350348f89db6014171e17e9fbbdc423f0d43f721be8f00809` |
| Hermes `LICENSE` | `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6` |
| Hermes `package.json` | `07b1b0c8d196c93cc4876092907e7350cfc8b04db18ce34debb522aead4ad1c0` |
| Hermes `pyproject.toml` | `d1eee316b301dbaa35d8e59ab138cf86a4937f0fe4c65f97d839d798ae6a6755` |
| Kimi `README.md` | `1a8e4864d399b350728df60f2c08673f763e9323796b64bbacb059fb7db665d2` |
| Kimi `README.zh-CN.md` | `8d9bb34b442f61e0edb158ef39b9c506028dab60f12f2ff349d3c3db67e0f70f` |
| Kimi `LICENSE` | `23cc68e17992e0b512ae2e80afc5787d7d8e0fbfbdb4fff54ec0245508fa400e` |
| Kimi `package.json` | `ebe6c63c5a10e44ba83f83f57a1c90f34b0f1ead0f27f9f11fe10578fc5424f3` |
| OpenClaw `README.md` | `67e7b8330dbcab91e424ecbea772e21a787360ca11fa205573ca950019740201` |
| OpenClaw `LICENSE` | `73571b25326281d369087f469842c02444fe39faaecebda4d82ed21ff3a1c29d` |
| OpenClaw `THIRD_PARTY_NOTICES.md` | `c84200f7a9bb8b3abc8563520433316716a9eb83915cfe7c3063d5e6fce5e7ca` |
| OpenClaw `package.json` | `c0703dff9aa1dbd513730db018e97819a9620814cc4912e6d95bc74eecaa7432` |

## 2. 第一轮：架构与产品能力面

### cc-haha

- 值得学习：按改动路径生成影响报告、必跑检查、缺测试阻断、运行时/原生/发布风险提示；Provider 与桌面烟测分层。
- 不采用：其完整工作台、远程入口、计划任务和多 Agent UI 与 XS/DSH 已有能力重叠；许可证声明使任何代码或资产复制都不可接受。

### CodeWhale

- 值得学习：策略判断与执行点分离；每轮前后把工作区写入独立 side-git，始终同时指定 `--git-dir` 与 `--work-tree`；恢复不改用户 `.git` 和会话历史；容量、条目数、保留期与显式信任门齐全。
- 不直接实施：该能力会成为新的文件版本与恢复权威，跨 Git/非 Git、大目录、忽略规则、符号链接和不可逆外部效果都需要独立产品设计，不能作为本轮“小插件优化”悄悄落地。

### Hermes

- 值得学习：插件只在边缘扩展、核心保持窄腰；迁移默认 dry-run，应用前备份，冲突模式显式，生成报告；记忆搜索与迁移测试覆盖完善。
- 不直接实施：XS 已有迁移库与离线交接，但还没有经产品定义的 Hermes/OpenClaw 数据授权范围；自动技能整理/自学习会让插件自行修改能力，违背当前确认门与可审计边界。

### Kimi

- 值得学习：插件 UI 展示人类可读名称、说明、作者、主页、许可证与关键词；将官方、精选、第三方、自定义来源单独标注；自定义安装默认取消；来源标签和运行权限是两个维度。
- 真实缺口：XS 已把运行模块折叠为中文能力组，但候选插件审计仍以内部包名为主，而且把“Host 进程内运行”与“来源可信”混在同一套文案里；manifest repository 还可能原样带出 URL 凭据。

### OpenClaw

- 值得学习：远程入口默认配对、sender allowlist、设备 token 轮换、Doctor 对网络暴露/明文秘密/exec 与文件策略漂移做诊断。
- 不直接实施：当前 XS 产品壳没有对外消息通道，先加入配对与 allow-from 会产生没有真实入口的空配置；现有权限、SecretStore、Heartbeat 和 Doctor 继续保持各自插件所有权。

## 3. 第二轮：调用链、持久化、权限与测试

第二轮不是按 README 计数，而是跟踪源码是否真正进入运行链：

1. cc-haha 的 impact report 确实从 changed files 进入 area/risk/check 计算，并对生产改动缺少对应测试作阻断；XS 的 `@xiaoshe/verification-policy` 和完成凭证已经拥有 change kind、risk、gate 与证据判定，缺的是 CI 路径分类而非运行时能力。本轮不制造无人消费的第二套策略。
2. CodeWhale 的 snapshot 在独立仓库存 pre/post turn，恢复要求 trust/yolo；它明确是非致命安全网并有 2 GB 初始阈值、200,000 条目阈值、500 MB 仓库上限、保留与 GC。说明这不是可以只搬一个按钮的小功能。
3. Hermes 的迁移脚本与测试覆盖 dry-run、备份、skip/rename/overwrite、报告、来源根、秘密 opt-in 和 allowlist；XS 当前 `@xiaoshe/migration` 只做明确 allow-list 的字节备份/恢复，未挂载到 Product Bundle。没有接受源和字段语义前，不扩大为通用导入器。
4. Kimi 的插件 source label、manifest 类型和管理器测试形成闭环：来源、展示身份、托管副本和确认各自独立。它能直接复用 XS 现有 `CandidateResolver -> Host audit -> 一次性确认 -> 受管 Profile` 链路。
5. OpenClaw 的 pairing store、allow-from 与 doctor-security 确实进入 Gateway/Channel 的授权点，但 XS 没有相应远程 sender 身份，因此没有可绑定的权限主体。

## 4. 第三轮：反向能力矩阵与查漏

| 候选机制 | XS/DSH 现实 | 决策 |
|---|---|---|
| 路径影响报告 | verification-policy + completion-receipt 已有确定性门与证据 | 不重复；未来放到独立 CI 方案 |
| side-git 工作区恢复 | Session Log/检查点只负责运行事实，没有文件版本权威 | 有价值但高风险，留作独立跨平台设计 |
| 通用迁移向导 | migration 有安全备份原语，Product 未定义外部数据映射 | 不做推测性导入 |
| 自学习技能 | Skills/插件治理已有，自动改写未授权 | 禁止默认启用 |
| Gateway 配对 | 当前无远程消息 sender | 暂不实现空壳 |
| 插件人类信息 | 已安装模块有中文能力分组；候选插件仍以内部包名为主 | **本次实施** |
| 插件来源保证 | 只有安装包/manifest SHA；运行边界与来源可信混写 | **本次实施** |
| 插件治理生命周期 | Host 审计、不可变 tarball、一次性确认、受管 Profile、健康检查、回滚已存在 | 原插件内扩展，禁止第二套管理器 |

第三轮再次读取参考 Git 状态和全部锚点哈希，结果与第一轮相同，确认参考目录没有被本轮写入。

## 5. 选定实施与架构边界

只扩展现有 `@xiaoshe/plugin-governance`：

1. 从候选 `package.json` 提取有长度和控制字符约束的人类信息；
2. 将本地文件夹、本地安装包、软件源固定版本、浮动引用、外部引用分开；
3. 当前一律诚实标为“未签名核验”，SHA-256 只证明审计字节未变，不证明作者身份；
4. 清理 repository/homepage/source label 中的 URL 用户名、密码、查询和 fragment，路径只展示 basename；
5. 在审计卡与一次性确认中以人类名称为主、包标识为辅，同时明确 Host 进程内运行和系统沙箱未启用；
6. Product Bundle 继续只挂载同一个治理插件，不新增 Loader、Catalog、事务表或设置所有权。

不复制任何参考项目实现、测试、图标或文案。新代码按 XS 自有契约实现，因此不引入新的第三方衍生许可内容。

## 6. 验收口径

- 单元测试先红后绿，覆盖身份清理、来源分类、秘密脱敏、HTTP 公共面和 UI 呈现；
- Host audit、一次性确认、受管 Profile 与回滚语义保持原样；
- 插件清单继续折叠重复运行模块，候选插件不再只显示莫名其妙的内部包名；
- Windows 全仓、真实 Profile、浏览器 DOM/console 与可重定位工件有证据；
- 参考源哈希和 Git 状态复核不变；
- macOS 实机明确保持 `PENDING`，交接后由用户验收。
