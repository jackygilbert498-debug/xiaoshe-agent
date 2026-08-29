# macOS 安装与验收

仅安装签名并完成公证的 `.app`。首次启动后完成项目选择、任务目标、验收标准和计划批准；退出后重启确认 Task 可恢复。若系统权限或签名校验失败，不要绕过提示，保留诊断包。

运行 `python3 scripts/smoke_installed_app.py --platform macos --report artifacts/macos-smoke.json`；非 macOS 主机的 `not_run_on_target` 不是通过。
