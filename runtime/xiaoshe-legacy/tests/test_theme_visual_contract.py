from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TOKENS = ROOT / "ui" / "styles" / "tokens.css"
BASE = ROOT / "ui" / "styles" / "base.css"
PANELS = ROOT / "ui" / "styles" / "panels.css"
INDEX = ROOT / "ui" / "index.html"


def _block(css: str, selector: str) -> str:
    match = re.search(rf"{re.escape(selector)}\s*\{{(?P<body>.*?)\}}", css, re.S)
    if not match:
        raise AssertionError(f"missing CSS block: {selector}")
    return match.group("body")


def _declarations(css: str, selector: str) -> dict[str, str]:
    body = _block(css, selector)
    return {
        name.strip(): value.strip()
        for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", body)
    }


def _properties(css: str, selector: str) -> dict[str, str]:
    body = _block(css, selector)
    return {
        name.strip(): value.strip()
        for name, value in re.findall(r"([\w-]+)\s*:\s*([^;]+);", body)
    }


def _rgb(value: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"#([0-9a-fA-F]{6})", value.strip())
    if not match:
        raise AssertionError(f"expected six-digit hex color, got {value!r}")
    text = match.group(1)
    return tuple(int(text[index : index + 2], 16) for index in (0, 2, 4))


def _luminance(value: str) -> float:
    def linear(channel: int) -> float:
        srgb = channel / 255
        return srgb / 12.92 if srgb <= 0.04045 else ((srgb + 0.055) / 1.055) ** 2.4

    red, green, blue = (linear(channel) for channel in _rgb(value))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def _contrast(first: str, second: str) -> float:
    high, low = sorted((_luminance(first), _luminance(second)), reverse=True)
    return (high + 0.05) / (low + 0.05)


class ThemeVisualContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tokens = TOKENS.read_text(encoding="utf-8")
        cls.light = _declarations(cls.tokens, ":root")
        cls.dark = _declarations(cls.tokens, '[data-theme="ink-jade"]')

    def test_light_large_surfaces_are_clean_neutral_whites(self) -> None:
        for token in ("--p-bg", "--p-rail", "--p-stage", "--p-card"):
            channels = _rgb(self.light[token])
            self.assertGreaterEqual(min(channels), 248, token)
            self.assertLessEqual(max(channels) - min(channels), 3, token)

    def test_primary_controls_are_neutral_not_yellow_or_bright_green(self) -> None:
        light_cta = _rgb(self.light["--p-cream"])
        dark_cta = _rgb(self.dark["--p-cream"])
        self.assertLessEqual(max(light_cta) - min(light_cta), 6)
        self.assertLess(_luminance(self.light["--p-cream"]), 0.05)
        self.assertLessEqual(max(dark_cta) - min(dark_cta), 6)
        self.assertGreater(_luminance(self.dark["--p-cream"]), 0.65)

    def test_dark_stage_is_ink_jade_not_dead_black(self) -> None:
        stage = _rgb(self.dark["--p-stage"])
        self.assertGreater(min(stage), 8)
        self.assertLess(max(stage), 28)
        self.assertGreater(stage[1], stage[0])
        self.assertGreater(stage[1], stage[2])
        self.assertLessEqual(max(stage) - min(stage), 6)

    def test_body_copy_keeps_strong_contrast_in_both_themes(self) -> None:
        self.assertGreaterEqual(_contrast(self.light["--p-ink"], self.light["--p-stage"]), 7.0)
        self.assertGreaterEqual(_contrast(self.dark["--p-ink"], self.dark["--p-stage"]), 7.0)

    def test_brand_sheen_is_restrained_jade_with_a_champagne_stop(self) -> None:
        for palette in (self.light, self.dark):
            jade = _rgb(palette["--sheen-2"])
            champagne = _rgb(palette["--sheen-4"])
            self.assertGreater(jade[1], jade[0])
            self.assertGreater(jade[1], jade[2])
            self.assertGreater(champagne[0], champagne[2])
            self.assertGreater(champagne[1], champagne[2])
            self.assertLessEqual(max(jade) - min(jade), 78)

    def test_metallic_sheen_is_limited_to_wordmark_watermark_and_logo(self) -> None:
        base = BASE.read_text(encoding="utf-8")
        sheen_users = set(re.findall(r"([^{}]+)\{[^{}]*var\(--sheen-[1-4]\)", base, re.S))
        selectors = " ".join(" ".join(item.split()) for item in sheen_users)
        self.assertIn(".stage-word", selectors)
        self.assertIn(".stage-wm", selectors)
        self.assertNotRegex(selectors, r"theme-toggle|tab|send|mini-btn")
        index = INDEX.read_text(encoding="utf-8")
        self.assertIn('id="brand-sheen"', index)
        self.assertIn('stroke="url(#brand-sheen)"', index)
        for token in ("--sheen-1", "--sheen-2", "--sheen-3", "--sheen-4"):
            self.assertIn(f'stop-color="var({token})"', index)

    def test_completed_jobs_use_a_quiet_check_ring_instead_of_a_solid_dot(self) -> None:
        panels = PANELS.read_text(encoding="utf-8")
        done = _block(panels, ".job-dot.d-done")
        check = _block(panels, ".job-dot.d-done::after")
        self.assertRegex(done, r"background\s*:\s*transparent")
        self.assertRegex(done, r"border\s*:\s*1px\s+solid\s+var\(--ok\)")
        self.assertRegex(check, r"content\s*:\s*[\"']✓[\"']")

    def test_empty_stage_typography_keeps_the_approved_light_hierarchy(self) -> None:
        base = BASE.read_text(encoding="utf-8")
        heading = _properties(base, ".chat-head h1")
        wordmark = _properties(base, ".stage-word")
        self.assertEqual(heading["font-weight"], "500")
        self.assertEqual(heading["font-size"], "clamp(32px, 3vw, 40px)")
        self.assertEqual(wordmark["font-weight"], "500")
        self.assertEqual(wordmark["font-size"], "clamp(72px, 9.8vw, 102px)")
        self.assertEqual(wordmark["letter-spacing"], "-.07em")

    def test_geometric_watermark_is_large_thin_and_layered_around_the_wordmark(self) -> None:
        base = BASE.read_text(encoding="utf-8")
        stage = _properties(base, ".stage-empty")
        ghost = _properties(base, ".stage-ghost")
        foreground = _properties(base, ".stage-empty > :not(.stage-ghost)")
        self.assertEqual(stage["isolation"], "isolate")
        self.assertEqual(
            ghost["left"],
            "calc(50% + clamp(0px, calc(16% - 106px), 112px))",
        )
        self.assertNotIn("right", ghost)
        self.assertEqual(ghost["width"], "min(320px, 48%)")
        self.assertEqual(ghost["height"], "auto")
        self.assertEqual(ghost["aspect-ratio"], "1 / 1")
        self.assertEqual(ghost["z-index"], "0")
        self.assertEqual(foreground["z-index"], "1")
        self.assertEqual(self.light["--ghost-op"], ".075")
        self.assertEqual(self.dark["--ghost-op"], ".055")

    def test_session_selection_and_status_markers_stay_quiet_and_semantic(self) -> None:
        base = BASE.read_text(encoding="utf-8")
        selected = _properties(base, ".sess.on")
        running = _properties(base, ".session-indicator.running")
        unread = _properties(base, ".session-indicator.unread::after")
        self.assertEqual(selected["box-shadow"], "none")
        self.assertIn("session-indicator-spin", running["animation"])
        self.assertEqual(running["border-radius"], "50%")
        self.assertEqual(unread["border-radius"], "50%")

    def test_task_button_is_hidden_by_an_equally_specific_desktop_rule(self) -> None:
        base = BASE.read_text(encoding="utf-8")
        hidden = _properties(base, ".icbtn.task-mobile-toggle")
        self.assertEqual(hidden["display"], "none")
        mobile = re.search(
            r"@media\s*\(max-width:\s*760px\)\s*\{(?P<body>.*)\}\s*$",
            base,
            re.S,
        )
        self.assertIsNotNone(mobile)
        self.assertRegex(
            mobile.group("body"),
            r"\.icbtn\.task-mobile-toggle\s*\{\s*display\s*:\s*inline-flex\s*;",
        )

    def test_phone_composer_reflows_controls_instead_of_overflowing(self) -> None:
        base = BASE.read_text(encoding="utf-8")
        phone = re.search(
            r"@media\s*\(max-width:\s*520px\)\s*\{(?P<body>.*?)\n\}",
            base,
            re.S,
        )
        self.assertIsNotNone(phone)
        body = phone.group("body")
        self.assertRegex(body, r"\.composer\s*\{[^}]*padding\s*:\s*12px")
        self.assertRegex(body, r"\.cbox\s*\{[^}]*flex-wrap\s*:\s*wrap")
        self.assertRegex(body, r"\.cbox\s+textarea\s*\{[^}]*flex-basis\s*:\s*100%")
        self.assertRegex(body, r"\.cbox\s+\.cbtns\s*\{[^}]*width\s*:\s*100%")

    def test_jobs_grid_keeps_long_commands_inside_the_inspector(self) -> None:
        panels = PANELS.read_text(encoding="utf-8")
        stack = _properties(panels, ".jobs-stack")
        toggle = _properties(panels, ".jobs-toggle")
        self.assertEqual(stack["grid-template-columns"], "minmax(0, 1fr)")
        self.assertEqual(toggle["max-width"], "100%")
        self.assertEqual(toggle["box-sizing"], "border-box")


if __name__ == "__main__":
    unittest.main()
