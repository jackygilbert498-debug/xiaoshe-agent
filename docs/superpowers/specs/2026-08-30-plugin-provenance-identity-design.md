# 小蛇插件身份与来源核验设计

**日期：** 2026-08-30
**依据：** `2026-08-30-shell-comparison-reference-capability-audit.md`
**范围：** 扩展现有插件治理插件，不改变运行内核和插件生命周期。

## 1. 问题

当前已安装 Host 模块会被折叠为稳定中文能力组，但新增/更新候选仍主要展示 `@scope/package@version`、两个摘要和单一风险级别。对普通用户存在三个误导：

1. 内部包名不能解释插件用途；
2. “作为受信任 Host 代码运行”容易被理解为来源已经可信，实际上它只描述执行权限；
3. SHA-256 能绑定被审计字节，却不能证明发布者身份，软件源浮动引用也不等于固定版本。

此外，候选清单中的 repository/homepage 或用户输入的软件源 URL 可能带 userinfo、query 或 fragment，不能原样进入公共 API、UI、凭证和日志。

## 2. 数据契约

### 2.1 人类身份

`CandidateIdentity` 只来自候选包清单，字段均做边界清理：

- `displayName`：优先合法 `displayName`，否则回退包名；
- `description`：单行化、去控制字符、限长；
- `developer`：只接受 npm `author` 字符串或对象的 `name`；
- `homepage`：只保留已脱敏的 `http/https` URL；
- `license`：短文本；
- `keywords`：去重、逐项限长并限制数量。

React 文本节点继续负责 HTML 转义；Host 负责长度、控制字符和 URL 秘密清理。显示信息明确标注为“来自插件清单”，不当作身份认证。

### 2.2 来源描述

`CandidateProvenance` 与运行权限分离：

```text
kind:       local-directory | local-tarball | registry
selection:  local-bytes | exact-version | floating-reference | external-reference
label:      脱敏、限长的人类来源
assurance:  unverified
```

- 本地路径只显示末级文件/目录名；
- 软件源 `name@1.2.3` 才是固定版本，其余 tag/range/裸包名为浮动引用；
- URL/git/file 等定位符为外部引用；
- URL 用户名、密码、query、fragment 在进入公共对象前删除；
- 现阶段没有签名目录或发布者证明，所以所有来源均为 `unverified`。

### 2.3 两类事实不可合并

| 事实 | 能证明什么 | 不能证明什么 |
|---|---|---|
| `sha256` / `manifestSha256` | 确认后字节是否与审计时相同 | 发布者身份、代码安全 |
| `provenance` | 用户选择了哪类来源、是否固定版本 | 来源可信 |
| `osSandboxEnforced: false` | 插件没有独立系统沙箱 | 是否恶意、是否来自官方 |
| 一次性确认 | 用户确认了本次已披露事实 | 后续版本、其他 Profile 的授权 |

## 3. 调用链

```text
CandidateSource
  -> CandidateResolver
       -> npm pack --ignore-scripts / exact local tarball
       -> bounded tar manifest inspection
       -> CandidateIdentity + CandidateProvenance + audit + immutable hashes
  -> Host HTTP public candidate
  -> Native Shell candidate card
  -> PluginLifecycle.prepare
       -> expiring one-shot challenge (identity/provenance/disclosures)
  -> confirm
       -> re-hash bytes -> mutate inactive managed Profile -> health/rollback
```

权威审计仍只在 Host。Client 只格式化公共结果，不解析 manifest、不判断可信、不生成安装命令。

## 4. 呈现规则

候选审计卡：

1. 人类名称；
2. 一句用途说明；
3. 包标识与版本；
4. 开发者/许可证（存在才显示）；
5. 来源标签、固定/浮动方式、`来源核验：未签名`；
6. 风险、Host 进程内运行、系统沙箱未启用；
7. 安装包和 manifest 摘要。

一次性确认继续不渲染 token。标题使用人类名称，包标识、来源核验、目标环境、有效期和运行边界作为独立事实，避免用“受信任”同时描述权限与供应链。

## 5. 兼容与失败语义

- 清单没有人类字段：回退包名，不阻断现有插件；
- 非法/超长可选字段：忽略或裁剪，不把无关展示问题升级为安装授权；
- 非法 name/version：继续由现有审计阻断；
- 未声明 repository：继续作为 finding；
- 来源 URL 含秘密：只保留脱敏标签，原始输入仅在本次 Host resolver 调用内使用，不进入公共候选；
- 移除操作没有候选 identity/provenance：回退已安装包标识；
- 不改变事务 schema，旧事务与交接数据无需迁移。

## 6. “一切皆插件”符合性

- `@xiaoshe/plugin-governance` 继续拥有审计、来源、确认、变更和事务；
- Native Shell 是纯 Consumer，只展示 Service 的公共事实；
- Product Bundle 只组合已有插件；
- 没有第二个插件目录、Loader、安装 API、事务 Store 或信任数据库；
- 移除治理插件后候选审计与管理界面能力自然消失。

## 7. 验证

1. 纯函数测试：身份字段边界、URL 脱敏、来源分类、披露语义；
2. HTTP 测试：公共候选包含 identity/provenance，不包含 tarball 绝对路径或 URL 凭据；
3. 生命周期测试：challenge 绑定同一 identity/provenance，确认前后摘要与回滚不变；
4. Client/UI 测试：人类名称为主、包标识为辅、token 不可渲染；
5. Profile + 浏览器：真实挂载、候选审计 DOM、console 0 error、卸载/重启；
6. 全仓和可重定位交接；macOS 实机保持待验收。
