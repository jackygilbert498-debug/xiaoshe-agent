#!/usr/bin/env python3
"""细线 S 形蛇标 → PNG 图标套（纯标准库，M4-B）。

源头是 ui/assets/snake.svg（F1 已交付的细线蛇标）。本脚本**直接解析该 SVG**
的 path（M/L/C 绝对命令，本资产只用这三种）与点睛 circle，程序化光栅化：

  1. 在 4× 超采样网格上，把 S 形蛇身（贝塞尔采样成折线）+ 蛇信画成
     「圆头粗线」（沿曲线等距盖圆章，天然圆端/圆角，stroke-linecap=round 语义）；
  2. 点睛（filled circle）；
  3. 4×4 box 降采样 → 抗锯齿 alpha；用色固定朱砂 #b03a26 on 透明；
  4. PNG 编码复用 harness/imaging.py 的 encode_png（zlib+struct 标准库实现）。

产出（git 跟踪，勿手改，改了 snake.svg 就重跑本脚本）：
  tauri/icons/icon-{16,32,128,256,512}.png   —— tauri.conf.json bundle.icon 引用
  ui/assets/icon-{16,32,128,256,512}.png     —— 32px 供 favicon：
      <link rel="icon" type="image/png" sizes="32x32" href="assets/icon-32.png">
      （svg favicon 仍是首选：<link rel="icon" type="image/svg+xml" href="assets/snake.svg">，
        PNG 仅作旧浏览器兜底；品牌位/nav 一律用 snake.svg，见 R4 §9 CSP 纪律）

跑完自动做读回校验（harness.imaging.decode_png 验证尺寸/通道/非空率）
并以 ASCII 打印 32px 的 alpha 矩阵供肉眼自验 S 形。
"""
from __future__ import annotations

import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))          # 复用 harness 的自写 PNG 编解码

from harness import imaging            # noqa: E402

SVG_PATH = ROOT / "ui" / "assets" / "snake.svg"
TAURI_ICONS = ROOT / "tauri" / "icons"
UI_ASSETS = ROOT / "ui" / "assets"
SIZES = (16, 32, 128, 256, 512)
SUPERSAMPLE = 4
VIEWBOX = 24.0                         # snake.svg viewBox 0 0 24 24
STROKE_UNITS = 1.5                     # snake.svg stroke-width
CINNABAR = (0xB0, 0x3A, 0x26)          # 朱砂 --bronze（R4 §1 设计 token）


# ---------------------------------------------------------------- SVG 解析

def _tokens(d: str) -> list[str]:
    return re.findall(r"[MLC]|-?\d*\.?\d+", d)


def parse_svg(text: str):
    """抽出全部 <path d="..."> 的折线/贝塞尔段与 <circle> 点睛。仅支持绝对 M/L/C。"""
    paths = []
    for d in re.findall(r'<path\s+d="([^"]+)"', text, re.S):
        toks, i, cur = _tokens(d), 0, (0.0, 0.0)
        segs = []                        # ("L", p0, p1) 或 ("C", p0, c1, c2, p1)
        while i < len(toks):
            cmd = toks[i]
            nums = lambda n: [float(toks[i + 1 + k]) for k in range(n)]
            if cmd == "M":
                v = nums(2); cur = (v[0], v[1]); i += 3
            elif cmd == "L":
                v = nums(2); p = (v[0], v[1]); i += 3
                segs.append(("L", cur, p)); cur = p
            elif cmd == "C":
                v = nums(6); i += 7
                c1, c2, p = (v[0], v[1]), (v[2], v[3]), (v[4], v[5])
                segs.append(("C", cur, c1, c2, p)); cur = p
            else:
                raise ValueError(f"snake.svg 出现未支持命令 {cmd}（只支持绝对 M/L/C）")
        paths.append(segs)
    m = re.search(r"<circle\s+cx=\"([\d.]+)\"\s+cy=\"([\d.]+)\"\s+r=\"([\d.]+)\"", text)
    if not m:
        raise ValueError("snake.svg 缺点睛 circle")
    eye = (float(m.group(1)), float(m.group(2)), float(m.group(3)))
    return paths, eye


# ---------------------------------------------------------------- 光栅化

