"""D3 确定性 verifier：xlsx 解析、颜色分类、ffprobe 时长、manifest 字节校验。

全是纯函数/可注入 runner 的形态，离线单测不碰真 Kimi、不碰网络（ffmpeg/ffprobe 仅 T4 用，可注入假 runner）。
xlsx = zip + XML，标准库 zipfile + xml.etree 即可校验，无需 openpyxl。
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import subprocess
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from harness import imaging
from . import make_fixtures as fx


# ── 图像：平均色 + 最近原型分类 ───────────────────────────────────────

def avg_color(png_bytes: bytes) -> tuple:
    """PNG 字节 → 主体平均 RGB（忽略近白背景/白字像素；抽样封顶 4 万像素）。坏图 → ValueError。"""
    w, h, px = imaging.decode_png(png_bytes)
    n = w * h
    step = max(1, n // 40000)
    r = g = b = cnt = 0
    for i in range(0, n, step):
        o = i * 4
        if px[o] > 235 and px[o + 1] > 235 and px[o + 2] > 235:
            continue  # 白底/白标签不计入，主体色才决定分类
        r += px[o]; g += px[o + 1]; b += px[o + 2]; cnt += 1
    if not cnt:  # 全白图兜底：按全量平均（分类自然落 other）
        return avg_color_all(px, n, step)
    return (r // cnt, g // cnt, b // cnt)


def avg_color_all(px, n, step) -> tuple:
    r = g = b = cnt = 0
    for i in range(0, n, step):
        o = i * 4
        r += px[o]; g += px[o + 1]; b += px[o + 2]; cnt += 1
    return (r // cnt, g // cnt, b // cnt)


def classify(rgb: tuple) -> str:
    """RGB → 最近 PALETTE 原型名（red/blue/green/yellow）；离最近原型都 >120 判 other（诚实口径）。"""
    best, dist = min(fx.PALETTE.items(),
                     key=lambda kv: math.dist(rgb, kv[1]))
    return best if math.dist(rgb, dist) <= 120 else "other"


# ── xlsx：zip + XML 纯标准库读取 ──────────────────────────────────────

def _col_index(cell_ref: str) -> int:
    """'B12' → 1（A=0）。取不到列字母 → 0。"""
    m = re.match(r"([A-Za-z]+)", cell_ref or "")
    if not m:
        return 0
    n = 0
    for ch in m.group(1).upper():
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n - 1


def _tag(el) -> str:
    return el.tag.rsplit("}", 1)[-1]  # 剥命名空间，兼容有无 ns 前缀两种写法


def read_xlsx(path: Path) -> list:
    """读 xlsx 第一张表 → 行列表（每行 = 字符串单元格列表，按列号对齐补空）。
    支持 sharedStrings / inlineStr / 数字直写三种单元格。不是合法 xlsx → ValueError。"""
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as e:
        raise ValueError(f"不是合法 xlsx（zip 打不开）：{e}") from e
    with zf:
        names = set(zf.namelist())
        shared = []
        if "xl/sharedStrings.xml" in names:
            for si in ET.fromstring(zf.read("xl/sharedStrings.xml")):
                shared.append("".join(t.text or "" for t in si.iter() if _tag(t) == "t"))
        sheets = sorted(n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
        if not sheets:
            raise ValueError("xlsx 里没有工作表（xl/worksheets/sheetN.xml 缺失）")
        rows = []
        for row in ET.fromstring(zf.read(sheets[0])).iter():
            if _tag(row) != "row":
                continue
            vals = []
            for c in row:
                if _tag(c) != "c":
                    continue
                idx = _col_index(c.get("r", ""))
                while len(vals) < idx:
                    vals.append("")
                t, v, inline = c.get("t"), None, None
                for child in c:
                    if _tag(child) == "v":
                        v = child.text
                    elif _tag(child) == "is":
                        inline = "".join(x.text or "" for x in child.iter() if _tag(x) == "t")
                if t == "s" and v is not None:
                    vals.append(shared[int(v)] if int(v) < len(shared) else "")
                elif t == "inlineStr":
                    vals.append(inline or "")
                elif v is not None:
                    vals.append(v)
                elif inline is not None:
                    vals.append(inline)
                else:
                    vals.append("")
            rows.append(vals)
        return rows


# ── ffprobe/ffmpeg（runner 可注入，测试不碰真进程） ──────────────────

def probe_duration(video: Path, runner=None) -> float:
    """ffprobe 读容器时长（秒）。读不出 → ValueError。"""
    run = runner or (lambda cmd: subprocess.run(cmd, capture_output=True, text=True, timeout=60))
    if runner is None and not shutil.which("ffprobe"):
        raise ValueError("ffprobe 不在 PATH")
    proc = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(video)])
    if proc.returncode != 0:
        raise ValueError(f"ffprobe 失败：{(proc.stderr or '')[-200:]}")
    try:
        return float((proc.stdout or "").strip())
    except ValueError:
        raise ValueError(f"ffprobe 时长解析失败：{(proc.stdout or '')[:100]!r}") from None


def grab_frame(video: Path, at: float, out_png: Path, runner=None) -> Path:
    """ffmpeg 抽 at 秒处一帧存 PNG（eval 侧验内容用）。失败 → ValueError。"""
    run = runner or (lambda cmd: subprocess.run(cmd, capture_output=True, text=True, timeout=60))
    if runner is None and not shutil.which("ffmpeg"):
        raise ValueError("ffmpeg 不在 PATH")
    proc = run(["ffmpeg", "-y", "-ss", str(at), "-i", str(video),
                "-frames:v", "1", str(out_png)])
    if proc.returncode != 0 or not out_png.is_file():
        raise ValueError(f"ffmpeg 抽帧失败：{(proc.stderr or '')[-200:]}")
    return out_png


# ── 任务级 verify 构件 ────────────────────────────────────────────────

def t1_catalog_rows(workdir: Path) -> list:
    f = workdir / "catalog.xlsx"
    if not f.is_file():
        return []
    try:
        return read_xlsx(f)
    except ValueError:
        return []


def t2_color_match(workdir: Path) -> bool:
    """B/ 里每个文件与同名 A/ 文件颜色分类一致（配对改名改对了）。"""
    a, b = workdir / "A", workdir / "B"
    for name in fx.T2_A_NAMES:
        fa, fb = a / name, b / name
        if not fa.is_file() or not fb.is_file():
            return False
        try:
            if classify(avg_color(fa.read_bytes())) != classify(avg_color(fb.read_bytes())):
                return False
        except ValueError:
            return False
    return True


def t3_collection(workdir: Path) -> tuple:
    """collection/ 与期望目标集比对 → (收全了?, 没多收?)。"""
    d = workdir / "collection"
    got = {p.name for p in d.glob("*.png")} if d.is_dir() else set()
    want = set(fx.T3_TARGET)
    return want <= got, got <= want


def t5_renamed(workdir: Path) -> tuple:
    """照 manifest 断：(新名全就位且字节未被改坏?, 旧名全清干净?)。"""
    mf = workdir / fx.T5_MANIFEST
    d = workdir / "files"
    if not mf.is_file() or not d.is_dir():
        return False, False
    m = json.loads(mf.read_text(encoding="utf-8"))
    ok_content = True
    for orig, new in m["expected"].items():
        p = d / new
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != m["sha256"][orig]:
            ok_content = False
            break
    leftover = set(m["expected"]) & {p.name for p in d.iterdir() if p.is_file()}
    return ok_content, not leftover
