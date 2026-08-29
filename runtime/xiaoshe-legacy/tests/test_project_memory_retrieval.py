import tempfile
import unittest
from unittest.mock import patch
import sqlite3
from pathlib import Path

from harness.project_memory import ProjectMemoryStore
from harness.project_memory_retrieval import MemoryBudget, ProjectMemoryRetriever, RetrievalQuery
from harness.task_model import CreateMemoryCandidate, MemoryKind
from harness.task_store import TaskStore


class ProjectMemoryRetrievalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.store=TaskStore(Path(self.temp.name)/'t.db')
        self.a=self.store.create_project('A',Path(self.temp.name)/'a'); self.b=self.store.create_project('B',Path(self.temp.name)/'b')
        self.memory=ProjectMemoryStore(self.store); self.retriever=ProjectMemoryRetriever(self.store,self.memory)

    def tearDown(self): self.temp.cleanup()

    def approved(self, project, text):
        item=self.memory.create(CreateMemoryCandidate(project['id'],MemoryKind.CONVENTION,text,'user:req_memory_retrieval','user_direct',1.0))
        return self.memory.approve(project['id'],item.id,item.version,'user')

    def test_only_approved_current_project_records_return(self):
        visible=self.approved(self.a,'运行 unittest 测试')
        self.approved(self.b,'运行 pytest 测试')
        candidate=self.memory.create(CreateMemoryCandidate(self.a['id'],MemoryKind.FACT,'草稿不能注入','user:req_memory_retrieval','user_direct',1.0))
        result=self.retriever.retrieve(RetrievalQuery(self.a['id'],'测试'))
        self.assertEqual([visible.id],list(result.injected_ids)); self.assertNotIn(candidate.id,result.injected_ids)

    def test_budget_and_receipt_only_include_injected_records(self):
        first=self.approved(self.a,'第一条测试约定'); self.approved(self.a,'第二条测试约定')
        result=self.retriever.retrieve(RetrievalQuery(self.a['id'],'测试',MemoryBudget(max_records=1,max_chars=100,max_tokens_estimate=20)))
        receipt=self.retriever.record_usage(self.a['id'],'run_1',None,result.injected_ids,result.query_hash)
        self.assertEqual(result.injected_ids,receipt['record_ids']); self.assertEqual(1,len(result.records)); self.assertGreaterEqual(result.omitted_count,1)

    def test_context_render_contains_only_selected_records(self):
        visible=self.approved(self.a,'项目测试约定')
        self.approved(self.b,'其他项目不能注入')
        result=self.retriever.retrieve(RetrievalQuery(self.a['id'],'测试'))
        rendered=self.retriever.render_for_context(result)
        self.assertIn(visible.id,rendered); self.assertNotIn('其他项目',rendered)

    def test_fts_path_is_observable(self):
        self.approved(self.a,'项目测试约定')
        result=self.retriever.retrieve(RetrievalQuery(self.a['id'],'测试'))
        self.assertEqual('fts5',result.engine)
        self.assertFalse(result.degraded)
        self.assertIsNone(result.degradation_reason)

    def test_missing_fts_falls_back_to_scan_with_observable_reason(self):
        visible=self.approved(self.a,'项目测试约定')
        with patch.object(self.retriever,'_retrieve_fts',side_effect=sqlite3.OperationalError('no such module: fts5')):
            result=self.retriever.retrieve(RetrievalQuery(self.a['id'],'测试'))
        self.assertEqual('scan',result.engine)
        self.assertTrue(result.degraded)
        self.assertEqual('fts5_unavailable',result.degradation_reason)
        self.assertEqual([visible.id],list(result.injected_ids))

if __name__ == '__main__': unittest.main()
