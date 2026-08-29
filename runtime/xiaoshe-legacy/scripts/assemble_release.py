"""Assemble an offline-verifiable candidate only from explicit evidence files."""
from __future__ import annotations
import argparse,hashlib,json,shutil
from pathlib import Path
REQUIRED=("g7-resources/report.json","g8-eval/report.json")
def digest(path): return "sha256:"+hashlib.sha256(path.read_bytes()).hexdigest()
def main(argv=None):
 p=argparse.ArgumentParser();p.add_argument("--candidate",required=True);p.add_argument("--evidence",type=Path,required=True);p.add_argument("--output",type=Path,required=True);a=p.parse_args(argv);missing=[item for item in REQUIRED if not (a.evidence/item).is_file()]
 if missing: print(json.dumps({"action":"hold","missing":missing},ensure_ascii=False));return 1
 a.output.mkdir(parents=True,exist_ok=True); entries=[]
 for item in REQUIRED:
  src=a.evidence/item;dst=a.output/item;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst);entries.append({"path":item,"sha256":digest(dst)})
 (a.output/"manifest.json").write_text(json.dumps({"candidate":a.candidate,"evidence":entries},ensure_ascii=False,indent=2),encoding="utf-8");return 0
if __name__=="__main__":raise SystemExit(main())
