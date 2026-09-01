#!/usr/bin/env python3
"""Run the complete History Skill test suite without environment setup.

The package lives under ``scripts/`` instead of being installed into the active
Python environment.  This entry point makes that layout explicit so a copied
Skill can be verified from any current working directory and path spelling.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
TESTS_ROOT = SKILL_ROOT / "tests"


def main() -> int:
    """Discover and run every ``test_*.py`` module; return a shell exit code."""

    scripts_root = str(SKILL_ROOT / "scripts")
    if scripts_root not in sys.path:
        sys.path.insert(0, scripts_root)

    suite = unittest.defaultTestLoader.discover(
        start_dir=str(TESTS_ROOT),
        pattern="test_*.py",
    )
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
