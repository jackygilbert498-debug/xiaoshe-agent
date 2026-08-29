# Windows 安装与验收

仅安装已签名 MSI/NSIS 产物。卸载默认保留 `%LOCALAPPDATA%/Xiaoshe` 数据；清除数据必须由用户单独执行。完成首 Task、重启恢复、升级和卸载 smoke 后再进入 cohort。

运行 `py -3 scripts/smoke_installed_app.py --platform windows --report artifacts/windows-smoke.json`；非 Windows 主机的 `not_run_on_target` 不是通过。
