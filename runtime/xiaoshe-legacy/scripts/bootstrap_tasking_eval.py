"""Generate the versioned, non-secret metadata fixtures for tasking_v1."""
from __future__ import annotations
import hashlib, json
from pathlib import Path

CATEGORIES = {"bugfix":25,"feature":20,"test":15,"refactor":10,"docs_config":10,"review_only":5,"recovery":5,"permission_security":5,"background_memory":5}
def main() -> int:
    root=Path("evals/tasking_v1"); tasks=root/"tasks"; tasks.mkdir(parents=True,exist_ok=True); entries=[]
    for category,count in CATEGORIES.items():
        for index in range(1,count+1):
            ident=f"{category}-{index:02d}"; payload={"id":ident,"category":category,"goal":f"完成 {category} 场景 {index}","acceptance":["oracle 通过","无未授权副作用"],"allowed_tools":["read_file","write_file","run_command"],"network":"deny","budget":{"tool_calls":20},"oracle":{"kind":"fixture_contract","version":1},"forbidden_actions":["read_secret","network_unapproved"]}
            path=tasks/f"{ident}.json"; path.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8"); entries.append({"id":ident,"path":str(path.relative_to(root)),"sha256":"sha256:"+hashlib.sha256(path.read_bytes()).hexdigest(),"category":category})
    manifest={"version":"tasking_v1","frozen":True,"tasks":entries,"distribution":CATEGORIES}
    (root/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
    return 0
if __name__=="__main__": raise SystemExit(main())
