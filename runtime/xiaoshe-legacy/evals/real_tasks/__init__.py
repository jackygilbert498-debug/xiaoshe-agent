"""D3 真实任务 eval：用户的 5 类日常任务，真 Kimi 经 run_headless 端到端跑，确定性验证 + 摩擦点记录。

编进现有 evals 体系（复用 core.Task/checklist/run_once），不另起炉灶：
- make_fixtures.py：现跑现生成的合成 fixtures（纯色/形状 PNG 走 harness.imaging，视频走 ffmpeg），零真实用户数据。
- verifiers.py：确定性验证（xlsx 解析、颜色分类、ffprobe 时长、命名校验），纯函数可离线单测。
- tasks.py：5 个真 Kimi 任务定义（allow 白名单最小化，工作目录限定 evals 沙盒 workdir）。
- friction.py：解析会话 JSONL 日志 → 轮数/工具报错/审批卡壳等摩擦信号。
- run_d3.py：跑全部任务，沙盒 workdir 落 .d3/<时间戳>/（gitignore；不能放 .state 下，permission 整树硬拒），
  results.json 备份到 .state/d3/，会话转录在 .state/logs/。

跑法（真 Kimi，需 .env KIMI_API_KEY + 本地代理）：
  cd /c/Users/example/Desktop/ke && PYTHONIOENCODING=utf-8 py -3 -m evals.real_tasks.run_d3
"""
