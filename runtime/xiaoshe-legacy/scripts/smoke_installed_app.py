"""Portable preflight for a packaged desktop build; never claims signing success."""
from __future__ import annotations
import argparse,json,platform
from pathlib import Path
def main(argv=None):
 p=argparse.ArgumentParser();p.add_argument("--platform",required=True,choices=("windows","macos"));p.add_argument("--report",type=Path,required=True);a=p.parse_args(argv)
 host="macos" if platform.system()=="Darwin" else "windows" if platform.system()=="Windows" else "other"; report={"platform":a.platform,"host":host,"tauri_config":Path("tauri/tauri.conf.json").is_file(),"run_py":Path("run.py").is_file(),"status":"passed" if host==a.platform else "not_run_on_target"}
 a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8");return 0 if report["status"]=="passed" else 2
if __name__=="__main__":raise SystemExit(main())
