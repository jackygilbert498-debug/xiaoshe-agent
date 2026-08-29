"""模型复核只添加 finding，永不覆盖确定性检查结果。"""
from __future__ import annotations
import json
from dataclasses import dataclass

@dataclass(frozen=True)
class ModelReviewFinding:
 severity: str; code: str; message: str; evidence_refs: tuple[str,...]=()

def should_model_review(risk: str, user_requested: bool=False) -> bool: return bool(user_requested or risk in {'medium','high'})

def parse_findings(raw: str) -> tuple[ModelReviewFinding,...]:
 try: values=json.loads(raw)
 except (TypeError,json.JSONDecodeError): return ()
 if not isinstance(values,list): return ()
 result=[]
 for item in values:
  if not isinstance(item,dict) or item.get('severity') not in {'warning','blocker'} or not isinstance(item.get('code'),str) or not isinstance(item.get('message'),str): continue
  result.append(ModelReviewFinding(item['severity'],item['code'][:80],item['message'][:1000],tuple(x for x in item.get('evidence_refs',[]) if isinstance(x,str))))
 return tuple(result)
