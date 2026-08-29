# 决定 0002：原生产品壳的插件边界与事实所有权

## 状态

已接受，Phase 0 需要用真实 Profile 组合验证。

## 背景

决定 0001 固定了 DSH Profile 是唯一用户运行面，并把 Windows 桌面能力限定为小蛇 Bundle。当前根包同时声明 `dsh.bundle` 和 `dsh.client`，其 Client face 既使用 Slots，也通过 DOM 与 `MutationObserver` 改造 DSH 页面；根 `apply()` 还混合桌面、动作策略、记忆、产品身份和运行路由。这种打包方式无法让原生 Product Profile 只选择 Windows Host 能力。

## 决定

1. DSH/Cordis 是唯一宿主。DSH Agent loop、Session Log、Client Runtime、Loader 和 Profile 管理不在 XS 重建。
2. Profile 是命名的可运行组合；Bundle 是向 Profile 应用的可安装 patch 层。两者不是同一对象，Bundle 也不包含另一个 Bundle。
3. `@xiaoshe/product-bundle` 与 `@xiaoshe/dsh-desktop-control` 是 Profile 中并列、可独立安装的层。Product Bundle 不把 Windows Bundle 或 `@deepseek-ai/dsh-web-app` 声明为内部成员。
4. Product Bundle 只组合小蛇产品 Service/Provider/Consumer 和原生 Client row；通用 Connection、Remote、Client Runtime、Renderer 与 Slots 来自 DSH Web Bundle。
5. DSH Session Log 是唯一权威会话交互日志。小蛇 Projection 必须可由它和正式 Host Service 的领域事实重建。
6. 根包保留 Windows Host/Bundle 身份；其旧 `client.js` 迁入独立 `@xiaoshe/legacy-dsh-skin`。兼容 Profile 必须显式安装该包，Product Profile 不得加载它。
7. 根 `apply()` 拆为桌面/动作、记忆、产品身份/表达、运行路由四个窄 Cordis plugin rows；迁移期聚合入口可以保留，但 Product Profile 直接组合窄 rows。
8. Bundle 成员增删更新在下一次 Profile 启动生效。进程内 effect dispose 和 Bundle remove 后重启是两个分别验证的门槛。
9. 安装进 Profile 的包是受信任代码面。manifest 展示和用户同意只表达知情信任；没有实际 Service 限制、审批、沙箱或进程隔离时，不声称最小权限被强制。

## 后果

- 原生壳能独立替换和卸载，不需要查询 DSH DOM。
- Windows Host 能力可以与原生壳或旧兼容皮肤分别组合。
- 包数量只按真实生命周期边界增加；同一 npm 包内部可以导出多个窄插件，不要求“一文件一包”。
- Phase 0 若无法用公开且已打包的 DSH 契约交付树外 Client，后续阶段停止并重新设计，不能偷偷建立第二套协议栈。

## 验证义务

- build/pack 后的 Client tarball 不包含 DSH 私有源码或路径。
- 独立 Profile 完成 add、dump、start、remove、restart。
- Product Profile roster 不含 legacy skin；兼容 Profile 可显式加载它。
- 每个窄插件 row 独立卸载后只释放自己的 effects。
- 移除 Product Bundle 并重启后，小蛇 UI 注册与资源消失，已有 DSH Session 数据保持。
