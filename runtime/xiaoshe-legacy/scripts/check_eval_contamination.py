from __future__ import annotations
import argparse,json,re
from pathlib import Path
def main(argv=None):
 p=argparse.ArgumentParser();p.add_argument("--suite",type=Path,required=True);a=p.parse_args(argv); manifest=json.loads(a.suite.read_text()); ids=[item["id"] for item in manifest["tasks"]]; findings=[]
 for path in Path("harness").rglob("*.py"):
  text=path.read_text(encoding="utf-8")
  findings += [{"file":str(path),"case":ident} for ident in ids if ident in text]
 print(json.dumps({"findings":findings},ensure_ascii=False));return 0 if not findings else 1
if __name__=="__main__":raise SystemExit(main())
