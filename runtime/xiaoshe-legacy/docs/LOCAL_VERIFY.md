# 小蛇界面 · 本地回归核对清单

> 给用户在自己机器上跑的完整核对单。环境装不了全量依赖/没有真机屏幕的项，标了预期差异。
> 每条独立可跑；建议顺序执行。仓库根 = 下文所有命令的工作目录。

## Windows 完整验证（推荐入口）

在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify_windows.ps1
```

该入口依次执行 UI 契约、serve 冒烟、UI E2E 和全量 unittest；任一失败即停止。
Windows 请只使用上述入口；以下保留 Unix 分步排查命令和人工核对项。

### S 终端与安装生命周期

```powershell
S doctor
S --help
```

`S doctor` 是只读诊断：检查 launcher、Python 版本、本地端口、配置目录、SecretStore、UI 静态资源、模型配置、沙箱/网络/代理状态和控制台编码。输出不得包含密钥、环境变量值或个人绝对路径。安装、升级、回退和卸载分别使用 `install.ps1 -Action Install|Upgrade|Rollback|Uninstall`；每一步都必须先核对 ownership manifest 和 SHA-256。卸载后检查 `.state`、会话和自建文件仍在。

当前 Windows 11 主机可在隔离临时目录完成真实生命周期验证。Windows 10 与真正 clean VM 必须由对应设备生成证据；没有设备时记为 `not_run/hold`，不得用本机单元测试代替。

## ① 全量回归基线 vs 施工后

```bash
python -m unittest discover -s tests -v
```

- 核对点：**施工前基线全绿，施工后同套测试仍然全绿**（钩子/总线全部默认关闭，行为零变化是红线 3）。
- 本仓库包含全量测试；测试总数以每次运行结果为准，文档不硬编码易漂移的数字。
  施工后跑法相同，任何新增 FAIL 都说明仪表化泄漏了行为，请直接报 issue。

### 严格资源门与候选绑定

准备冻结候选时，必须使用同一条严格命令，并确认日志中没有
`ResourceWarning:` 或 `unclosed file`：

```powershell
$testCommand = 'py -3 -X utf8 -W error::ResourceWarning -m unittest discover -s tests -q'
cmd.exe /d /c "$testCommand > docs\baselines\xiaoshe-v2-full-test.log 2>&1"
if ($LASTEXITCODE -ne 0) { throw "strict full suite failed: $LASTEXITCODE" }
$warnings = Select-String -LiteralPath docs\baselines\xiaoshe-v2-full-test.log `
  -Pattern 'ResourceWarning:|unclosed file'
if ($warnings) { throw "strict full suite emitted ResourceWarning" }
```

随后从本次 `unittest` 汇总取得真实计数，计算原始日志哈希，并显式生成候选记录：

```powershell
$hash = (Get-FileHash -Algorithm SHA256 `
  -LiteralPath docs\baselines\xiaoshe-v2-full-test.log).Hash.ToLowerInvariant()
py -3 -X utf8 scripts/capture_candidate_baseline.py `
  --repo . `
  --output docs/baselines/xiaoshe-v2-candidate.json `
  --command $testCommand `
  --ran <本次实际总数> --failures 0 --errors 0 `
  --skipped <本次实际跳过数> --expected-failures <本次实际预期失败数> `
  --log-sha256 "sha256:$hash"
```

捕获脚本只读取 Git 的 HEAD、分支和 porcelain 状态计数；不读取工作区文件正文、
`.env`、`.state`、SecretStore 或测试日志正文。`*.log` 是本机证据且已被忽略，
只有无凭据的 JSON 摘要进入 Git。工作树非干净时，该记录绑定的是所列 HEAD 与
dirty/untracked 数量，不等同于可复现的干净发布候选。

## ② 不注册 sink 行为一致（repl / -p 手工走查）

serve 不启动时，agent.py/tools.py/jobs.py 的观测钩子一律 no-op。走查要点：

1. `python run.py`（repl）发一条消息 → 一轮普通对话，终端输出与基线逐字节一致
   （没有多余的事件/面板类输出）。
2. 触发一次危险工具（让模型写文件）→ 审批走**终端 stdin** 的 y/n/a/p 提示，与基线一致。
3. `python run.py -p "一句话任务"`（无头）→ 审批恒拒、无 token 文件生成、无 7788 端口监听。
4. 长会话触发自动压缩 → 终端压缩提示话术与基线一致（JSONL 日志多一条 role=system 的
   compaction 记录是**预期内新增**，读取方全部兼容）。

## ③ 安全门五条攻击复测（curl 逐条）

先起服务并取 token：

```bash
python run.py serve --port 7788 --no-browser &
TOKEN=$(cat .state/ui_token)
```

| # | 攻击 | 命令 | 预期 |
|---|---|---|---|
| S2 | 无 token | `curl -si http://127.0.0.1:7788/api/state` | **401** `unauthorized` |
| S2 | 错 token | `curl -si -H "Authorization: Bearer 00000000000000000000000000000000" http://127.0.0.1:7788/api/state` | **403** `forbidden` |
| S2 | 连错锁定 | `for i in $(seq 11); do curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer bad" http://127.0.0.1:7788/api/state; done` | 前 10 次 403，第 11 次起 **429**（锁 60s；锁期内正确 token 也 429） |
| S2 | WS 无 token | `python -c "import sys; sys.path.insert(0,'scripts'); from wsprobe import WSClient, HandshakeError;`<br>`WSClient.connect('127.0.0.1', 7788, token=None)"` | HandshakeError **401** |
| S3 | DNS 重绑定 | `curl -si -H "Host: evil.example.com" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7788/api/state` | **421** `bad_host` |
| S4 | 跨源 | `curl -si -H "Origin: http://evil.example.com" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7788/api/state` | **403** `bad_origin` |
| S5 | API 路径穿越 | `curl -si --path-as-is -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:7788/api/images/../ui_token"` | **404**（ref 形态闸） |
| S5 | 静态穿越 | `curl -si --path-as-is "http://127.0.0.1:7788/../.state/ui_token"` | **404**（realpath 限定 ui/ 树内） |
| S5 | CSP | `curl -si -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7788/ \| grep -i content-security-policy` | 命中 CSP 头（`default-src 'self'` 起） |
| S1 | 仅回环 | 从另一台机器/容器外访问 `http://<本机IP>:7788/` | 连接被拒（服务只 bind 127.0.0.1，无配置项） |

