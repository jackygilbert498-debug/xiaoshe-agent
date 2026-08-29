"""在 PNG 里设计小蛇方印(透明底 RGBA)：修正长宽比 + 三块之间加横缝。
输出 seal_design.png 供我看 + preview.html 供用户在暗/亮底上看。纯标准库。"""
import zlib, struct, base64

BAND0 = [".##################.", "######........######"]
BAND1 = ["##.######..######.##", "#..######..######..#"]
BAND2 = ["######........######", ".##################."]
BANDS = [BAND0, BAND1, BAND2]

CW, CH = 6, 12          # 子像素 宽:高 = 1:2，修正被拉扁
SEAM = 8                # 三块之间的横缝(透明)高度
GREEN = (85, 215, 125, 255)
CLEAR = (0, 0, 0, 0)    # 透明

def band_pixels(band):
    w = max(len(r) for r in band)
    rows = [r.ljust(w) for r in band]
    out = []
    for line in rows:
        big = []
        for c in line:
            big += [GREEN if c == "#" else CLEAR] * CW
        for _ in range(CH):
            out.append(list(big))
    return out, w * CW

def build():
    parts, width = [], 0
    for i, band in enumerate(BANDS):
        px, w = band_pixels(band)
        width = max(width, w)
        parts.append(px)
        if i < len(BANDS) - 1:
            parts.append([[CLEAR] * w for _ in range(SEAM)])
    img = []
    for p in parts:
        for row in p:
            img.append(row + [CLEAR] * (width - len(row)))
    return img

def write_png(path, img):
    h = len(img); w = len(img[0]); raw = bytearray()
    for row in img:
        raw.append(0)
        for (r, g, b, a) in row: raw += bytes((r, g, b, a))
    def ch(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)   # 6 = RGBA
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", ihdr)
                           + ch(b"IDAT", zlib.compress(bytes(raw), 9)) + ch(b"IEND", b""))

def write_html(png_path, html_path):
    b64 = base64.b64encode(open(png_path, "rb").read()).decode()
    img = f"data:image/png;base64,{b64}"
    box = ("display:flex;align-items:center;gap:22px;padding:26px 30px;border-radius:10px;"
           "font-family:'Cascadia Mono',Consolas,monospace")
    def panel(bg, title, tcol, sub):
        return (f"<div style='{box};background:{bg}'>"
                f"<img src='{img}' style='image-rendering:pixelated;height:96px'>"
                f"<div><div style='color:{tcol};font-weight:700;font-size:22px'>小蛇</div>"
                f"<div style='color:{sub}'>养在终端里的一条 AI 小蛇</div>"
                f"<div style='color:{sub};opacity:.7'>v0.1</div></div></div>")
    html = ("<title>小蛇方印·PNG设计稿</title>"
            "<div style='background:#0d0f13;min-height:100%;padding:40px;display:flex;"
            "flex-direction:column;gap:24px;align-items:flex-start'>"
            "<div style='color:#7ee08a;font-family:sans-serif;font-size:14px'>透明底 PNG · 暗底终端里的样子：</div>"
            + panel("#14161b", "小蛇", "#7ee08a", "#8a8f98")
            + "<div style='color:#7ee08a;font-family:sans-serif;font-size:14px;margin-top:8px'>同一张图 · 亮底终端里的样子（透明底自动融，不露方框）：</div>"
            + panel("#f3f3ee", "小蛇", "#2b8a4a", "#666")
            + "<div style='color:#6b7078;font-family:sans-serif;font-size:13px;margin-top:8px'>放大看单张（像素级）：</div>"
            f"<div style='background:#14161b;padding:24px;border-radius:10px'><img src='{img}' style='image-rendering:pixelated;height:200px'></div>"
            "</div>")
    open(html_path, "w", encoding="utf-8").write(html)

if __name__ == "__main__":
    img = build()
    write_png("seal_design.png", img)
    write_html("seal_design.png", "seal_preview.html")
    print("wrote %dx%d" % (len(img[0]), len(img)))
