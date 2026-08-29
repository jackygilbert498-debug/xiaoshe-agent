import tempfile
import unittest
from pathlib import Path

from harness.project_memory import ProjectMemoryStore
from harness.project_memory_retrieval import ProjectMemoryRetriever, RetrievalQuery
from harness.task_model import CreateMemoryCandidate, MemoryKind
from harness.task_store import TaskStore


class MemoryForgetTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.store=TaskStore(Path(self.temp.name)/'t.db')
        self.project=self.store.create_project('P',Path(self.temp.name)/'p'); self.memory=ProjectMemoryStore(self.store)

    def tearDown(self): self.temp.cleanup()

    def test_forget_removes_text_from_record_and_retrieval(self):
        item=self.memory.create(CreateMemoryCandidate(self.project['id'],MemoryKind.FACT,'极其独特的秘密短语','user:req_memory_forget','user_direct',1.0))
        item=self.memory.approve(self.project['id'],item.id,item.version,'user')
        forgotten=self.memory.forget(self.project['id'],item.id,item.version,'user','用户要求')
        self.assertEqual(('forgotten',None),(forgotten.status,forgotten.text))
        self.assertEqual((),ProjectMemoryRetriever(self.store,self.memory).retrieve(RetrievalQuery(self.project['id'],'极其独特')).records)
        raw=self.store.memory_record(item.id,self.project['id']); self.assertIsNone(raw['text']); self.assertEqual('forgotten',raw['source_ref'])

    def test_forget_requires_reason(self):
        item=self.memory.create(CreateMemoryCandidate(self.project['id'],MemoryKind.FACT,'内容','user:req_memory_forget','user_direct',1.0))
        with self.assertRaisesRegex(Exception,'FORGET_REASON'):
            self.memory.forget(self.project['id'],item.id,item.version,'user','')

    def test_forget_removes_existing_project_fts_row_immediately(self):
        item=self.memory.create(CreateMemoryCandidate(self.project['id'],MemoryKind.FACT,'极其独特的项目记忆','user:req_memory_forget','user_direct',1.0))
        item=self.memory.approve(self.project['id'],item.id,item.version,'user')
        retriever=ProjectMemoryRetriever(self.store,self.memory)
        retriever.retrieve(RetrievalQuery(self.project['id'],'独特'))
        with self.store.transaction() as conn:
            self.assertEqual(1,conn.execute('SELECT count(*) FROM project_memory_fts WHERE memory_id=?',(item.id,)).fetchone()[0])
        self.memory.forget(self.project['id'],item.id,item.version,'user','用户撤回')
        with self.store.transaction() as conn:
            self.assertEqual(0,conn.execute('SELECT count(*) FROM project_memory_fts WHERE memory_id=?',(item.id,)).fetchone()[0])


if __name__ == '__main__': unittest.main()
