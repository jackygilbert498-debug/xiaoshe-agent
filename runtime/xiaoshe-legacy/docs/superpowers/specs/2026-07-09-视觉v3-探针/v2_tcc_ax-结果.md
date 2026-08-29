# v2 TCC + AX 真机探针结果（2026-07-09，本机 Mac）

装眼睛(observe)前先探 macOS 两道 TCC 权限的现状，定 v2 能不能真机验、用户要授权啥。

## ① 屏幕录制（截屏通道）— **实际可用**（首次一次瞬态失败）
首次 `screencapture -x -t png out.png` → `could not create image from display`，rc=1；**紧接着重试即 rc=0、
截出 ~1.2MB 真图**（macOS 首次调用常见的瞬态/授权注册抖动）。→ 本机屏幕录制**已授权、截图通道可真机验**。
`platform_caps.screen_capture_status()` 以 rc==0 且 stderr 无 "could not create image" 判定，能抓到那次
rc=1 的真失败签名（非假成功）。**已知残留**：某些 macOS 版本未授权时会 rc=0 但截出全黑/仅桌面图（假成功），
本检查未加近空白判别——留作 observe 落地时的加固项。observe 仍须：未授权回结构化引导、绝不静默失败。

## ② 辅助功能（AX 可访问性树通道）— **可用！**
`osascript` 能拉到真实元素（不只是 COUNT）：
```
APP: Microsoft Edge
WIN: 视频鼠标截图工具（回车保存版）
AXGroup  | <窗口标题>   | pos=0,30  | size=2560x1325
AXButton | 关闭按钮     | pos=12,42 | size=16x16
AXButton | 全屏幕按钮   | pos=58,42 | size=16x16
AXButton | 最小化按钮   | pos=35,42 | size=16x16
(窗口直属元素数=4)
```
→ **设计的主 grounding 通道（AX 树）在本机真能用**，评委担心"只探到 COUNT、没探到 role/name/bbox"
的风险**解除**。uid 可在真数据（role+name+position）上设计。注意：`UI elements of front window` 只给
**窗口直属**子元素（4 个：窗口chrome按钮+顶层AXGroup）；网页/内容元素在 AXGroup 里更深，真 observe 需
按深度递归（`entire contents` 慢，宜限深+按需展开）。脚本见 `v2_ax_probe.scpt`。

## 对 v2 施工的影响
- AX 树通道：**可建可真机验**（先做，是 grounding 主力）。
- 截图通道：建（注入式），真机验待用户授权屏幕录制；未授权走降级引导（P2d 验收锚）。
- Windows：UIA 走 powershell、零授权，但需 SetProcessDPIAware() 前置（待 Win 机验）。
