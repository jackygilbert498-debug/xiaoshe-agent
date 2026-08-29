"""Integrity checks for the self-contained UX handoff package."""

from __future__ import annotations

import hashlib
import json
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path, PurePosixPath, PureWindowsPath


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = (
    ROOT
    / "docs"
    / "handoff"
    / "专项工作包-2026-08-02-小蛇壳化转型"
)
PACKAGE_RELATIVE = PurePosixPath("docs/handoff/专项工作包-2026-08-02-小蛇壳化转型")
README = PACKAGE / "README.md"
VALIDATION = PACKAGE / "报告工具链" / "kimi-v2-validation.json"
HASHED_MARKDOWN = (
    "交付物/xiaoshe-ux-report-v2.agent.final.md",
    "交付物/xiaoshe-ux-report_ref.md",
)
PORTABILITY_MARKER = re.compile(
    r"<!-- handoff-portability-map:start -->\s*```json\s*(\{.*?\})\s*```\s*"
    r"<!-- handoff-portability-map:end -->",
    re.DOTALL,
)
AGENT_PATH = re.compile(
    r"(?:file:)?(?P<path>/mnt/agents/(?:upload|output)/"
    r"(?:[^`\s|,;\]\)\}）。，；、：<>\"']+)?)"
)


def normalized_agent_paths(report: str) -> set[str]:
    """Return cited temporary paths without optional line-range suffixes."""

    return {
        re.sub(r":\d+(?:-\d+)?$", "", match.group("path"))
        for match in AGENT_PATH.finditer(report)
    }


def portability_mapping(readme: str) -> dict[str, str]:
    """Load the documented mapping contract, rather than guessing path rewrites."""

    match = PORTABILITY_MARKER.search(readme)
    if not match:
        return {}
    payload = json.loads(match.group(1))
    return payload["temporary_reference_map"]


def delivered_markdown_files() -> list[Path]:
    """Enumerate package Markdown without entering the ignored source mirror."""

    paths = []
    for directory, subdirectories, filenames in os.walk(PACKAGE):
        subdirectories[:] = [name for name in subdirectories if name != "对标壳源码"]
        for filename in filenames:
            if filename.endswith(".md"):
                paths.append(Path(directory) / filename)
    return sorted(paths)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def is_relative_posix(path: str) -> bool:
    return not PurePosixPath(path).is_absolute() and not PureWindowsPath(path).is_absolute()


