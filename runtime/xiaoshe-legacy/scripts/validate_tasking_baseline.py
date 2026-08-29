"""Tasking G0 基线的稳定校验与快照生成。"""
from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
from pathlib import Path

REQUIRED = ("commit", "dirty_files", "platform", "python", "tests", "contract", "ux_mapping")


def _run(repo_root: Path, *args: str) -> str:
    completed = subprocess.run(args, cwd=repo_root, text=True, encoding="utf-8", errors="strict", capture_output=True, check=True)
    return completed.stdout


def snapshot(repo_root: Path) -> dict:
    from harness.ui_schema import export_contract
    dirty = []
    for line in _run(repo_root, "git", "status", "--porcelain=v1").splitlines():
        if line:
            dirty.append({"status": line[:2], "path": line[3:]})
    return {
        "commit": _run(repo_root, "git", "rev-parse", "HEAD").strip(),
        "dirty_files": dirty,
        "platform": {"system": platform.system(), "release": platform.release()},
        "python": sys.version.split()[0],
        "tests": {"command": "python -X utf8 -m unittest discover -s tests -p test_*.py"},
        "contract": export_contract(),
        "ux_mapping": {"ids": [f"O{i}" for i in range(1, 55)]},
    }


def validate_baseline(repo_root: Path, baseline_path: Path) -> list[str]:
    try:
        data = json.loads(baseline_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"无法读取基线: {exc}"]
    errors = [f"缺少基线字段: {key}" for key in REQUIRED if key not in data]
    if not isinstance(data.get("dirty_files"), list):
        errors.append("dirty_files 必须是路径与状态列表")
    if not isinstance(data.get("contract"), dict) or not data.get("contract", {}).get("enums"):
        errors.append("contract 必须包含后端导出的 enums")
    ids = data.get("ux_mapping", {}).get("ids", [])
    if ids != [f"O{i}" for i in range(1, 55)]:
        errors.append("体验映射必须且只能包含 O1–O54")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("--check-current", action="store_true")
    parser.add_argument("--write", action="store_true", help="将当前只读快照冻结为指定基线")
    args = parser.parse_args(argv)
    # 以 ``python scripts/...`` 直接执行时，Python 只会自动加入 scripts/；
    # 显式加入仓库根，避免基线命令依赖调用者预先设置 PYTHONPATH。
    repo_root = Path.cwd()
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    try:
        if args.write:
            args.baseline.parent.mkdir(parents=True, exist_ok=True)
            args.baseline.write_text(
                json.dumps(snapshot(repo_root), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            print(f"已写入基线: {args.baseline}")
            return 0
        errors = validate_baseline(repo_root, args.baseline)
        if args.check_current and not errors:
            current = snapshot(repo_root)
            saved = json.loads(args.baseline.read_text(encoding="utf-8"))
            if saved["contract"] != current["contract"]:
                errors.append("当前后端契约与冻结基线不一致")
    except (ImportError, OSError, subprocess.SubprocessError) as exc:
        print(f"环境不可判定: {exc}")
        return 2
    for error in errors:
        print(error)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
