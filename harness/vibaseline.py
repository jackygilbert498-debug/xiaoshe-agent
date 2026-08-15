"""视觉回归基线：每次 render_check 把当前截图折成一个 dHash 存 `.state/render_baseline.json`，
下次渲染**同一文件**时报「整体视觉与上次是否一致」——改了样式却没生效这类静默失败一眼看出（也省一次视觉复判）。

§4.5.2 起扩成**区域化**：基线条目同时存 4×4 区域 dHash，比对时报「哪个区域变了」（regions_changed，
行主序索引），把整图「变没变」降解成可执行的定位诊断；compare_pngs 给照稿写码闭环做
「设计稿 vs 渲染图」逐区域打分，FitLoop 承载「≤2 轮修复 + 退化回滚历史最优」的迭代预算（纯状态机）。

§4.6.3 salvaged 两点：
- **断言绑特征不绑实现**：判断只绑 dHash 距离/区域索引这类视觉特征，不绑视口 id、像素坐标等实现细节。
- **三值判决**（AgentAssay）：check 返回 verdict ∈ {PASS, FAIL, INCONCLUSIVE}——基线缺失（首次）、
  无梯度判不了（weak）、观测失败，一律 INCONCLUSIVE 而非硬 PASS/FAIL；INCONCLUSIVE 绝不可当 PASS 用，
  消费方须显式判 == "PASS"。FAIL 在本探测器语境 = 「与基线不同」（疑似回归信号），不等于「页面错」。

纪律：
- 纯**加**信息、绝不抑制截图——模型永远还是拿到当前截图亲眼看，基线只是多给一句判断。
- dHash 是**粗**的布局哈希：大改必报变化、局部小字微调可能被判「基本一致」——措辞如实、拿不准以亲眼看为准。
- 观测失败绝不冒泡（render_check 主流程不能被基线拖崩）：任何异常都回落成 {"ok": False, verdict: INCONCLUSIVE}。
- 并发（spawn_parallel 多分身同时渲染）用 file_lock，防读-改-写丢更新；键有上限、超限淘汰最旧防无界增长。

`.state/` 已 gitignore，不进 git、不泄漏。
"""
from __future__ import annotations

import json
from pathlib import Path

from . import _io, config, imaging

BASELINE_FILE = config.ROOT / ".state" / "render_baseline.json"
# 真机实测：无头 chrome 对同一 HTML 逐字节确定（同文件两次截图 sha 相同、dHash 距离 0）。
# 故 _SAME_MAX=0——只有 dHash 逐格一致才算「一致」，任何变化都报「变化」；假「变化」是安全方向（模型照样看截图核实）。
# 反面（_SAME_MAX>0）会把「换主色+加整块」这种真改动的距离(实测 8×8 仅 1)吞成「一致」，即有害的漏报。
_SAME_MAX = 0
_HASH_SIZE = 32     # 32×32=1024 位：真机实测下更细的格子能逮到「只改一个按钮词」这类小改，且 chrome 确定→无假「变化」副作用
_MAX_KEYS = 300     # 基线键（渲染过的文件）上限，超限按插入序淘汰最旧
_LOCK_TIMEOUT = 5

# 区域化比对（§4.5.2）：4×4 网格 × 8×8 位 dHash。区域级阈值 _REGION_SAME_MAX=2（64 位里容 2 位）——
# 同机同文件 chrome 确定（距离 0），但跨环境/字体抗锯齿渲染会有亚像素抖动，区域格子比整图 32×32 粗、
# 单格更容易被噪声翻动，留 2 位余量吸收（红队：光标/抗锯齿噪声）；真改动（换布局/换配色）距离远大于 2。
_REGION_NX = 4
_REGION_NY = 4
_REGION_SIZE = 8
_REGION_SAME_MAX = 2

# §4.6.3 三值判决（AgentAssay）：基线缺失/环境差异大 → INCONCLUSIVE，而非硬 PASS/FAIL
PASS = "PASS"
FAIL = "FAIL"
INCONCLUSIVE = "INCONCLUSIVE"


def _load(p: Path) -> dict:
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _regions_changed(prev_regions, cur_regions, prev_rn, cur_rn) -> list:
    """逐区域汉明距离 > _REGION_SAME_MAX 的区域索引（行主序）。
    基线无区域数据或网格口径（rn）与本次不同 → 空（如实说没得比，防错把异网格哈希当同区域比）。"""
    if prev_rn != cur_rn:
        return []
    if not (isinstance(prev_regions, list) and len(prev_regions) == len(cur_regions)):
        return []
    return [i for i, (a, b) in enumerate(zip(prev_regions, cur_regions))
            if isinstance(a, int) and imaging.hamming(b, a) > _REGION_SAME_MAX]


