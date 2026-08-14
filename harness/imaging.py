"""跨平台纯标准库像素能力：PNG 解码/编码 + 画框 + 数字标号。

为什么自己写而不用 System.Drawing/CoreGraphics：那两条是 Win/Mac 分叉，SoM 画框/dHash/diff
这类基础像素操作要一份代码两平台通用。只依赖 zlib + struct（都是标准库）。

支持面（够 SoM 用，越界即报错不猜）：8-bit、color_type 2(RGB)/6(RGBA)、非隔行。
截图（System.Drawing / sips 产出）都落在这个面内。解码统一归一化成 RGBA（4 通道）方便画图。
"""
from __future__ import annotations

import struct
import zlib

_SIG = b"\x89PNG\r\n\x1a\n"
_MAX_PIXELS = 50_000_000   # 总像素上限：覆盖任何真机截图（4K≈8MP、8K≈33MP），封巨尺寸内存/Paeth CPU DoS。
                           # 自产截图现状远达不到；一旦 imaging 接不可信图(read_image 网络图/用户图)这是硬闸。

# 3×5 数字位图字体（'1'=亮点）——放大后叠在框角当编号，模型据此回"点几号"
_FONT = {
    "0": ("111", "101", "101", "101", "111"),
    "1": ("010", "110", "010", "010", "111"),
    "2": ("111", "001", "111", "100", "111"),
    "3": ("111", "001", "111", "001", "111"),
    "4": ("101", "101", "111", "001", "001"),
    "5": ("111", "100", "111", "001", "111"),
    "6": ("111", "100", "111", "101", "111"),
    "7": ("111", "001", "010", "010", "010"),
    "8": ("111", "101", "111", "101", "111"),
    "9": ("111", "101", "111", "001", "111"),
}


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def decode_png(data: bytes) -> tuple[int, int, bytearray]:
    """PNG → (width, height, RGBA 像素 bytearray)。**不支持/损坏/恶意一律 ValueError**（契约：调用方只需 catch ValueError）。"""
    try:
        return _decode_png(data)
    except ValueError:
        raise
    except Exception as e:   # MemoryError / struct.error / 其它意外 → 收口成 ValueError，别把上层工具拖崩
        raise ValueError(f"PNG 解码失败：{type(e).__name__}") from e


def _decode_png(data: bytes) -> tuple[int, int, bytearray]:
    if not data[:8] == _SIG:
        raise ValueError("不是 PNG（签名不符）")
    pos = 8
    width = height = 0
    channels = 0
    idat = bytearray()
    seen_ihdr = False
    n = len(data)
    while pos + 8 <= n:
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if len(body) != length:
            raise ValueError("PNG chunk 截断")
        pos += 12 + length  # length(4)+type(4)+data+crc(4)
        if typ == b"IHDR":
            if length != 13:
                raise ValueError("IHDR 长度非法")
            width, height, bit_depth, color_type, comp, filt, interlace = struct.unpack(">IIBBBBB", body)
            if bit_depth != 8:
                raise ValueError(f"仅支持 8-bit（实为 {bit_depth}）")
            if color_type == 2:
                channels = 3
            elif color_type == 6:
                channels = 4
            else:
                raise ValueError(f"仅支持 RGB/RGBA color_type 2/6（实为 {color_type}）")
            if interlace != 0:
                raise ValueError("不支持隔行 PNG")
            if width <= 0 or height <= 0:
                raise ValueError("PNG 尺寸非法")
            if width * height > _MAX_PIXELS:   # 巨尺寸内存/CPU 炸弹：解压/分配前先拦（IHDR 是首块，够早）
                raise ValueError(f"PNG 尺寸超上限（{width}x{height} 像素）")
            seen_ihdr = True
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        # 其它辅助 chunk（tEXt/pHYs…）忽略
    if not seen_ihdr:
        raise ValueError("PNG 缺 IHDR")
    if not idat:
        raise ValueError("PNG 缺 IDAT")
    stride = width * channels
    expected = (stride + 1) * height   # 解压后应有的确切字节数（IHDR 已知）→ 用作解压上限，封解压炸弹
    try:
        dobj = zlib.decompressobj()
        raw = dobj.decompress(bytes(idat), expected + 1)
        if dobj.unconsumed_tail:   # 还有输入没消化=输出被上限截断=解出的比预期多 → 炸弹
            raise ValueError("IDAT 解压超出预期尺寸（疑似解压炸弹）")
        raw += dobj.flush()
    except zlib.error as e:
        raise ValueError(f"PNG 数据解压失败：{e}")

    if len(raw) < (stride + 1) * height:
        raise ValueError("PNG 像素数据不足")
    recon = bytearray()
    prev = bytearray(stride)
    p = 0
    for _ in range(height):
        ft = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ft == 0:
            pass
        elif ft == 1:  # Sub：左邻
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ft == 2:  # Up：上邻
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:  # Average：(左+上)/2
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:  # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                c = prev[i - channels] if i >= channels else 0
                line[i] = (line[i] + _paeth(a, prev[i], c)) & 0xFF
        else:
            raise ValueError(f"未知 PNG filter 类型 {ft}")
        recon += line
        prev = line

    if channels == 4:
        return width, height, recon
    # RGB → RGBA（补 alpha=255）
    rgba = bytearray(width * height * 4)
    for i in range(width * height):
        rgba[i * 4] = recon[i * 3]
        rgba[i * 4 + 1] = recon[i * 3 + 1]
        rgba[i * 4 + 2] = recon[i * 3 + 2]
        rgba[i * 4 + 3] = 255
    return width, height, rgba