## ④ 契约校验

```bash
python tests/ui_contract/validate_contract.py     # 离线三道：样例自洽 / 字段溯源 / 枚举封闭
python scripts/check_live.py                      # 起假模型 serve + 活服务样例驱动比对（--server 模式）
```

- 预期：退出码 0；enum 比对在三方（ui_schema.py ≡ enums_mirror.json ≡ ui/js/lib/enums.js）逐字一致。
- 前端未合并前 enums.js 缺失只 WARN 不致死；前端合并后自动转硬校验。

## ⑤ 8 条 E2E 场景

```bash
python scripts/e2e/run_e2e.py            # 退出码非 0 即失败；~2 分钟
```

预期 `===== E2E 汇总：69 PASS / 0 FAIL =====`。场景清单与覆盖层级：

| # | 场景 | 覆盖层级 |
|---|---|---|
| ① | 发送→write_file×4→审批 y/n/a/p 全链（落盘/denied/会话白名单/持久白名单） | serve 全链路（假模型剧本） |
| ② | read_file .env 敏感护栏：不弹审批直接 deny，denied_calls +1 | serve 全链路 |
| ③ | 压缩四 kind（auto/force/emergency/clearing）事件载荷对照 fixtures | serve 全链路（假 history + 假溢出 400 驱动真实压缩路径） |
| ④ | look→zoom→pick→差分：viewport.update / viewport/current / pick/diff | **runner 注入模拟级**（屏幕/OCR/点击子系统注入，协议链全真） |
| ⑤ | 审批弹出后断线不答 → 重连 snapshot 带回 pending_approvals → 回答结案 | serve 全链路 |
| ⑥ | 待发图注入 + A 侧 REST remove → B 侧 state.patch 同步 | serve 全链路（双 WS 客户端） |
| ⑦ | run_in_background → job.update、running→done 翻转、tail、/api/jobs/{id}/log | serve 全链路（终态翻转经 check_background 驱动，与真实用法一致） |
| ⑧ | command todos/memory/skills/notes/effects/undo/clear/help 逐条有回执 | serve 全链路 |

注意：E2E 在工作区写临时文件（`e2e-<run>-*.txt`、`.state/` 下的会话/日志/图床/任务档案），
跑完自动清理临时文件与 `approvals.json`/`context_window.json` 改动；会话档案留在
`.state/sessions/`（正常产物，可手动清）。

## ⑥ 真机专项（容器里验不了，上真机必验）

1. **token 文件 0600**：NTFS（Windows）/ ext4（Linux）/ APFS（macOS）三种文件系统上
   `stat -c %a .state/ui_token`（macOS `stat -f %Lp`）必须为 `600`。
   容器内部分挂载文件系统会静默忽略权限位（烟雾测试对此有探针跳过逻辑），真机不允许豁免。
2. **Mac 沙箱与 OCR 门控待验证清单**：
   - 沙箱（App Sandbox / TCC）下 screencapture、AX 树、Vision OCR 三通道各自的授权引导话术是否触发；
   - OCR 置信度门控（`_OCR_CONF_GATE=0.80`）：高置信单跑放行 / 低置信反色 ja 补跑 / 无置信度信号回落现状；
   - 反色补跑 + ja 补跑 + CJK 第三跑确认的耗时（每次调用至多 3 跑）在正常可感范围内；
   - E2E 场景④是 runner 注入模拟级，**真机 look→zoom→pick 需人工走一遍**（观测台编号框与差分比例条）。
3. **多显示器负坐标**：主屏左/上方有副屏时，屏幕坐标可为负——
   look 编号表坐标、click_at/pick、像素读回区域截图都不得把负坐标钳到 0
   （代码已按此修过，真机回归确认点击落点不漂移）。

## 附：Unix 一键最小冒烟（2 分钟版）

```bash
python -m unittest discover -s tests -v && \
python tests/ui_contract/validate_contract.py && \
python scripts/smoke_serve.py && \
python scripts/e2e/run_e2e.py
```

全绿 = 后端契约与安全门在本机达标；前端走查（消息流/审批卡/面板/观测台/主题）按 docs/GUIDE.md 顺序过一遍。
