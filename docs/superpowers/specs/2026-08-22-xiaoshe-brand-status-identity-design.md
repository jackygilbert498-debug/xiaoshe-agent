# 小蛇品牌、状态与身份修正设计

## 目标

在不改画唯一合法 Logo 的前提下，恢复旧版小蛇的金属流光和更舒展的三栏比例；让右侧工作台只显示 DSH 的真实会话状态；让模型始终以“小蛇”作为产品身份，并对模型、工具和权限作条件化、可验证的陈述。

## 已确认约束

- 唯一合法 Logo 是 `runtime/xiaoshe-legacy/ui/assets/snake.svg`，不得复制路径、重画或生成替代品。
- 中央“小蛇”必须持续播放旧版六站金属流光；不因 `prefers-reduced-motion` 变成静态。
- 左上角 Logo 使用同一 SVG 作为遮罩，以旧版金属渐变着色，尺寸恢复为 34px。
- 中央线性 Logo 使用同一 SVG 的 Alpha 轮廓，画布放大至 300px，`feMorphology` 半径保持 1.15，不增加线条像素。
- 宽屏三栏目标为约 248px / 自适应 / 300px；窄屏仍使用现有抽屉和折叠行为。
- 右侧状态来自会话快照，不显示虚构计数，不重复旧版状态条。
- 普通身份回答使用“小蛇”；仅在用户明确询问时说明当前模型或内部运行层。
- 能力陈述必须以当前注册工具和授权为条件；不得固定宣称联网、桌面操作、子代理或插件一定可用。
- 权限陈述必须符合当前策略，不得固定宣称“所有操作都先询问”或“始终处于沙箱”。
- `C:\Users\example\Desktop\小蛇` 仅作只读参考，不覆盖当前工程。

## 状态模型

DSH 会话根节点发布 `data-session-runtime-state`：

- `awaiting-approval`：存在 approval pending interaction。
- `tool-running`：会话运行且有 runningCalls。
- `waiting-model`：会话运行、尚无 partial 且无 runningCalls。
- `model-running`：会话运行且已有 partial。
- `stopped`：会话不再运行，最新助手节点带 `interrupted: true`。
- `idle`：以上均不成立。

XS 工作台只把这些稳定值翻译为中文，不再把所有 active 会话等同于“任务进行中”。

## 产品身份

XS 的 `cordis.patch.yml` 覆盖 `system-prompt`：关闭固定 Harness identity，并提供小蛇 persona。建议的默认自我介绍为：

> 我是小蛇，你的个人编程与电脑任务助手。我会根据当前工作区、已经启用的工具和权限完成任务；涉及关键或高风险操作时会先向你确认，并在完成后验证结果。

当用户明确询问当前模型或架构时如实回答；普通自我介绍不以模型或 Harness 作为身份。
