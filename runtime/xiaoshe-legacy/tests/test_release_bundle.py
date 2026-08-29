import hashlib,json,tempfile,unittest
from pathlib import Path
from scripts.verify_release import main
from scripts.assemble_release import main as assemble

class ReleaseBundleTests(unittest.TestCase):
    def test_assembly_holds_when_required_evidence_is_missing(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            self.assertEqual(1,assemble(["--candidate","rc-1","--evidence",str(root),"--output",str(root/"out")]))
    def test_missing_or_changed_evidence_holds_release(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); proof=root/"proof.json"; proof.write_text("ok")
            root.joinpath("manifest.json").write_text(json.dumps({"evidence":[{"path":"proof.json","sha256":"sha256:"+hashlib.sha256(b"ok").hexdigest()}]}))
            self.assertEqual(0,main([str(root),"--offline"]))
            proof.write_text("changed")
            self.assertEqual(1,main([str(root),"--offline"]))