def _chunk(typ: bytes, body: bytes) -> bytes:
    return (struct.pack(">I", len(body)) + typ + body
            + struct.pack(">I", zlib.crc32(typ + body) & 0xFFFFFFFF))


def encode_png(width: int, height: int, rgba: bytes) -> bytes:
    """RGBA 像素 → PNG 字节（filter 0，color_type 6）。"""
    if len(rgba) != width * height * 4:
        raise ValueError("rgba 长度与尺寸不符")
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter None
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (_SIG + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(bytes(raw)))
            + _chunk(b"IEND", b""))


def _put(px: bytearray, w: int, h: int, x: int, y: int, color) -> None:
    if 0 <= x < w and 0 <= y < h:
        i = (y * w + x) * 4
        px[i:i + 4] = bytes(color)


def draw_rect(px: bytearray, w: int, h: int, x: int, y: int, bw: int, bh: int,
              color=(255, 0, 0, 255), thickness: int = 2) -> None:
    """在 px 上画矩形描边（只描边不填充）。越界自动裁剪、不崩。"""
    if bw <= 0 or bh <= 0:
        return
    for t in range(max(1, thickness)):
        if t >= bh or t >= bw:
            break
        for xx in range(x, x + bw):
            _put(px, w, h, xx, y + t, color)
            _put(px, w, h, xx, y + bh - 1 - t, color)
        for yy in range(y, y + bh):
            _put(px, w, h, x + t, yy, color)
            _put(px, w, h, x + bw - 1 - t, yy, color)


def draw_label(px: bytearray, w: int, h: int, x: int, y: int, text: str,
               fg=(255, 255, 0, 255), bg=(0, 0, 0, 255), scale: int = 3, pad: int = 1) -> None:
    """在 (x,y) 画一块带底色的数字标签（模型据此读编号）。越界裁剪、不崩。"""
    text = str(text)
    scale = max(1, scale)
    dw, dh, sp, p = 3 * scale, 5 * scale, scale, pad * scale
    total_w = len(text) * dw + max(0, len(text) - 1) * sp + 2 * p
    total_h = dh + 2 * p
    for yy in range(y, y + total_h):        # 底色块
        for xx in range(x, x + total_w):
            _put(px, w, h, xx, yy, bg)
    cx = x + p
    for ch in text:
        pat = _FONT.get(ch)
        if pat:
            for ry in range(5):
                for rx in range(3):
                    if pat[ry][rx] == "1":
                        for sy in range(scale):
                            for sx in range(scale):
                                _put(px, w, h, cx + rx * scale + sx, y + p + ry * scale + sy, fg)
        cx += dw + sp


# ---- dHash 感知哈希：把截图折成整体布局指纹，比"上次渲染变没变"（省一次视觉调用/逮静默失败）----

_CELL_SAMPLES = 8   # 每格每轴最多采样点：把 dHash 的 CPU 封在 ~(size+1)*size*64 次，任截图尺寸都恒定快


