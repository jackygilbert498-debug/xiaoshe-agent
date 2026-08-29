"""校验空态蛇形水印关键渐变 stop 的合成对比度。"""
from __future__ import annotations

from collections.abc import Sequence

LIGHT_BG, LIGHT_STOP, LIGHT_ALPHA = "#ffffff", "#4f8069", .10
DARK_BG, DARK_STOP, DARK_ALPHA = "#0f1311", "#dbc788", .06

RGB = tuple[int, int, int]


def hex_rgb(value: str) -> RGB:
    """把六位十六进制颜色转换为整数 RGB。"""
    text = value.removeprefix("#")
    if len(text) != 6:
        raise ValueError(f"expected six-digit hex color: {value!r}")
    try:
        return tuple(int(text[index:index + 2], 16) for index in (0, 2, 4))
    except ValueError as exc:
        raise ValueError(f"invalid hex color: {value!r}") from exc


def _rgb(value: str | Sequence[int]) -> RGB:
    if isinstance(value, str):
        return hex_rgb(value)
    if len(value) != 3:
        raise ValueError("RGB colors require exactly three channels")
    channels = tuple(int(channel) for channel in value)
    if any(channel < 0 or channel > 255 for channel in channels):
        raise ValueError("RGB channels must be between 0 and 255")
    return channels


def composite(background: str | Sequence[int], foreground: str | Sequence[int], alpha: float) -> RGB:
    """按整数通道合成前景到背景。"""
    if not 0 <= alpha <= 1:
        raise ValueError("alpha must be between 0 and 1")
    bg = _rgb(background)
    fg = _rgb(foreground)
    return tuple(round(b * (1 - alpha) + f * alpha) for b, f in zip(bg, fg))


def relative_luminance(color: str | Sequence[int]) -> float:
    """按 WCAG sRGB 线性化公式计算相对亮度。"""
    def linear(channel: int) -> float:
        srgb = channel / 255
        return srgb / 12.92 if srgb <= .04045 else ((srgb + .055) / 1.055) ** 2.4

    red, green, blue = (linear(channel) for channel in _rgb(color))
    return .2126 * red + .7152 * green + .0722 * blue


def contrast(first: str | Sequence[int], second: str | Sequence[int]) -> float:
    """返回两种颜色的 WCAG 对比率。"""
    high, low = sorted((relative_luminance(first), relative_luminance(second)), reverse=True)
    return (high + .05) / (low + .05)


def main() -> int:
    for name, background, foreground, alpha in (
        ("light", LIGHT_BG, LIGHT_STOP, LIGHT_ALPHA),
        ("dark", DARK_BG, DARK_STOP, DARK_ALPHA),
    ):
        ratio = contrast(background, composite(background, foreground, alpha))
        print(f"{name}: {ratio:.3f}:1")
        if not 1.05 <= ratio <= 1.15:
            raise SystemExit(f"{name} watermark contrast out of range: {ratio:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
