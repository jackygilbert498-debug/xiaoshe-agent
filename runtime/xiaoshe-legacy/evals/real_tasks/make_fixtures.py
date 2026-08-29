"""D3 fixtures：现跑现生成，零真实用户数据、零隐私内容（全是合成色块/形状/乱起名）。

- 图片：harness.imaging 纯标准库合成（纯色底 + 形状 + 数字标签）。
- 视频：ffmpeg（testsrc2 思路的分段变色：前 5s 红、后 5s 蓝），ffmpeg 缺失 → RuntimeError（调用方兜底）。

任务与 verifier 共用本模块的确定性常量（文件名清单/形状颜色表），保证 setup 与 verify 不脱节。
CLI：`py -3 -m evals.real_tasks.make_fixtures [目录]`（缺省 .state/d3/fixtures-preview）生成一份供肉眼检查。
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from harness import imaging

# ── 确定性常量：任务定义与 verifier 共用 ──────────────────────────────

PALETTE = {  # 形状/底色原型（verifiers.classify 的最近邻原型）
    "red": (230, 30, 30),
    "blue": (30, 80, 230),
    "green": (30, 180, 60),
    "yellow": (240, 210, 40),
}

# T1：4 张「色底 + 大数字」图
T1_SPECS = (  # (文件名, 底色名, 数字标签)
    ("pic_01.png", "red", "1"),
    ("pic_02.png", "blue", "2"),
    ("pic_03.png", "green", "3"),
    ("pic_04.png", "yellow", "4"),
)
T1_FILENAMES = tuple(n for n, _, _ in T1_SPECS)

# T2：A/B 双文件夹，形状+颜色配对；B 的文件名是乱序随机名
T2_SHAPES = (  # (配对名=A文件名, 形状, 颜色名)
    ("yuan.png", "circle", "red"),
    ("fang.png", "square", "blue"),
    ("sanjiao.png", "triangle", "green"),
)
T2_B_NAMES = ("x7k2.png", "q3m9.png", "z8w1.png")  # 与 T2_SHAPES 一一对应（乱序感，确定性）
T2_A_NAMES = tuple(n for n, _, _ in T2_SHAPES)

# T3：pool 素材库，3 张红色圆形是收集目标，其余是干扰项
T3_TARGET = ("a9f31.png", "k2x87.png", "m5q02.png")      # 红色圆形 ×3（尺寸/偏移各异 → 字节不同）
T3_DECOYS = {  # 干扰项：文件名 → (形状, 颜色名)
    "b4t66.png": ("square", "blue"),
    "p8n14.png": ("triangle", "green"),
    "w1z55.png": ("rect", "yellow"),
}
T3_ALL = T3_TARGET + tuple(T3_DECOYS)

# T5：乱命名源文件（空格/中文/大小写混杂），内容为各不相同的小色块 PNG 字节
T5_MESSY = ("IMG_2034 (1).PNG", "final final v2（终稿）.png", "photo  03.Jpg",
            "微信图片_2024.png", "未命名 - 副本.jpg")
T5_MANIFEST = ".t5_manifest.json"  # setup 落盘的原始字节哈希清单（verifier 据此断「内容没被改坏」）


def expected_t5_names(messy=T5_MESSY) -> dict:
    """按任务规则的期望映射：原文件名大小写不敏感字典序升序 → img_001.<扩展名小写>。

    注：Windows 上 Path.iterdir() 的排序是大小写不敏感的；Mac/Linux 是大小写敏感。
    为跨平台一致，任务采用大小写不敏感字典序，agent 与 verifier 均以此为锚。
    """
    out = {}
    for i, name in enumerate(sorted(messy, key=lambda s: s.lower()), 1):
        ext = name.rsplit(".", 1)[-1].lower()
        out[name] = f"img_{i:03d}.{ext}"
    return out


# ── 像素级合成（纯标准库） ────────────────────────────────────────────

def _canvas(w, h, color):
    px = bytearray(w * h * 4)
    r, g, b = color
    px[0::4] = bytes([r]) * (w * h)
    px[1::4] = bytes([g]) * (w * h)
    px[2::4] = bytes([b]) * (w * h)
    px[3::4] = b"\xff" * (w * h)
    return px


def _fill(px, w, h, x0, y0, x1, y1, color):
    r, g, b, *_ = (*color, 255)
    for y in range(max(0, y0), min(h, y1)):
        base = y * w * 4
        for x in range(max(0, x0), min(w, x1)):
            i = base + x * 4
            px[i:i + 4] = bytes((r, g, b, 255))


def _fill_circle(px, w, h, cx, cy, r, color):
    rr = r * r
    for y in range(max(0, cy - r), min(h, cy + r + 1)):
        dy = y - cy
        span = int((rr - dy * dy) ** 0.5)
        _fill(px, w, h, cx - span, y, cx + span + 1, y + 1, color)


def _fill_triangle(px, w, h, cx, top, bottom, half, color):
    for y in range(max(0, top), min(h, bottom)):
        t = (y - top) / max(1, bottom - top)
        span = int(half * t)
        _fill(px, w, h, cx - span, y, cx + span + 1, y + 1, color)


def shape_png(shape: str, color_name: str, size: int = 240, offset=(0, 0), scale: float = 1.0) -> bytes:
    """白底 + 居中（可偏移/缩放）彩色形状 → PNG 字节。形状：circle/square/triangle/rect。"""
    w = h = size
    px = _canvas(w, h, (250, 250, 250))
    color = PALETTE[color_name]
    ox, oy = offset
    cx, cy = w // 2 + ox, h // 2 + oy
    r = int(w * 0.32 * scale)
    if shape == "circle":
        _fill_circle(px, w, h, cx, cy, r, color)
    elif shape == "square":
        _fill(px, w, h, cx - r, cy - r, cx + r, cy + r, color)
    elif shape == "triangle":
        _fill_triangle(px, w, h, cx, cy - r, cy + r, int(r * 1.2), color)
    elif shape == "rect":
        _fill(px, w, h, cx - int(r * 1.4), cy - int(r * 0.7), cx + int(r * 1.4), cy + int(r * 0.7), color)
    else:
        raise ValueError(f"未知形状：{shape}")
    return imaging.encode_png(w, h, bytes(px))


def labeled_color_png(color_name: str, digit: str, size: int = 240) -> bytes:
    """纯色底 + 中央大号白色数字标签（T1：模型 read_image 一眼可读）。"""
    px = _canvas(size, size, PALETTE[color_name])
    imaging.draw_label(px, size, size, size // 2 - 30, size // 2 - 40, digit,
                       fg=(255, 255, 255, 255), bg=(*PALETTE[color_name], 255), scale=16, pad=2)
    return imaging.encode_png(size, size, bytes(px))


# ── 视频（ffmpeg） ───────────────────────────────────────────────────

def make_segmented_video(out: Path, runner=None) -> Path:
    """10 秒分段变色 fixture：前 5s 红、后 5s 蓝（320x240@10fps）。ffmpeg 缺失/失败 → RuntimeError。"""
    run = runner or (lambda cmd: subprocess.run(cmd, capture_output=True, text=True, timeout=120))
    if runner is None and not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg 不在 PATH，造不了视频 fixture")
    base = ["ffmpeg", "-y",
            "-f", "lavfi", "-i", "color=red:duration=5:size=320x240:rate=10",
            "-f", "lavfi", "-i", "color=blue:duration=5:size=320x240:rate=10",
            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
            "-pix_fmt", "yuv420p"]
    for codec in ("libx264", "mpeg4"):  # 精简构建无 libx264 时退回 mpeg4
        proc = run(base + ["-c:v", codec, str(out)])
        if proc.returncode == 0:
            return out
    raise RuntimeError(f"ffmpeg 生成视频失败：{getattr(proc, 'stderr', '')[-300:]}")


# ── 任务级 setup：往 workdir 里落一套 fixtures ───────────────────────

def setup_t1(workdir: Path) -> None:
    d = workdir / "imgs"
    d.mkdir(parents=True, exist_ok=True)
    for name, color, digit in T1_SPECS:
        (d / name).write_bytes(labeled_color_png(color, digit))


def setup_t2(workdir: Path) -> None:
    a, b = workdir / "A", workdir / "B"
    a.mkdir(parents=True, exist_ok=True)
    b.mkdir(parents=True, exist_ok=True)
    for (a_name, shape, color), b_name in zip(T2_SHAPES, T2_B_NAMES):
        (a / a_name).write_bytes(shape_png(shape, color))
        (b / b_name).write_bytes(shape_png(shape, color, size=200, offset=(15, 10), scale=0.9))


def setup_t3(workdir: Path) -> None:
    d = workdir / "pool"
    d.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(T3_TARGET):
        (d / name).write_bytes(shape_png("circle", "red", size=220 + i * 20, offset=(i * 8, -i * 6)))
    for name, (shape, color) in T3_DECOYS.items():
        (d / name).write_bytes(shape_png(shape, color))


def setup_t4(workdir: Path) -> None:
    make_segmented_video(workdir / "src.mp4")


def setup_t5(workdir: Path) -> None:
    d = workdir / "files"
    d.mkdir(parents=True, exist_ok=True)
    hashes = {}
    colors = list(PALETTE.values()) + [(120, 60, 200)]
    for name, color in zip(T5_MESSY, colors):
        data = imaging.encode_png(64, 64, bytes(_canvas(64, 64, color)))
        (d / name).write_bytes(data)
        hashes[name] = hashlib.sha256(data).hexdigest()
    (workdir / T5_MANIFEST).write_text(
        json.dumps({"sha256": hashes, "expected": expected_t5_names()}, ensure_ascii=False, indent=1),
        encoding="utf-8")


SETUPS = {"T1": setup_t1, "T2": setup_t2, "T3": setup_t3, "T4": setup_t4, "T5": setup_t5}


def main(argv=None) -> int:
    out = Path((argv or sys.argv[1:] or [".state/d3/fixtures-preview"])[0])
    for key, fn in SETUPS.items():
        try:
            fn(out / key)
            print(f"[ok] {key} → {out / key}")
        except RuntimeError as e:
            print(f"[skip] {key}：{e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