def _downscale_gray(w: int, h: int, rgba, tw: int, th: int) -> list:
    """把 RGBA 像素降采样成 tw×th 的灰度格子（每格取覆盖源区域的亮度均值，大格子做子采样封 CPU）。
    源比目标小也稳（空区域回落最近单像素、不除零），返回长度 tw*th 的 int 列表（0–255）。"""
    out = [0] * (tw * th)
    for ty in range(th):
        y0 = ty * h // th
        y1 = max(y0 + 1, (ty + 1) * h // th)
        ystep = max(1, (y1 - y0) // _CELL_SAMPLES)
        for tx in range(tw):
            x0 = tx * w // tw
            x1 = max(x0 + 1, (tx + 1) * w // tw)
            xstep = max(1, (x1 - x0) // _CELL_SAMPLES)
            s = cnt = 0
            yy = y0
            while yy < y1 and yy < h:
                base = yy * w * 4
                xx = x0
                while xx < x1 and xx < w:
                    i = base + xx * 4
                    s += (299 * rgba[i] + 587 * rgba[i + 1] + 114 * rgba[i + 2]) // 1000  # 亮度整数近似
                    cnt += 1
                    xx += xstep
                yy += ystep
            out[ty * tw + tx] = s // cnt if cnt else 0
    return out


def _dhash_bits(gray, size: int) -> int:
    """(size+1)×size 灰度格子 → size*size 位 dHash（相邻格「左比右」）。"""
    bits = 0
    for row in range(size):
        base = row * (size + 1)
        for col in range(size):
            bits = (bits << 1) | (1 if gray[base + col] > gray[base + col + 1] else 0)
    return bits


def dhash(png: bytes, size: int = 8) -> int:
    """PNG → size*size 位差异感知哈希（缩到 (size+1)×size 灰度、相邻格「左比右」）。
    整体布局指纹：大改必变、局部小字微调可能不变（粗哈希）；均匀色块恒为 0（只看梯度不看绝对亮度）。
    坏/不支持的 PNG → ValueError（沿用 decode_png 契约，调用方只 catch ValueError）。"""
    w, h, px = decode_png(png)
    gray = _downscale_gray(w, h, px, size + 1, size)
    return _dhash_bits(gray, size)


def region_hashes(png: bytes, nx: int = 4, ny: int = 4, size: int = 8) -> list:
    """§4.5.2 区域化比对像素腿：整图切 nx×ny 网格，逐格算 size*size 位 dHash，
    按行主序返回 nx*ny 个 int——把「像不像」降解成「哪个区域变了/差多少」。
    与整图 dHash 同特性：只看梯度不看绝对亮度、均匀格恒 0；两图尺寸不同也可比（各自归一化）。
    坏 PNG / 网格参数非法 / 图比网格还小 → ValueError（同 decode_png 契约）。"""
    if not isinstance(nx, int) or not isinstance(ny, int) or isinstance(nx, bool) or isinstance(ny, bool) or nx < 1 or ny < 1:
        raise ValueError(f"网格参数非法（nx={nx!r}, ny={ny!r}）")
    w, h, px = decode_png(png)
    if w < nx or h < ny:
        raise ValueError(f"图 {w}x{h} 比网格 {nx}x{ny} 还小，分不了区")
    out = []
    for ry in range(ny):
        for rx in range(nx):
            x0, y0 = rx * w // nx, ry * h // ny
            x1, y1 = (rx + 1) * w // nx, (ry + 1) * h // ny
            _nw, _nh, sub = crop(w, h, px, (x0, y0, x1 - x0, y1 - y0))
            gray = _downscale_gray(_nw, _nh, sub, size + 1, size)
            out.append(_dhash_bits(gray, size))
    return out


def hamming(a: int, b: int) -> int:
    """两个 dHash 的汉明距离（不同位数）——越小越像，0=逐格一致。"""
    return bin(a ^ b).count("1")


# ---- 裁剪/整数倍放大：统一「裁剪-重问」子系统（zoom）的像素腿 ----
# spec：docs/superpowers/specs/2026-07-19-统一裁剪重问子系统-design.md §组件 2。


def _check_rgba(w: int, h: int, rgba) -> None:
    if w <= 0 or h <= 0:
        raise ValueError(f"尺寸非法（{w}x{h}）")
    if len(rgba) != w * h * 4:
        raise ValueError("rgba 长度与尺寸不符")


def crop(w: int, h: int, rgba, region) -> tuple[int, int, bytearray]:
    """按 region=(x,y,rw,rh) 从 RGBA 图裁一块，返回 (nw, nh, 新 rgba)。
    越界 clamp 到图内；完全不相交或 clamp 后尺寸 ≤0 → ValueError。"""
    _check_rgba(w, h, rgba)
    x, y, rw, rh = (int(v) for v in region)
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(w, x + rw), min(h, y + rh)
    nw, nh = x1 - x0, y1 - y0
    if nw <= 0 or nh <= 0:
        raise ValueError(f"裁剪区域与图不相交（region={tuple(region)}，图 {w}x{h}）")
    out = bytearray(nw * nh * 4)
    src_stride, dst_stride = w * 4, nw * 4
    for yy in range(nh):
        s = ((y0 + yy) * w + x0) * 4
        out[yy * dst_stride:(yy + 1) * dst_stride] = rgba[s:s + dst_stride]
    return nw, nh, out


def upscale(w: int, h: int, rgba, k: int) -> tuple[int, int, bytearray]:
    """整数倍最近邻放大（k∈{2,3}，把 ~40px 目标抬到 ≥80px 供 OCR/模型看清）。
    k 非法 → ValueError；放大后总像素超 _MAX_PIXELS(50M) → ValueError（与 PDF 路径同值同理由，
    且在任何大分配前先拦——同 decode_png 在 IHDR 处拦巨尺寸的思路）。"""
    if k not in (2, 3) or not isinstance(k, int):
        raise ValueError(f"放大倍数仅支持 2/3（实为 {k!r}）")
    if w <= 0 or h <= 0:
        raise ValueError(f"尺寸非法（{w}x{h}）")
    if (w * k) * (h * k) > _MAX_PIXELS:
        raise ValueError(f"放大后尺寸超上限（{w * k}x{h * k} 像素）")
    _check_rgba(w, h, rgba)
    nw, nh = w * k, h * k
    out = bytearray(nw * nh * 4)
    src_stride, dst_stride = w * 4, nw * 4
    for yy in range(h):
        # 先放大一行（每像素横向重复 k 次），再纵向重复 k 行
        row = bytearray(dst_stride)
        for xx in range(w):
            px4 = rgba[(yy * w + xx) * 4:(yy * w + xx) * 4 + 4]
            for kk in range(k):
                row[(xx * k + kk) * 4:(xx * k + kk) * 4 + 4] = px4
        for kk in range(k):
            d = (yy * k + kk) * dst_stride
            out[d:d + dst_stride] = row
    return nw, nh, out


_INV_TABLE = bytes(255 - i for i in range(256))


def diff_ratio(w1: int, h1: int, rgba1, w2: int, h2: int, rgba2, channel_thresh: int = 32) -> float:
    """两帧同尺寸 RGBA 的像素差分比例：逐像素取 RGB 三通道最大绝对差 ≥ channel_thresh 记为变化像素，
    返回变化像素占比（0.0–1.0）。click 像素差分读回的像素腿（§4.3.2 差分读回，补 click down/up
    选择性丢失「位置读回观测不到」的残余窗口——CONTRACT P4 段已文档化）。
    alpha 忽略（两路截图管线都不含光标：Win CopyFromScreen 不画光标、Mac screencapture 无 -C 不含，
    光标闪烁天然不在帧内）；channel_thresh=32 抗亚像素级渲染抖动；面积阈值留给调用方
    （文本光标闪烁/细动画只占极少数像素）。尺寸不一致/长度不符 → ValueError（同 crop/upscale 契约）。"""
    _check_rgba(w1, h1, rgba1)
    _check_rgba(w2, h2, rgba2)
    if (w1, h1) != (w2, h2):
        raise ValueError(f"两帧尺寸不一致（{w1}x{h1} vs {w2}x{h2}）")
    changed = 0
    n = w1 * h1
    for i in range(n):
        b = i * 4
        if (abs(rgba1[b] - rgba2[b]) >= channel_thresh
                or abs(rgba1[b + 1] - rgba2[b + 1]) >= channel_thresh
                or abs(rgba1[b + 2] - rgba2[b + 2]) >= channel_thresh):
            changed += 1
    return changed / n
def invert(w: int, h: int, rgba) -> bytearray:
    """逐像素反色（RGB 取 255-x，alpha 原样）——OCR 反色补跑的像素腿：白字深底图反成黑字白底再喂
    OCR（2026-07-22 真机探针：Vision 对白-on-深灰孤立字符稳定漏识，反色图能认出；二值化各阈值
    全灭，不做）。几何不变（不缩放不裁剪）：反色图 OCR 出的词框坐标可直接并回原坐标系。
    尺寸非法/长度不符 → ValueError（同 crop/upscale 契约）。"""
    _check_rgba(w, h, rgba)
    out = bytearray(rgba)
    for c in range(3):
        out[c::4] = bytes(out[c::4]).translate(_INV_TABLE)
    return out


def draw_marks(png: bytes, marks, box_color=(255, 40, 40, 255), thickness: int = 3,
               label_fg=(255, 255, 0, 255), label_bg=(200, 0, 0, 255), scale: int = 3) -> bytes:
    """SoM 主入口：在截图 PNG 上给每个 mark 画编号框，返回新 PNG。
    marks = [{"box": (x, y, w, h), "label": "1"}, ...]。坐标须已相对本图（截图区域内偏移）。"""
    w, h, px = decode_png(png)
    for m in marks:
        bx, by, bw, bh = (int(v) for v in m["box"])
        draw_rect(px, w, h, bx, by, bw, bh, color=box_color, thickness=thickness)
        label = str(m.get("label", ""))
        if label:
            draw_label(px, w, h, max(0, bx), max(0, by), label, fg=label_fg, bg=label_bg, scale=scale)
    return encode_png(w, h, bytes(px))
