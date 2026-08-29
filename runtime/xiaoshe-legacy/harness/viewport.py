"""视口（viewport）：统一「裁剪-重问」子系统的坐标心脏。纯 Python、无子进程、无 IO。

spec：docs/superpowers/specs/2026-07-19-统一裁剪重问子系统-design.md §核心不变式/§组件 1。

核心不变式：
- ①（回屏变换）每个视口携带 origin=(ox,oy) 与 scale，满足
  「屏幕坐标 = origin + 图内坐标 / scale」。「屏幕坐标」= 执行层坐标系
  （Mac=逻辑点、Win=物理像素——Win DPI 感知后两者本相等）。
  根视口 scale = 截图像素 ÷ 屏幕逻辑尺寸（Mac Retina=2、Win=1，可实测不假设）；
  子视口 scale = 父 scale × 放大倍数 k。
- ②（模型零算术）一切给模型的坐标都已换算成屏幕坐标；模型只说「zoom N 号」「pick N 号」。

注册表：会话内存 OrderedDict（上限 8，LRU 淘汰最久未访问），不落盘（截图内容隐私，会话结束即弃）。
**按会话隔离**：工具面走 `new_registry()` 在 ctx 挂一份（多会话/多 headless 同进程互不串）；
模块级 `_REGISTRY` + `register(vp)`/`get(vid)` 单参形态只留纯函数测试用。
"""
from __future__ import annotations

import math
from collections import OrderedDict

_MAX_VIEWPORTS = 8          # 注册表上限：够 look→zoom→再 zoom 的收窄链，又封内存无界增长
_MAX_ZOOM_DEPTH = 3         # zoom 迭代收窄级数上限（§4.3.1「≤3 级，不收敛判失败换通道」：
                            # Iterative Narrowing 报告 2–3 轮收益递减；Mac/Win 金标准均 zoom×3 收敛）
_SOURCES = ("uia", "ocr", "uia+ocr")   # 框源：UIA 元素框 / OCR 词框 / 合并去重后的双源框（spec §组件 4）
_MERGE_MAX_DIST = 16        # 合并去重阈值（spec §框源）：中心距 < 16 物理像素（截图像素系）的 AX/OCR 框并为一个编号

# 模块级注册表：id → Viewport。OrderedDict 序 = 访问热度（尾部最新）。仅纯函数测试用，工具面走 ctx 那份。
_REGISTRY: OrderedDict = OrderedDict()


def new_viewport(vid: str, origin, scale, size, marks=None, parent_id=None) -> dict:
    """建视口数据：{id, origin, scale, size, marks, parent_id}。
    marks = {编号:int → {no, label, screen_cx, screen_cy, source}}（可加 screen_w/screen_h 供 zoom 按编号周边裁剪），
    屏幕坐标（source ∈ uia/ocr/uia+ocr）建视口时就已换算好（框源侧职责，这里只校验形态）。"""
    if not math.isfinite(scale) or scale <= 0:   # NaN 会漏过 `<= 0`；inf 会让 x/s 恒为 0
        raise ValueError(f"scale 须为正且有限（实为 {scale!r}）")
    w, h = size
    if not (math.isfinite(w) and math.isfinite(h)) or w <= 0 or h <= 0:
        raise ValueError(f"视口尺寸非法（{size!r}）")
    marks = dict(marks or {})
    for no, m in marks.items():
        if m.get("source") not in _SOURCES:
            raise ValueError(f"mark {no} 来源非法（{m.get('source')!r}，仅 uia/ocr）")
    return {"id": vid, "origin": (origin[0], origin[1]), "scale": scale,
            "size": (w, h), "marks": marks, "parent_id": parent_id}


def to_screen(vp: dict, x, y) -> tuple[int, int]:
    """图内坐标 → 屏幕坐标（不变式①：origin + 图内坐标 / scale）。浮点 scale 安全，返回 int round。"""
    ox, oy = vp["origin"]
    s = vp["scale"]
    return int(round(ox + x / s)), int(round(oy + y / s))


def crop_viewport(vp: dict, region, k: int = 2) -> dict:
    """按 region（相对父视口图内坐标，x,y,rw,rh）+ 放大倍数 k 算子视口参数。
    region clamp 到父视口内；完全不相交 → ValueError；k 仅支持 2/3（对齐 imaging.upscale）。
    返回 {origin, scale, size, parent_id, marks}——size 是放大后的图尺寸，marks 置空
    （子视口要对小图重新打框重编号，编号不继承）。"""
    if k not in (2, 3) or not isinstance(k, int):
        raise ValueError(f"放大倍数仅支持 2/3（实为 {k!r}）")
    w, h = vp["size"]
    x, y, rw, rh = (int(v) for v in region)
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(w, x + rw), min(h, y + rh)
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        raise ValueError(f"裁剪区域与视口不相交（region={tuple(region)}，视口 {w}x{h}）")
    ox, oy = vp["origin"]
    s = vp["scale"]
    return {"origin": (ox + x0 / s, oy + y0 / s),   # 不变式①逆用：图内偏移 ÷ 父 scale 得屏幕偏移
            "scale": s * k,
            "size": ((x1 - x0) * k, (y1 - y0) * k),
            "parent_id": vp["id"],
            "marks": {}}


