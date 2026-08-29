"""§4.6.2 分层评测矩阵：元素定位 / 动作执行 / 任务完成 三层 × Win/Mac 双平台，失败归因显性化。

把已有评测入口**编进**分层结构（不另起炉灶）：
- 元素定位层（auto）：evals/ocr_blindspot_suite.py —— OCR 词框定位回归（Win=WinRT / Mac=Vision）。
- 动作执行/任务完成层（manual 真机入口）：evals/gold_standard_win.py / gold_standard_mac.py ——
  真机跑完把全程日志喂回（--gold-log），parse_gold_log 把一次真机跑归因到层：
  zoom/look 凑不齐标记=定位层挂；pick 后显示屏没变=执行层挂；步骤全过但总结回归挂=完成层挂。

归因纪律（§4.6.2）：上一层不过则下层分数无意义——报告里上挂了，下层标「⊘ 上层未过」而非误报红/绿。
截图隐私铁律：本模块不产、不落任何截图；OCR 回归集的渲染图只走临时文件（其既有纪律），
金标准截图只落 docs/验收/（.gitignore 已挡），矩阵只消费**文本日志**。

跑法：
  cd /c/Users/example/Desktop/ke && PYTHONIOENCODING=utf-8 py -3 -m evals.matrix            # 本平台 auto 层 + 矩阵报告
  py -3 -m evals.matrix --gold-log "docs/验收/裁剪重问-Win金标准-截图/<SID>-全程日志.txt"  # 真机日志喂回 → 分层归因
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

L_GROUND, L_ACTION, L_TASK = "grounding", "action", "task"
LAYERS = (L_GROUND, L_ACTION, L_TASK)
LAYER_NAMES = {L_GROUND: "元素定位", L_ACTION: "动作执行", L_TASK: "任务完成"}
PLATFORMS = ("win", "mac")
PLATFORM_NAMES = {"win": "Windows", "mac": "macOS"}

_STATUS_SYMBOL = {"pass": "✅", "fail": "❌", "skip": "⏭", "manual": "✋"}


@dataclass
class Cell:
    """矩阵一格：一个已有评测入口在（层 × 平台）上的落位。
    kind=auto：run()->bool 真跑（离线/本机可跑）；kind=manual：真机入口，cmd 是跑法，parse 把日志归因到层。"""
    id: str
    layer: str
    platform: str
    kind: str                    # "auto" | "manual"
    note: str = ""
    run: object = None           # auto: () -> bool（True=过）；异常=挂（不掀翻矩阵）
    cmd: str = ""                # manual: 真机跑法（也用于 auto 格的复跑提示）
    parse: object = None         # manual: log_text -> {layer: bool|None, "failed_layer": ...}


@dataclass
class CellResult:
    cell: Cell
    status: str                  # "pass" | "fail" | "skip"（他平台）| "manual"（待真机）
    detail: str = ""
    failed_layer: str = None     # 挂在哪层（=cell.layer，为可读性冗余一份）


# ───────────────────────── 金标准日志分层归因（纯函数，离线可测） ─────────────────────────

# 定位层失败锚点：look 三次拿不到窗口标记 / zoom 子视口凑不齐「5」（Win/Mac 两套话术）/ 凑不齐按键编号
_GROUND_FAIL_MARKERS = ("都没拿到计算器窗口标记", "子视口都没有「5」", "都没认出「5」", "凑不齐 2")
# 执行层锚点：pick 后显示屏读数逐步验收（金标准一·第一/二步的 ✅/❌）
_STEP_RE = re.compile(r"金标准一·第[一二]步\] 显示屏出现 \S+：(✅|❌)")


def parse_gold_log(text: str) -> dict:
    """把 gold_standard_win/mac 的全程日志归因到层。返回 {层: True/False/None, failed_layer: 首挂层|None}。
    None = 日志里没证据（没跑到那层/半截日志）——诚实口径，绝不把「没跑」诬报成「挂」。"""
    text = text or ""
    grounding = None
    if any(m in text for m in _GROUND_FAIL_MARKERS):
        grounding = False
    elif "已建子视口" in text:
        grounding = True                       # zoom 真产出了子视口 = 定位链走通
    verdicts = _STEP_RE.findall(text)
    action = all(v == "✅" for v in verdicts) if verdicts else None
    task = None
    for line in text.splitlines():
        if "=== 总结" in line:
            task = "❌" not in line            # 总结行含金标准一/二总判决（含 CE 归零回归）
            break
    by_layer = {L_GROUND: grounding, L_ACTION: action, L_TASK: task}
    failed = next((l for l in LAYERS if by_layer[l] is False), None)   # 层序即依赖序：首挂即根因层
    return {**by_layer, "failed_layer": failed}


# ───────────────────────── 编排 ─────────────────────────

def current_platform() -> str | None:
    if sys.platform == "win32":
        return "win"
    if sys.platform == "darwin":
        return "mac"
    return None


def run_matrix(cells, platform: str | None = None) -> list[CellResult]:
    """按平台跑矩阵：他平台 skip；auto 格真跑（runner 异常记 fail 不掀翻）；manual 格报真机入口。"""
    platform = platform or current_platform()
    results = []
    for c in cells:
        if platform and c.platform != platform:
            results.append(CellResult(c, "skip", detail=f"他平台（{PLATFORM_NAMES.get(c.platform, c.platform)}）入口"))
            continue
        if c.kind == "manual":
            results.append(CellResult(c, "manual", detail=c.cmd))
            continue
        try:
            ok = bool(c.run()) if c.run else False
        except Exception as e:                 # runner 自己崩 = 这格挂，别把矩阵带崩（与 core.run_once 兜底对齐）
            results.append(CellResult(c, "fail", detail=f"{type(e).__name__}: {e}", failed_layer=c.layer))
            continue
        results.append(CellResult(c, "pass" if ok else "fail", detail=c.note,
                                  failed_layer=None if ok else c.layer))
    return results


def apply_gold_log(results: list[CellResult], platform: str, log_text: str) -> dict:
    """把一次真机金标准日志的分层归因填进该平台的 manual 格（日志无证据的层保持 manual，不诬报）。"""
    attr = parse_gold_log(log_text)
    for cr in results:
        c = cr.cell
        if cr.status == "skip" or c.platform != platform or c.kind != "manual" or c.parse is None:
            continue
        v = attr.get(c.layer)
        if v is None:
            continue
        cr.status = "pass" if v else "fail"
        cr.failed_layer = None if v else c.layer
    return attr


def _find(results, layer, platform):
    return next((r for r in results if r.cell.layer == layer and r.cell.platform == platform), None)


# ───────────────────────── 报告 ─────────────────────────

def render_report(results: list[CellResult]) -> str:
    """3 层 × Win/Mac 矩阵报告 + 失败归因（上层挂 → 下层「⊘ 上层未过」，分数无意义，不误导）。"""
    first_fail = {}                            # 每平台首个挂层（层序=依赖序：定位→执行→完成）
    for p in PLATFORMS:
        for layer in LAYERS:
            r = _find(results, layer, p)
            if r and r.status == "fail":
                first_fail[p] = layer
                break

    def sym(r, p, layer):
        if r is None:
            return "—"
        ff = first_fail.get(p)
        if ff and LAYERS.index(layer) > LAYERS.index(ff):
            return "⊘ 上层未过"
        return _STATUS_SYMBOL[r.status]

    lines = [f"# 分层评测矩阵 · {time.strftime('%Y-%m-%d %H:%M:%S')}（§4.6.2）", "",
             "| 层 \\ 平台 | Windows | macOS |", "|---|---|---|"]
    for layer in LAYERS:
        lines.append(f"| {LAYER_NAMES[layer]} | {sym(_find(results, layer, 'win'), 'win', layer)} "
                     f"| {sym(_find(results, layer, 'mac'), 'mac', layer)} |")
    lines += ["", "图例：✅ 过 / ❌ 挂 / ✋ 真机手动入口 / ⏭ 他平台 / ⊘ 上层未过（下层分数无意义）", "",
              "## 失败归因"]
    if first_fail:
        for p, layer in first_fail.items():
            r = _find(results, layer, p)
            lines.append(f"- {PLATFORM_NAMES[p]}：**{LAYER_NAMES[layer]}层挂**（{r.cell.id}"
                         f"{('：' + r.detail) if r.detail else ''}）——先修这层，其下层分数无意义")
    else:
        tail = "；真机 manual 层待跑" if any(r.status == "manual" for r in results) else ""
        lines.append(f"- auto 层无失败{tail}")
    manual_cmds = sorted({r.cell.cmd for r in results if r.cell.kind == "manual" and r.cell.cmd})
    if manual_cmds:
        lines += ["", "## 真机手动入口（跑完把全程日志喂回：py -3 -m evals.matrix --gold-log <日志>）"]
        lines += [f"- {c}" for c in manual_cmds]
    return "\n".join(lines)


# ───────────────────────── 注册表：已有入口编进分层结构 ─────────────────────────

def _run_ocr_blindspot() -> bool:
    """定位层 auto 入口：OCR 词框定位回归集（Win=WinRT / Mac=Vision；--no-save 只打 stdout）。"""
    from . import ocr_blindspot_suite
    return ocr_blindspot_suite.main(["--no-save"]) == 0


_GOLD_WIN_CMD = "py -3 evals/gold_standard_win.py"
_GOLD_MAC_CMD = "python3 evals/gold_standard_mac.py"

MATRIX = [
    Cell("ocr-blindspot-win", L_GROUND, "win", "auto", run=_run_ocr_blindspot,
         note="OCR 词框定位回归（WinRT 盲区集，门禁 0.85）", cmd="py -3 evals/ocr_blindspot_suite.py"),
    Cell("ocr-blindspot-mac", L_GROUND, "mac", "auto", run=_run_ocr_blindspot,
         note="OCR 词框定位回归（Vision）", cmd="python3 evals/ocr_blindspot_suite.py"),
    Cell("gold-standard-win", L_ACTION, "win", "manual", cmd=_GOLD_WIN_CMD, parse=parse_gold_log,
         note="look/zoom→pick 生效（UIA CalculatorResults 权威读数）"),
    Cell("gold-standard-win-task", L_TASK, "win", "manual", cmd=_GOLD_WIN_CMD, parse=parse_gold_log,
         note="端到端终态（显示 52 + CE 归零回归）"),
    Cell("gold-standard-mac", L_ACTION, "mac", "manual", cmd=_GOLD_MAC_CMD, parse=parse_gold_log,
         note="look/zoom→pick 生效（剪贴板权威读数）"),
    Cell("gold-standard-mac-task", L_TASK, "mac", "manual", cmd=_GOLD_MAC_CMD, parse=parse_gold_log,
         note="端到端终态（显示 52 + AC/C 归零回归）"),
]


def main(argv=None, cells=None) -> int:
    ap = argparse.ArgumentParser(prog="evals.matrix",
                                 description="§4.6.2 分层评测矩阵（元素定位/动作执行/任务完成 × Win/Mac）")
    ap.add_argument("--platform", choices=PLATFORMS, default=None, help="只跑指定平台列（默认按当前系统）")
    ap.add_argument("--gold-log", default=None,
                    help="真机金标准全程日志：喂回把 manual 格按层填状态并给出首挂层归因")
    args = ap.parse_args(argv)
    cells = MATRIX if cells is None else cells
    platform = args.platform or current_platform()
    results = run_matrix(cells, platform)
    if args.gold_log:
        text = Path(args.gold_log).read_text(encoding="utf-8", errors="replace")
        gp = ("win" if "Windows 真机金标准" in text else
              "mac" if "Mac 真机金标准" in text else platform)     # 平台从日志头认，认不出回退 --platform
        if gp:
            attr = apply_gold_log(results, gp, text)
            verdict = (f"首挂：{LAYER_NAMES[attr['failed_layer']]}层" if attr["failed_layer"]
                       else "三层无失败证据（全过或没跑到）")
            print(f"[归因] 金标准日志 → {PLATFORM_NAMES.get(gp, gp)}：{verdict}\n")
    print(render_report(results))
    return 1 if any(r.status == "fail" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
