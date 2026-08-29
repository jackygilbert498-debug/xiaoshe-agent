"""Static contracts for the local model management UI.

These checks deliberately avoid a browser runtime: they pin down accessibility
and secret-boundary invariants before the walkthrough suite exercises the DOM.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
UI_HTML = ROOT / "ui" / "index.html"
MODEL_MANAGER = ROOT / "ui" / "js" / "model-manager.js"


class ModelManagerContractTests(unittest.TestCase):
    def test_model_menu_has_real_add_button_and_module(self):
        html = UI_HTML.read_text("utf-8")
        js = MODEL_MANAGER.read_text("utf-8")
        self.assertIn('id="btn-add-model"', html)
        self.assertIn('>＋ 添加模型<', html)
        self.assertIn("export function initModelManager", js)
        self.assertNotRegex(js, r"innerHTML\s*=")

    def test_new_switch_posts_model_id(self):
        js = MODEL_MANAGER.read_text("utf-8")
        self.assertIn('net.post("/api/model", { model_id:', js)

    def test_manager_form_has_protocol_templates_and_empty_key_field(self):
        js = MODEL_MANAGER.read_text("utf-8")
        for value in ("openai_compatible", "anthropic", "gemini", "ollama"):
            self.assertIn(value, js)
        self.assertIn("密钥已保存", js)
        self.assertNotIn("profile.api_key", js)
        self.assertIn('type: "password"', js)

    def test_save_and_test_are_separate_actions(self):
        js = MODEL_MANAGER.read_text("utf-8")
        self.assertIn("保存", js)
        self.assertIn("测试连接", js)
        self.assertIn("测试可能产生少量调用或计费", js)


if __name__ == "__main__":
    unittest.main(verbosity=2)
