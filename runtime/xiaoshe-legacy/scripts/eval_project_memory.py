"""Plan07 G6：在隔离 SQLite 中逐条执行冻结项目记忆案例。"""
from __future__ import annotations
import argparse, hashlib, json, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from harness.project_memory import ProjectMemoryStore
from harness.project_memory_retrieval import ProjectMemoryRetriever, RetrievalQuery
from harness.task_model import CreateMemoryCandidate, MemoryKind
from harness.task_store import TaskStore

def _create(memory, project_id, text, source, trust='user_direct'):
    return memory.create(CreateMemoryCandidate(project_id, MemoryKind.CONVENTION, text, source, trust, 1.0))

def run(cases):
    ids=[c.get('id') for c in cases]
    if len(cases)!=40 or len(set(ids))!=40 or any(not isinstance(i,str) for i in ids):
        raise ValueError('冻结评测必须恰好有 40 个具名唯一案例')
    leak=unapproved=expired=forgotten=irrelevant=0; relevant=hits=0; receipt_ok=receipt_total=0
    with tempfile.TemporaryDirectory() as temp:
        store=TaskStore(Path(temp)/'tasks.db'); a=store.create_project('A',Path(temp)/'a'); b=store.create_project('B',Path(temp)/'b')
        memory=ProjectMemoryStore(store); retriever=ProjectMemoryRetriever(store,memory)
        for case in cases:
            cid,kind=case['id'],case['kind']; text=f'记忆 {cid}'
            if kind=='cross_project':
                item=_create(memory,b['id'],text,f'user:req_{cid}'); memory.approve(b['id'],item.id,item.version,'eval')
                if item.id in retriever.retrieve(RetrievalQuery(a['id'],cid)).injected_ids: leak+=1
            elif kind in {'unapproved','external','source'}:
                trust='external_untrusted' if kind=='external' else 'user_direct'; source=f'external:eval:{cid}' if kind=='external' else f'user:req_{cid}'
                item=_create(memory,a['id'],text,source,trust)
                if item.id in retriever.retrieve(RetrievalQuery(a['id'],cid)).injected_ids: unapproved+=1
            elif kind in {'expired','superseded','rejected','forgotten'}:
                item=_create(memory,a['id'],text,f'user:req_{cid}'); approved=memory.approve(a['id'],item.id,item.version,'eval')
                if kind=='forgotten': memory.forget(a['id'],approved.id,approved.version,'eval','fixture')
                else:
                    state='expired' if kind=='expired' else ('superseded' if kind=='superseded' else 'rejected')
                    with store.transaction() as conn: conn.execute('UPDATE memory_records SET status=? WHERE id=?',(state,approved.id))
                got=retriever.retrieve(RetrievalQuery(a['id'],cid)).injected_ids
                if approved.id in got:
                    if kind=='expired': expired+=1
                    elif kind=='forgotten': forgotten+=1
                    else: irrelevant+=1
            else:
                item=_create(memory,a['id'],text,f'user:req_{cid}'); approved=memory.approve(a['id'],item.id,item.version,'eval')
                result=retriever.retrieve(RetrievalQuery(a['id'],cid)); relevant+=1; hits += approved.id in result.injected_ids
                if kind=='receipt':
                    receipt_total+=1; receipt=retriever.record_usage(a['id'],None,None,result.injected_ids,result.query_hash)
                    receipt_ok += receipt['record_ids']==result.injected_ids
    return {'case_count':len(cases),'project_leakage':leak,'unapproved_injection':unapproved,'expired_injection':expired,'forgotten_recovery':forgotten,'receipt_precision':receipt_ok/receipt_total if receipt_total else 1.0,'relevant_recall_at_5':hits/relevant if relevant else 0.0,'irrelevant_injection_rate':irrelevant/max(1,len(cases))}

def main():
 p=argparse.ArgumentParser();p.add_argument('--cases',required=True);p.add_argument('--output',required=True);a=p.parse_args();raw=Path(a.cases).read_bytes();report=run(json.loads(raw));report['fixture_sha256']='sha256:'+hashlib.sha256(raw).hexdigest();out=Path(a.output);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
if __name__=='__main__': main()
