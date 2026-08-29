# Windows 原生验证记录 — 2026-08-09

## 命令

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify_windows.ps1
```

## 已通过的本机链路

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| UI contract | 通过 | `0 ERROR / 0 WARN` |
| Tasking UI store | 通过 | Node 4/4 |
| Serve smoke | 通过 | 32 PASS / 0 FAIL |
| UI E2E | 通过 | 69 PASS / 0 FAIL |

## 阻断结论

完整 unittest 以退出码 1 结束：`2622` 项中 `12` 失败、`3` 错误、`43` 跳过、`3` 预期失败。

首个已验证的主机前置条件是当前 Windows 账户没有创建符号链接的特权：

```text
OSError: [WinError 1314] 客户端没有所需的特权。
```

它阻断了 `test_path_redteam` 与 `test_workspace_recovery` 的符号链接逃逸测试。因此本次不能把 Windows 原生验证标记为通过；应在具备 Developer Mode 或“创建符号链接”权限的 Windows 账户上重跑。

同一次完整运行还暴露了需要单独修复和回归的兼容性失败：Windows 盘符路径被 `permission.safe_path` 拒绝，影响 checkpoint/use-root 的撤销与还原用例；`test_effects_view` 的命令显示断言失败；HTTP `DELETE` 路由返回 `404` 而用例期望 `405`。这些不是本证据批次可修改的范围。

## 发布状态

本机 UI、服务和 E2E 通过不改变发布结论。发布治理与商业 Beta 仍为 `hold`；候选构件绑定、14 天 P1 观察、B0-B2 队列观察、签名安装、72 小时 soak/恢复、独立安全与隐私审查、staging 回退演练均未获得本次独立外部证据。
