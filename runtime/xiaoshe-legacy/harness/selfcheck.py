"""P3 v1 · 照稿写码自验闭环：渲染→廉价硬信号粗筛→相对判优→迭代，交回历史最优。

心法「循环属于模型，机制属于我们」：模型负责改代码，本模块负责熔断、判优、交 best。
判优纪律（temp=1 强制、采样不可控）：
- 绝不打绝对分、不赌确定性重跑；只问"相对目标 T，A/B 谁更近"。
- **位置互换跑两次**：两次都指向同一候选才算赢，不一致判平——消掉"偏爱第1位"的位置偏置。
- 判优是独立机制调用（用 DG-0 验证过的"单发多图"格式），**绝不看模型自称"改好了"**。
"""
from __future__ import annotations

from . import render as _render


def relative_winner(a, b, judge_fn):
    """相对判优 + 位置互换。judge_fn(first, second) 返回 "1"/"2"（哪一位更接近目标）。

    返回胜出的候选（a 或 b）；两次不一致（含纯位置偏置）→ None（判平，保留旧版/best）。
    """
    r1 = str(judge_fn(a, b)).strip()          # 正序：a 在第1位
    r2 = str(judge_fn(b, a)).strip()          # 互换：b 在第1位
    w1 = a if r1 == "1" else b
    w2 = b if r2 == "1" else a
    return w1 if w1 == w2 else None


def run_loop(target_ref, keywords, propose, render_fn, judge_fn,
             max_rounds: int = 12, patience: int = 8) -> dict:
    """照稿写码自验闭环骨架（依赖全注入，离线可测）。

    每轮：propose(i, feedback)→候选 → render_fn→结果 → 廉价硬信号（渲染 ok + DOM 关键字）粗筛，
    没过不花判优、计一次无改进；过了则与历史 best 相对判优（位置互换），更优才换 best 并清零无改进。
    连续 patience 轮无改进熔断。返回 {best 候选, rounds 日志}——**交 best 非 last**。
    """
    best = None            # (artifact, result)
    feedback = None
    no_improve = 0
    rounds = []
    for i in range(max_rounds):
        art = propose(i, feedback)
        res = render_fn(art)
        ok_render = getattr(res, "ok", False)
        ok_dom, missing = _render.dom_has_all(getattr(res, "dom", ""), keywords)
        if not ok_render or not ok_dom:
            reason = "渲染失败" if not ok_render else f"缺关键文案：{missing}"
            feedback = f"没过廉价硬信号（{reason}），先照规格补齐再谈美观。"
            no_improve += 1
            rounds.append({"round": i, "hard_fail": True, "reason": reason})
            if no_improve >= patience:
                break
            continue
        if best is None:
            best = (art, res)
            no_improve = 0  # 首版通过：清零之前硬失败的累计，别让它缩短后续迭代预算（对抗审查修复）
            feedback = "首版已过硬信号，继续照目标图往更像了改。"
            rounds.append({"round": i, "accepted_first": True})
            continue
        # 相对判优：'cur' vs 'best' 两个哨兵做位置互换，闭包把哨兵映回真实结果给模型判
        cur_res, best_res = res, best[1]
        pick = relative_winner("cur", "best", lambda x, y: judge_fn(
            target_ref, cur_res if x == "cur" else best_res, cur_res if y == "cur" else best_res))
        if pick == "cur":
            best = (art, res)
            no_improve = 0
            feedback = "更接近目标了，保持这个方向继续。"
            rounds.append({"round": i, "improved": True})
        else:
            no_improve += 1
            feedback = "没比上一版更接近，换个改法。"
            rounds.append({"round": i, "improved": False})
        if no_improve >= patience:
            break
    return {"best": best[0] if best else None, "rounds": rounds}
