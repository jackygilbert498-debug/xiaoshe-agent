"""把锁定的「简①」方印按【真实块字符】逐格渲染成 PNG（忠实还原代码块里的清晰样子）。

关键：不再手打 #/. 位图去近似，而是把每个块字符映射到它的四分格填充，
所以图 = 字符本身该有的样子，1:1。透明底（SIXEL 贴图自适应深/浅终端）。
用法: python3 seal_render.py [seam_px]
产出: seal_v2.png（透明·交付候选） + seal_v2_dark.png（深底预览·给我自己看）
"""
import sys
from PIL import Image, ImageDraw

SEAL = ["▟██▀▀▀▀██▙", "▛▐██▌▐██▌▜", "▜██▄▄▄▄██▛"]
GREEN = (84, 197, 145, 255)      # 蛇绿 #54C591
DARKBG = (14, 26, 22, 255)       # 终端深底，仅预览用

# 每个块字符 → 四分格 (UL, UR, LL, LR) 是否填充
Q = {
    "█": (1, 1, 1, 1), "▀": (1, 1, 0, 0), "▄": (0, 0, 1, 1),
    "▌": (1, 0, 1, 0), "▐": (0, 1, 0, 1),
    "▟": (0, 1, 1, 1), "▛": (1, 1, 1, 0), "▜": (1, 1, 0, 1), "▙": (1, 0, 1, 1),
    " ": (0, 0, 0, 0),
}

SUB = 24                 # 四分格宽(px)；四分格 SUB×2SUB → 单元 2SUB×4SUB = 1:2 终端字元比
CW, CH = SUB * 2, SUB * 4
QW, QH = SUB, SUB * 2


def render(seam: int) -> Image.Image:
    rows = len(SEAL)
    cols = max(len(r) for r in SEAL)
    W = cols * CW
    H = rows * CH + (rows - 1) * seam
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for r, line in enumerate(SEAL):
        y0 = r * (CH + seam)
        for c, ch in enumerate(line):
            ul, ur, ll, lr = Q.get(ch, (0, 0, 0, 0))
            x0 = c * CW
            for on, qx, qy in (
                (ul, x0, y0), (ur, x0 + QW, y0),
                (ll, x0, y0 + QH), (lr, x0 + QW, y0 + QH),
            ):
                if on:
                    d.rectangle([qx, qy, qx + QW - 1, qy + QH - 1], fill=GREEN)
    return img


def on_dark(img):
    d = Image.new("RGBA", img.size, DARKBG)
    d.alpha_composite(img)
    return d


def contact(seams):
    """把几个 seam 值并排贴到一张深底图上，一次看清哪个缝合适。"""
    pad = 40
    imgs = [on_dark(render(s)) for s in seams]
    W = sum(i.width for i in imgs) + pad * (len(imgs) + 1)
    H = max(i.height for i in imgs) + pad * 2
    sheet = Image.new("RGBA", (W, H), (8, 14, 12, 255))
    x = pad
    for s, i in zip(seams, imgs):
        sheet.alpha_composite(i, (x, pad))
        x += i.width + pad
    sheet.save("seal_contact.png")
    print("seams=" + ",".join(map(str, seams)) + "  -> seal_contact.png")


SEAM = 24  # 定稿：三行间横缝，还原代码块 line-height 的缝

CJK = "/System/Library/Fonts/STHeiti Medium.ttc"


def build_preview(seal):
    """把方印图放进欢迎屏抬头（图 + 小蛇/副标题/版本），看它替换代码块后的样子。"""
    from PIL import ImageFont
    title = ImageFont.truetype(CJK, 76)
    sub = ImageFont.truetype(CJK, 34)
    ver = ImageFont.truetype(CJK, 30)
    GREENT = (84, 197, 145, 255)
    DIM = (150, 165, 158, 255)
    gap = 56
    tx = 40 + seal.width + gap
    W = tx + 640
    H = max(seal.height + 80, 360)
    cv = Image.new("RGBA", (W, H), DARKBG)
    cv.alpha_composite(seal, (40, (H - seal.height) // 2))
    d = ImageDraw.Draw(cv)
    cy = (H - (76 + 34 + 30 + 28)) // 2
    d.text((tx, cy), "小蛇", font=title, fill=GREENT)
    d.text((tx, cy + 92), "养在终端里的一条 AI 小蛇", font=sub, fill=DIM)
    d.text((tx, cy + 92 + 46), "v0.1", font=ver, fill=DIM)
    cv.save("welcome_preview.png")
    print("welcome_preview.png  size=" + str(cv.size))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "compare":
        contact([0, 16, 28, 40, 56])
        return
    seam = int(sys.argv[1]) if len(sys.argv) > 1 else SEAM
    img = render(seam)
    img.save("seal_v2.png")
    on_dark(img).save("seal_v2_dark.png")
    build_preview(img)
    print(f"seam={seam}  size={img.size}  -> seal_v2.png / seal_v2_dark.png / welcome_preview.png")


if __name__ == "__main__":
    main()