def check(key: str, png: bytes, size: int = _HASH_SIZE, store_path=None,
          nx: int = _REGION_NX, ny: int = _REGION_NY) -> dict:
    """算 png 的 dHash（整图 + 区域）、与 key 上次的基线比、更新基线，返回判断。

    返回 {"ok", "first", "changed", "distance", "weak", "regions_changed", "verdict"}；
    坏图/存储 I/O 异常 → {"ok": False, "verdict": INCONCLUSIVE}（绝不冒泡到 render_check）。
    regions_changed 为行主序区域索引（基线是旧格式无区域数据 → 空列表，下次比对自动升级）。
    """
    try:
        h = imaging.dhash(png, size=size)
        cur_regions = imaging.region_hashes(png, nx=nx, ny=ny, size=_REGION_SIZE)
    except Exception:   # 坏/不支持的 PNG（decode 已收口成 ValueError；MemoryError 等也一并兜住）
        return {"ok": False, "verdict": INCONCLUSIVE}
    weak = (h == 0)   # dHash 全 0 = 整图无梯度结构（纯色/极均匀）→ 感知哈希判不了变化，措辞须如实（红队 LOW-1）
    p = Path(store_path) if store_path else BASELINE_FILE
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with _io.file_lock(p, timeout=_LOCK_TIMEOUT):
            store = _load(p)
            prev = store.get(key)
            if isinstance(prev, dict) and isinstance(prev.get("dhash"), int) and prev.get("size") == size:
                dist = imaging.hamming(h, prev["dhash"])
                changed = dist > _SAME_MAX
                # 三值判决：无梯度判不了 → INCONCLUSIVE；与基线不同 → FAIL（=变化，非「页面错」）；一致 → PASS
                verdict = INCONCLUSIVE if weak else (FAIL if changed else PASS)
                result = {"ok": True, "first": False, "changed": changed, "distance": dist, "weak": weak,
                          "regions_changed": _regions_changed(prev.get("regions"), cur_regions,
                                                              prev.get("rn"), [nx, ny]),
                          "rn": [nx, ny], "verdict": verdict}
            else:
                # 基线缺失（首次渲染此文件）：没得比 → INCONCLUSIVE，绝不硬 PASS（红队：三值被当 PASS 用）
                result = {"ok": True, "first": True, "changed": False, "distance": 0, "weak": weak,
                          "regions_changed": [], "rn": [nx, ny], "verdict": INCONCLUSIVE}
            store.pop(key, None)                 # 重新插到末尾（LRU：最近渲染的最后淘汰）
            store[key] = {"dhash": h, "size": size, "rn": [nx, ny], "regions": cur_regions}
            while len(store) > _MAX_KEYS:         # 超限淘汰最旧（dict 保插入序）
                store.pop(next(iter(store)))
            _io.atomic_write_text(p, json.dumps(store, ensure_ascii=False))
        return result
    except Exception:
        # 磁盘满/只读/抢锁超时/任何意外 → 一律回落 {ok:False}：纪律②「观测失败绝不拖崩 render_check」，
        # 与本模块 docstring 承诺一致（红队：兜底须覆盖任何异常，防未来改动漏网穿到信任边界）。
        return {"ok": False, "verdict": INCONCLUSIVE}


def compare_pngs(png_a: bytes, png_b: bytes, nx: int = _REGION_NX, ny: int = _REGION_NY,
                 size: int = _REGION_SIZE) -> dict:
    """§4.5.2 照稿写码比对腿：两张 PNG（如设计稿 vs 渲染图）逐区域 dHash 比对。

    返回 {"ok", "distance", "regions_changed"}：distance=各区域汉明距离之和（越小越像，喂 FitLoop 当分数），
    regions_changed=距离 > _REGION_SAME_MAX 的区域索引（修稿提示词据此定位「改哪个区域」）。
    坏图/尺寸异常 → {"ok": False}（绝不冒泡）。
    """
    try:
        ha = imaging.region_hashes(png_a, nx=nx, ny=ny, size=size)
        hb = imaging.region_hashes(png_b, nx=nx, ny=ny, size=size)
    except Exception:
        return {"ok": False}
    dists = [imaging.hamming(a, b) for a, b in zip(ha, hb)]
    return {"ok": True, "distance": sum(dists),
            "regions_changed": [i for i, d in enumerate(dists) if d > _REGION_SAME_MAX]}


class FitLoop:
    """§4.5.2 照稿写码迭代预算（纯状态机，循环编排属于上层/模型，机制属于这里）：

    - record(score) 每渲染一轮记一次与目标稿的距离（compare_pngs 的 distance，越小越好）；
    - 硬性预算 MAX_ROUNDS=2 轮修复（Sketch2Code 实证：第 3 轮后收益停滞且可退化）→ "stop"；
    - 当前轮比历史任何轮都差（严格退化）→ "rollback"，回滚到 best_round 历史最优并停止；
    - 否则 "continue"。返回 {"round", "action", "best_round", "best_score", "budget_left"}。
    """
    MAX_ROUNDS = 2

    def __init__(self):
        self._scores = []

    def record(self, score: float) -> dict:
        self._scores.append(float(score))
        cur = len(self._scores) - 1
        prev_best = min(range(cur), key=lambda i: self._scores[i]) if cur > 0 else cur
        best = min(range(len(self._scores)), key=lambda i: self._scores[i])
        out = {"round": cur, "best_round": best, "best_score": self._scores[best],
               "budget_left": max(0, self.MAX_ROUNDS - cur)}
        if cur > 0 and self._scores[cur] > self._scores[prev_best]:
            out["action"] = "rollback"   # 退化：回滚历史最优并停止（回滚动作由上层执行并记 effects.jsonl）
            out["best_round"] = prev_best
            out["best_score"] = self._scores[prev_best]
        elif cur >= self.MAX_ROUNDS:
            out["action"] = "stop"       # 2 轮修复预算耗尽：第 3 轮强制停而非「再试一次」
        else:
            out["action"] = "continue"
        return out
