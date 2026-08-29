# 小蛇界面 · 5 分钟上手指南

> 面向首次使用者。界面是纯本地桥接服务（只绑 127.0.0.1 + 配对 token），浏览器只是客户端。
> 契约细节见 docs/UI_CONTRACT_v1.md；本地回归核对见 docs/LOCAL_VERIFY.md。

## 1. 启动（30 秒）

```bash
cd <仓库根>
python run.py serve            # 默认 :7788；--port 改端口；--no-browser 不自动开浏览器；--no-mcp 不连 MCP
```

启动日志会打印一行带 token 的完整 URL：

```
小蛇界面已就绪: http://127.0.0.1:7788/?token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**复制这整行 URL，在浏览器打开**（没加 `--no-browser` 时会自动帮你打开）。
token 同时落在 `.state/ui_token`（权限 0600，只有你自己可读）。

## 2. 发第一条消息（1 分钟）

在底部输入框打字，**Enter 发送 / Shift+Enter 换行**。模型在跑的时候：

- 消息流实时追加（你 / 助手 / 工具结果 / 系统提示四种角色）；
- 右侧状态面板跟着翻：待办、笔记、后台任务、白名单、待发图、用量；
- 想打断：按 **Esc**（cancel，未决审批一律按拒绝结案，安全侧默认）。

## 3. 审批四键 y / n / a / p（1 分钟）

模型要做写文件、跑命令、点屏幕这类动作时，界面弹出审批卡，
卡上是**规范化后的真实路径/整条命令指纹**。四个键（直接按键盘即可，自动定位最新一张未决卡）：

| 键 | 含义 |
|---|---|
| `y` | 这次允许（放行该指纹一次） |
| `n` | 拒绝（工具卡标红「被拒绝」，模型会收到拒绝回执） |
| `a` | 本会话都允许（同指纹不再问；含污点/混淆的调用仍会问） |
| `p` | 跨会话永久允许（指纹落 `.state/approvals.json`，可手编删除来撤销） |

界面没弹卡的两种正常情况：只读安全工具（直接放行，工具卡「直接放行」行）；
敏感文件（`.env`/私钥等，**硬拒不弹卡**，工具卡「硬拒 + 被拒」格）。

## 4. ⌘K 命令面板（1 分钟）

`⌘K`（Windows `Ctrl+K`）打开命令面板，两组：

- **harness 命令**：todos / memory / skills / notes / effects / undo / clear / help
  ——每条都有回执（系统消息、面板刷新或错误提示，见 E2E 场景⑧）。
- **界面命令**：切换主题 / 观测台开关 / 新会话 / 恢复存档（sessions→resume）/
  导出日志（最近 1000 条事件，jsonl 下载）/ 打开工具目录 / 重置配对 token。

输入框里打 `:` 也能起本地命令。

## 5. 屏幕观测（1 分钟）

模型调过 look / zoom / pick 之后，点右上角「屏幕观测」打开观测台：

- 面包屑视口链（look 根视口 → zoom 子视口，最多 3 级）；
- 画布上叠编号框（UIA 实线 / OCR 虚线 / 双源双色），与右侧编号表双向联动；
- HUD 显示坐标换算与 pick 差分比例——「疑似无效点击」会变红告警；
- 空态时会引导你先让模型 look 一下。

## 6. 主题切换

左下角（或 ⌘K「切换主题」）在**云白薄荷流光**（默认）与**暗夜影院**之间切换，选择记在浏览器 localStorage，下次打开保持。

## 7. 演示模式（不烧 API）

```bash
python scripts/serve_demo.py [--port 7788]
```

假模型驱动，不连真 API。发「写文件」体验审批四键、发「跑命令」体验命令指纹审批、
发「待办」体验工具卡与面板联动。

## 常见问题（FAQ）

**Q：带 token 的 URL 弄丢了 / 关掉了终端？**
token 在 `.state/ui_token`（0600）：`cat .state/ui_token`，拼 `http://127.0.0.1:7788/?token=<cat 输出>`。
服务还在跑就还能用；服务已停就重新 `python run.py serve`（每次启动都换新 token，旧的自然作废）。

**Q：怀疑 token 泄漏，想换？**
⌘K「重置配对 token」，或命令行（旧 token 换新，旧的立即作废）：

```bash
TOKEN=$(cat .state/ui_token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7788/api/token/reset
```

新 token 自动落盘 0600 并打印到服务端日志。

**Q：端口被占用？**
`python run.py serve --port 7799`。Host/Origin 白名单跟着端口走，不影响安全门。

**Q：重启后旧 token 还能用吗？**
不能。每次启动重新生成，这是设计（配对 token = 本次会话凭证）。

**Q：连续输错 token 被锁？**
连错 10 次锁 60 秒（HTTP 429）。锁定期间**连正确 token 也一律 429**（防爆破设计，TokenManager.check 实测行为）——
等 60 秒自动解锁，或重启服务（重启即换新 token）。

**Q：界面打不开但服务在跑？**
确认 URL 里是 `127.0.0.1` 或 `localhost`（其他主机名过不了 Host 白名单，HTTP 421）；
确认浏览器没强制 https（服务是本机 http）。
