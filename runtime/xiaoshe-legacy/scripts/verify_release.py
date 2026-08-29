"""Offline release evidence verifier; missing or changed evidence holds a release."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path

def digest(path: Path) -> str: return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
def main(argv=None) -> int:
    parser=argparse.ArgumentParser(); parser.add_argument("bundle", type=Path); parser.add_argument("--offline", action="store_true"); args=parser.parse_args(argv)
    manifest=json.loads((args.bundle/"manifest.json").read_text(encoding="utf-8")); failures=[]
    for item in manifest.get("evidence", []):
        path=args.bundle/item["path"]
        if not path.is_file() or digest(path)!=item["sha256"]: failures.append(item["path"])
    print(json.dumps({"pass":not failures,"failures":failures},ensure_ascii=False))
    return 0 if not failures else 1
if __name__=="__main__": raise SystemExit(main())