def _sample_paths(paths, scale: float, step_px: float) -> list[tuple[float, float]]:
    """把所有 path 段等距采样成点列（像素坐标）。贝塞尔按弧长近似加密。"""
    pts: list[tuple[float, float]] = []

    for segs in paths:
        for seg in segs:
            if seg[0] == "L":
                (_, (x0, y0), (x1, y1)) = seg
                n = max(1, math.ceil(math.hypot(x1 - x0, y1 - y0) * scale / step_px))
                for k in range(n + 1):
                    t = k / n
                    pts.append(((x0 + (x1 - x0) * t) * scale, (y0 + (y1 - y0) * t) * scale))
            else:
                (_, p0, c1, c2, p1) = seg
                # 控制多边形长近似弧长，足够密即可（章距 << 半径，过采样只是稍慢）
                approx = (math.dist(p0, c1) + math.dist(c1, c2) + math.dist(c2, p1)) * scale
                n = max(8, math.ceil(approx / step_px))
                for k in range(n + 1):
                    t = k / n
                    mt = 1 - t
                    x = mt**3 * p0[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t**3 * p1[0]
                    y = mt**3 * p0[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t**3 * p1[1]
                    pts.append((x * scale, y * scale))
    return pts


def _stamp_disc(buf: bytearray, w: int, cx: float, cy: float, r: float, spans):
    """盖实心圆章：按行切片写入，快于逐像素距离判断。"""
    ri = int(math.ceil(r))
    for dy in range(-ri, ri + 1):
        y = int(cy) + dy
        if y < 0 or y >= w:
            continue
        half = spans[dy + ri]            # 预计算的弦半宽表
        xa, xb = max(0, int(cx - half)), min(w - 1, int(cx + half))
        row = y * w
        buf[row + xa: row + xb + 1] = b"\x01" * (xb - xa + 1)


def render(size: int, paths, eye) -> bytes:
    """size×size 画布 → RGBA 字节。4× 超采样 + box 降采样。"""
    w = size * SUPERSAMPLE
    scale = w / VIEWBOX
    r = STROKE_UNITS / 2 * scale         # 圆头粗线半径
    buf = bytearray(w * w)

    def spans(rad):
        ri = int(math.ceil(rad))
        return [math.sqrt(max(0.0, rad * rad - d * d)) for d in range(-ri, ri + 1)]

    line_spans, eye_spans = spans(r), spans(eye[2] * scale)
    for (px, py) in _sample_paths(paths, scale, step_px=max(0.75, r * 0.5)):
        _stamp_disc(buf, w, px, py, r, line_spans)
    _stamp_disc(buf, w, eye[0] * scale, eye[1] * scale, eye[2] * scale, eye_spans)

    # 4×4 box 降采样：覆盖率 → alpha；颜色恒定朱砂（等价预乘，透明处 RGB 无所谓）
    s = SUPERSAMPLE
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            acc = 0
            base = (y * s) * w + x * s
            for yy in range(s):
                row = base + yy * w
                acc += sum(buf[row: row + s])
            a = acc * 255 // (s * s)
            o = (y * size + x) * 4
            out[o], out[o + 1], out[o + 2], out[o + 3] = *CINNABAR, a
    return bytes(out)


# ---------------------------------------------------------------- 校验/自验

def ascii_art(px: bytearray, w: int, h: int) -> str:
    """按 alpha 分四档打印，肉眼验 S 形。"""
    chars = " .:+@"
    lines = []
    for y in range(h):
        line = "".join(chars[min(4, px[(y * w + x) * 4 + 3] * 5 // 256)] for x in range(w))
        lines.append(line)
    return "\n".join(lines)


def main() -> int:
    text = SVG_PATH.read_text(encoding="utf-8")
    paths, eye = parse_svg(text)
    TAURI_ICONS.mkdir(parents=True, exist_ok=True)
    UI_ASSETS.mkdir(parents=True, exist_ok=True)

    failures = 0
    for size in SIZES:
        rgba = render(size, paths, eye)
        png = imaging.encode_png(size, size, rgba)
        for dest in (TAURI_ICONS / f"icon-{size}.png", UI_ASSETS / f"icon-{size}.png"):
            dest.write_bytes(png)
        # 读回校验：尺寸、通道数、非空率（透明底图上必须确实有蛇）
        w, h, px = imaging.decode_png(png)
        assert (w, h) == (size, size), f"尺寸回读不符 {w}x{h}"
        assert len(px) == size * size * 4, "通道数不是 RGBA"
        opaque = sum(1 for i in range(3, len(px), 4) if px[i] >= 128)
        ratio = opaque / (size * size)
        ok = 0.02 < ratio < 0.6          # 细线标合理覆盖率区间，防全空/全实回归
        failures += 0 if ok else 1
        print(f"icon-{size}.png  {len(png):>6} B  覆盖 {ratio:5.1%}  读回 {w}x{h} RGBA  {'OK' if ok else 'FAIL'}")
        if size == 32:
            print("\n32px alpha ASCII 自验（应可辨 S 形，头在右上点睛，尾收左下）：")
            print(ascii_art(px, w, h))
            print()

    print("favicon 引用：首选 SVG → "
          '<link rel="icon" type="image/svg+xml" href="assets/snake.svg">；')
    print("            PNG 兜底 → "
          '<link rel="icon" type="image/png" sizes="32x32" href="assets/icon-32.png">')
    if failures:
        print(f"FAIL: {failures} 张图标覆盖率越界", file=sys.stderr)
        return 1
    print("全部读回校验通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