def load_build_module():
    """Load only the tool's path helper while stubbing optional render libraries."""

    stubs = {
        "docx": types.ModuleType("docx"),
        "docx.enum": types.ModuleType("docx.enum"),
        "docx.enum.section": types.ModuleType("docx.enum.section"),
        "docx.enum.style": types.ModuleType("docx.enum.style"),
        "docx.enum.table": types.ModuleType("docx.enum.table"),
        "docx.enum.text": types.ModuleType("docx.enum.text"),
        "docx.oxml": types.ModuleType("docx.oxml"),
        "docx.oxml.ns": types.ModuleType("docx.oxml.ns"),
        "docx.shared": types.ModuleType("docx.shared"),
        "PIL": types.ModuleType("PIL"),
    }
    stubs["docx"].Document = object
    stubs["docx.enum.section"].WD_SECTION = object
    stubs["docx.enum.style"].WD_STYLE_TYPE = object
    stubs["docx.enum.table"].WD_CELL_VERTICAL_ALIGNMENT = object
    stubs["docx.enum.text"].WD_ALIGN_PARAGRAPH = object
    stubs["docx.oxml"].OxmlElement = object
    stubs["docx.oxml.ns"].qn = lambda value: value
    stubs["docx.shared"].Inches = object
    stubs["docx.shared"].Pt = object
    stubs["docx.shared"].RGBColor = object
    stubs["docx.shared"].Twips = object
    stubs["PIL"].Image = object

    previous = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        module_path = PACKAGE / "报告工具链" / "build_kimi_v2.py"
        spec = importlib.util.spec_from_file_location("handoff_build_for_test", module_path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        previous_build_module = sys.modules.get(spec.name)
        sys.modules[spec.name] = module
        try:
            spec.loader.exec_module(module)
            return module
        finally:
            if previous_build_module is None:
                del sys.modules[spec.name]
            else:
                sys.modules[spec.name] = previous_build_module
    finally:
        for name, original in previous.items():
            if original is None:
                del sys.modules[name]
            else:
                sys.modules[name] = original


class HandoffPackagePortabilityTests(unittest.TestCase):
    def test_every_delivered_markdown_temporary_reference_has_a_packaged_target(self) -> None:
        cited = set()
        for markdown in delivered_markdown_files():
            text = markdown.read_text(encoding="utf-8")
            if markdown == README:
                text = PORTABILITY_MARKER.sub("", text)
            cited.update(normalized_agent_paths(text))

        mapping = portability_mapping(README.read_text(encoding="utf-8"))

        self.assertSetEqual(cited, set(mapping), "all delivered Markdown references need a complete mapping")
        for original, relative_target in mapping.items():
            with self.subTest(original=original):
                self.assertTrue(is_relative_posix(relative_target))
                target = PACKAGE / PurePosixPath(relative_target)
                self.assertTrue(target.exists(), f"mapped package target is missing: {relative_target}")

    def test_hashed_markdown_survives_windows_autocrlf_clone(self) -> None:
        documented = {
            filename: digest
            for digest, filename in re.findall(
                r"(?m)^([0-9a-f]{64})\s+(\S+\.md)$",
                README.read_text(encoding="utf-8"),
            )
        }
        self.assertSetEqual(set(documented), {PurePosixPath(path).name for path in HASHED_MARKDOWN})
        for relative in HASHED_MARKDOWN:
            artifact = PACKAGE / PurePosixPath(relative)
            self.assertEqual(sha256(artifact), documented[artifact.name])

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            checkout = Path(temporary) / "checkout"
            source.mkdir()
            shutil.copyfile(ROOT / ".gitattributes", source / ".gitattributes")
            (source / "unrelated.md").write_bytes(b"unrelated\n")
            for relative in HASHED_MARKDOWN:
                destination = source / PACKAGE_RELATIVE / PurePosixPath(relative)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(PACKAGE / PurePosixPath(relative), destination)

            subprocess.run(["git", "init", "--quiet"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
            subprocess.run(["git", "config", "core.autocrlf", "false"], cwd=source, check=True)
            subprocess.run(["git", "add", "."], cwd=source, check=True)
            subprocess.run(["git", "commit", "--quiet", "-m", "fixture"], cwd=source, check=True)
            subprocess.run(
                ["git", "-c", "core.autocrlf=true", "clone", "--quiet", str(source), str(checkout)],
                check=True,
            )

            for relative in HASHED_MARKDOWN:
                repository_relative = (PACKAGE_RELATIVE / PurePosixPath(relative)).as_posix()
                artifact = checkout / PurePosixPath(repository_relative)
                attribute = subprocess.run(
                    ["git", "check-attr", "eol", "--", repository_relative],
                    cwd=checkout,
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip()
                self.assertTrue(attribute.endswith("eol: lf"), attribute)
                eol_state = subprocess.run(
                    ["git", "ls-files", "--eol", "--", repository_relative],
                    cwd=checkout,
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip()
                self.assertEqual(
                    sha256(artifact),
                    documented[artifact.name],
                    f"{attribute}; {eol_state}",
                )

            unrelated = subprocess.run(
                ["git", "check-attr", "eol", "--", "unrelated.md"],
                cwd=checkout,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            self.assertTrue(unrelated.endswith("eol: unspecified"), unrelated)

    def test_validation_artifacts_use_portable_package_relative_paths(self) -> None:
        validation = json.loads(VALIDATION.read_text(encoding="utf-8"))
        for key in ("final_markdown", "reference_markdown", "docx"):
            with self.subTest(key=key):
                relative_target = validation[key]
                self.assertTrue(is_relative_posix(relative_target))
                self.assertTrue((PACKAGE / PurePosixPath(relative_target)).is_file())

    def test_build_path_formatter_is_stable_when_package_root_changes(self) -> None:
        build = load_build_module()
        self.assertTrue(
            hasattr(build, "package_relative"),
            "build tool must expose a package-relative path formatter",
        )
        expected = "交付物/xiaoshe-ux-report-v2.agent.final.md"
        with tempfile.TemporaryDirectory() as temporary:
            first_root = Path(temporary) / "first-package"
            second_root = Path(temporary) / "second-package"
            self.assertEqual(
                build.package_relative(first_root / PurePosixPath(expected), first_root),
                expected,
            )
            self.assertEqual(
                build.package_relative(second_root / PurePosixPath(expected), second_root),
                expected,
            )


if __name__ == "__main__":
    unittest.main()