def new_registry() -> OrderedDict:
    """一份会话级视口注册表（工具面 ctx.setdefault 挂载：多会话/多 headless 同进程互不串）。
    附带 `_next_seq` 单调 id 计数器：LRU 淘汰掉的 id 也不回收（见 next_id）。"""
    reg = OrderedDict()
    reg._next_seq = 0
    return reg


def register(vp: dict, registry=None) -> str:
    """注册视口，返回 id。超上限淘汰最久未访问的（LRU）；同 id 覆盖不占新坑。
    registry 缺省 = 模块级 _REGISTRY（纯函数测试）；工具面传 ctx 那份（会话隔离）。"""
    reg = _REGISTRY if registry is None else registry
    vid = vp["id"]
    reg[vid] = vp
    reg.move_to_end(vid)
    while len(reg) > _MAX_VIEWPORTS:
        reg.popitem(last=False)
    return vid


def get(vid: str, registry=None):
    """取视口；不存在（含被 LRU 淘汰）→ None（上层据此报「视口已过期，重新 look」）。
    命中即刷新热度（move_to_end）。registry 缺省 = 模块级 _REGISTRY，工具面传 ctx 那份。"""
    reg = _REGISTRY if registry is None else registry
    vp = reg.get(vid)
    if vp is not None:
        reg.move_to_end(vid)
    return vp


def chain_depth(vp: dict, registry) -> int:
    """视口在 parent 链上的深度（根=1）——zoom ≤3 级深度闸的计数源（§4.3.1）。
    fail-soft：祖先被 LRU 淘汰无从追溯时按能走到的链算（偏浅不虚高），防环兜底。registry 用
    OrderedDict.get（不刷 LRU 热度，照 _zoom 实测 scale 反向校验找根的先例）。"""
    depth, seen, cur = 1, {vp["id"]}, vp
    while cur.get("parent_id"):
        pid = cur["parent_id"]
        if pid in seen:
            break
        seen.add(pid)
        anc = registry.get(pid) if registry is not None else None
        if anc is None:
            break
        depth += 1
        cur = anc
    return depth


def center_offset(vp: dict, sx, sy) -> tuple[float, float]:
    """屏幕坐标点相对视口中心的归一化偏移（|dx|/半宽, |dy|/半高：0=正中，1=贴边）。
    zoom 出口偏移校验的信号源（§4.2.3 改造：模型从不产预测点——模型零算术不变式——
    改用「pick 编号位置相对视口中心的偏移」这个框架侧几何信号；全部框架侧计算，模型不算数）。"""
    w, h = vp["size"]
    s = vp["scale"]
    ox, oy = vp["origin"]
    half_w, half_h = w / (2 * s), h / (2 * s)      # 半幅（屏幕坐标系）
    ccx, ccy = ox + half_w, oy + half_h
    return abs(sx - ccx) / half_w, abs(sy - ccy) / half_h


def next_id(registry) -> str:
    """分配视口 id（v1/v2…）：**会话内单调、LRU 淘汰掉的 id 也绝不回收**——模型上下文里还留着
    旧 id 与旧编号图，回收复用会让「zoom v1」张冠李戴点错视口（2026-07-22 红队真跑复现）。
    计数器挂在 new_registry() 造的注册表上；裸 dict/无计数器时退化为从 1 扫空位。"""
    n = getattr(registry, "_next_seq", 0) + 1
    while f"v{n}" in registry:
        n += 1
    try:
        registry._next_seq = n
    except AttributeError:
        pass
    return f"v{n}"


def merge_marks(ax_boxes: list, ocr_boxes: list, max_dist: float = _MERGE_MAX_DIST) -> list:
    """AX/OCR 两路框源（图内像素坐标，[{label, box=(x,y,w,h)}]）合并去重 → [{label, box, source}]。

    规则（tests/test_look_tool.py 钉死，spec §框源）：
    - AX 框先行（保原序），逐个吸收中心距 < max_dist 的**最近** OCR 框 → 合并框 label 取 AX 名
      （AX 名空则回落 OCR 词文本）、box 取 AX 框（执行层语义更可靠）、source 记 "uia+ocr"；
    - 一个 OCR 框至多被一个 AX 框吸收；
    - 未配对的 AX 框 source="uia"、未配对的 OCR 框 source="ocr"，OCR 余框排在 AX 之后。
    """
    def _center(b):
        return (b[0] + b[2] / 2, b[1] + b[3] / 2)

    ocr_centers = [_center(o["box"]) for o in ocr_boxes]
    used = [False] * len(ocr_boxes)
    out = []
    for a in ax_boxes:
        ac = _center(a["box"])
        best, best_d = -1, None
        for i, oc in enumerate(ocr_centers):
            if used[i]:
                continue
            d = math.hypot(ac[0] - oc[0], ac[1] - oc[1])
            if d < max_dist and (best_d is None or d < best_d):
                best, best_d = i, d
        if best >= 0:
            used[best] = True
            out.append({"label": a["label"] or ocr_boxes[best]["label"],
                        "box": a["box"], "source": "uia+ocr"})
        else:
            out.append({"label": a["label"], "box": a["box"], "source": "uia"})
    for i, o in enumerate(ocr_boxes):
        if not used[i]:
            out.append({"label": o["label"], "box": o["box"], "source": "ocr"})
    return out
