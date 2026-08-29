import json
import unittest
from pathlib import Path

from harness.error_codes import REGISTRY, contract, map_exception


class ErrorRegistryTests(unittest.TestCase):
    def test_codes_are_unique_and_have_actions(self):
        specs = REGISTRY.all()
        self.assertEqual(len(specs), len({item.code for item in specs}))
        self.assertTrue(all(item.safe_message and item.user_action for item in specs))

    def test_unknown_exception_does_not_leak_path_or_secret(self):
        err = map_exception(RuntimeError("failed C:/Users/alice/.env TOKEN=abc"), request_id="r1")
        public = json.dumps(err, ensure_ascii=False)
        self.assertEqual("INTERNAL_UNEXPECTED", err["code"])
        self.assertNotIn("alice", public)
        self.assertNotIn("TOKEN", public)
        self.assertEqual("r1", err["request_id"])

    def test_not_found_and_conflict_codes_keep_their_declared_http_classes(self):
        self.assertEqual(404, REGISTRY.get("TASK_MEMORY_SOURCE_NOT_FOUND").http_status)
        self.assertEqual(409, REGISTRY.get("REVIEW_CHANGESET_STALE").http_status)
        self.assertEqual(422, REGISTRY.get("TASK_PLAN_INVALID").http_status)

    def test_versioned_public_contract_matches_the_registry(self):
        path = Path(__file__).resolve().parents[1] / "docs/contracts/error-codes-v1.json"
        self.assertEqual(contract(), json.loads(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
