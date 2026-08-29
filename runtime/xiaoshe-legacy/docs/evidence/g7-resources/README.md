# G7 资源卫生门

运行 `python3 -X utf8 scripts/check_resource_hygiene.py --iterations 100 --strict --output docs/evidence/g7-resources/report.json`。

报告记录非 daemon 线程、直属子进程和可用平台上的句柄差值。通过不代表 12 小时 soak 已完成；该观察门必须另行持续运行并保留报告。
