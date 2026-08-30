# DeepSeek Harness 运行时

中文 | [English](README.md)

本目录是小蛇使用的 DSH 运行时源码。DSH 提供基于 Cordis 的插件宿主、Agent 循环、会话、模型路由、工具、技能、审批、Web 界面和命令行入口。

运行时源码随小蛇一同保留，开发者可以从完整源码安装与构建，不需要依赖不透明的预编译内核。

## 构建

在小蛇仓库根目录运行：

```sh
pnpm --dir runtime/DSH install --frozen-lockfile
pnpm --dir runtime/DSH run build
```

构建后可运行命令行或 Web 宿主：

```sh
pnpm --dir runtime/DSH dsh --help
pnpm --dir runtime/DSH dsh web --no-open
```

小蛇安装器还会注册产品插件并写入 Profile 配置。完整安装请使用仓库根目录的 `setup/install-windows.ps1` 或 `setup/install-macos.sh`。

## 许可证

DSH 使用 [MIT License](LICENSE)。第三方依赖与声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
