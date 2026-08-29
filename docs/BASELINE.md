# 小蛇 DSH 迁移基线

记录时间：2026-08-20（Asia/Shanghai）。本文件只记录可复现事实，不包含任何密钥。

## DSH

- 源码目录：`/Users/example/Desktop/DSH`
- Git：`141eb6fef83422698aef7a981029e843e8161534`
- 版本：`dsh-v0.1.0-rc.8`
- 工作树：干净，`master...origin/master`
- 支持的 Node：`^22.19 || >=24`
- 本机合规 Node：`/opt/homebrew/opt/node@24/bin/node`，`v24.19.0`
- Profile：`/Users/example/.dsh/profiles/web`
- 已安装视觉 Bundle：`@liustack/modlens@3.22.0`

## 旧小蛇

- 源码目录：`/Users/example/Desktop/小蛇`
- Git：`634d5671f9bf4ecedc5dc7404ee447ddc9e3a44d`
- 分支：`codex/plan05-effects-plan06`
- 工作树：89 个已跟踪改动、177 个未跟踪路径
- 迁移约束：旧工作树只读复用，不在其中执行迁移性重构或覆盖操作
- 首批复用模块：`harness/observe.py`、`harness/viewport.py`、`harness/imaging.py`、`harness/platform_caps.py`
- 明确不复用：`harness/inputhub.py`；它负责 CLI stdin 路由，不是桌面控制

## 视觉职责

ModLens 已提供静态图片和聊天粘贴图像理解，因此本项目不重复创建图像模型适配器。缺口是主动截屏、AX/UIA 元素表、视口版本、坐标执行、输入和动作后验证。

## 回退点

本 Bundle 以 Profile 依赖形式安装。回退不改 DSH 源码，只需执行 `dsh plugin --profile web remove @xiaoshe/dsh-desktop-control`；旧小蛇目录和 ModLens 均保持原状。
