"""D3 真实任务 eval 基建的离线单测：fixtures 生成 / verifier 逻辑 / 摩擦解析 / 假 LLM 端到端。

不碰真 Kimi、不碰公网；ffmpeg 相关的用例在 ffmpeg 缺失时跳过（本机在 PATH 上=真跑）。
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from evals import core
from evals.real_tasks import friction, make_fixtures as fx, tasks as d3tasks, verifiers as vf


def _script(*responses):
    seq = list(responses)

    def fn(messages, tools=None, **kw):
        return seq.pop(0) if seq else {"content": "完成", "tool_calls": []}

    return fn


def _tc(name, args, i=1):
    return {"id": f"t{i}", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}


def _write_xlsx(path: Path, rows, use_inline=False):
    """测试侧最小 xlsx writer（sharedStrings 或 inlineStr 两种形态都造）。"""
    shared, sst, body = [], [], []
    if not use_inline:
        for r in rows:
            for v in r:
                if v not in shared:
                    shared.append(v)
        sst = ['<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">']
        sst += [f"<si><t>{v}</t></si>" for v in shared]
        sst.append("</sst>")
    for ri, r in enumerate(rows, 1):
        cells = []
        for ci, v in enumerate(r):
            ref = f"{chr(65 + ci)}{ri}"
            if use_inline:
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{v}</t></is></c>')
            else:
                cells.append(f'<c r="{ref}" t="s"><v>{shared.index(v)}</v></c>')
        body.append(f"<row>{''.join(cells)}</row>")
    sheet = ('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             f"<sheetData>{''.join(body)}</sheetData></worksheet>")
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/worksheets/sheet1.xml", sheet)
        if not use_inline:
            z.writestr("xl/sharedStrings.xml", "".join(sst))


class TestFixtures(unittest.TestCase):
    def test_shape_png_classifies_to_own_color(self):
        for shape in ("circle", "square", "triangle", "rect"):
            for color in fx.PALETTE:
                self.assertEqual(vf.classify(vf.avg_color(fx.shape_png(shape, color))), color,
                                 f"{shape}/{color}")

    def test_t2_ab_bytes_differ_but_same_class(self):
        """A/B 配对图字节必须不同（否则改名验证失去意义），颜色分类必须一致。"""
        for (a_name, shape, color), b_name in zip(fx.T2_SHAPES, fx.T2_B_NAMES):
            a = fx.shape_png(shape, color)
            b = fx.shape_png(shape, color, size=200, offset=(15, 10), scale=0.9)
            self.assertNotEqual(a, b)
            self.assertEqual(vf.classify(vf.avg_color(a)), vf.classify(vf.avg_color(b)))

    def test_labeled_color_png_decodes(self):
        data = fx.labeled_color_png("red", "1")
        self.assertEqual(vf.classify(vf.avg_color(data)), "red")

    def test_t5_expected_names_rule(self):
        exp = fx.expected_t5_names()
        self.assertEqual(len(exp), 5)
        self.assertTrue(all(n.startswith("img_00") for n in exp.values()))
        # 任务采用大小写不敏感字典序："final final v2（终稿）.png" < "IMG_2034 (1).PNG"
        self.assertEqual(exp["final final v2（终稿）.png"], "img_001.png")
        self.assertEqual(exp["IMG_2034 (1).PNG"], "img_002.png")
        self.assertEqual(exp["未命名 - 副本.jpg"], "img_005.jpg")

    def test_setups_land_files(self):
        with tempfile.TemporaryDirectory() as d:
            wd = Path(d)
            fx.setup_t1(wd); fx.setup_t2(wd); fx.setup_t3(wd); fx.setup_t5(wd)
            self.assertEqual(len(list((wd / "imgs").glob("*.png"))), 4)
            self.assertEqual({p.name for p in (wd / "A").glob("*.png")}, set(fx.T2_A_NAMES))
            self.assertEqual(len(list((wd / "pool").glob("*.png"))), 6)
            m = json.loads((wd / fx.T5_MANIFEST).read_text(encoding="utf-8"))
            self.assertEqual(set(m["expected"]), set(fx.T5_MESSY))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg 不在 PATH")
    def test_video_fixture_red_then_blue(self):
        with tempfile.TemporaryDirectory() as d:
            v = fx.make_segmented_video(Path(d) / "src.mp4")
            self.assertGreater(vf.probe_duration(v), 8.0)
            f1, f2 = Path(d) / "f1.png", Path(d) / "f2.png"
            vf.grab_frame(v, 1.0, f1)
            vf.grab_frame(v, 7.0, f2)
            self.assertEqual(vf.classify(vf.avg_color(f1.read_bytes())), "red")
            self.assertEqual(vf.classify(vf.avg_color(f2.read_bytes())), "blue")


class TestXlsxReader(unittest.TestCase):
    ROWS = [["文件名", "关键词", "描述"],
            ["pic_01.png", "红色，数字，方块", "一张红色底写着 1 的图"],
            ["pic_02.png", "蓝色，数字，方块", "一张蓝色底写着 2 的图"]]

    def test_shared_strings(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "c.xlsx"
            _write_xlsx(p, self.ROWS)
            self.assertEqual(vf.read_xlsx(p), self.ROWS)

    def test_inline_str(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "c.xlsx"
            _write_xlsx(p, self.ROWS, use_inline=True)
            self.assertEqual(vf.read_xlsx(p), self.ROWS)

    def test_not_xlsx(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "c.xlsx"
            p.write_text("not a zip", encoding="utf-8")
            self.assertRaises(ValueError, vf.read_xlsx, p)


class TestProbe(unittest.TestCase):
    def test_probe_duration_ok(self):
        class R:
            returncode = 0
            stdout = "3.000000\n"
            stderr = ""
        self.assertEqual(vf.probe_duration(Path("x.mp4"), runner=lambda cmd: R()), 3.0)

    def test_probe_duration_bad_rc(self):
        class R:
            returncode = 1
            stdout = ""
            stderr = "boom"
        self.assertRaises(ValueError, vf.probe_duration, Path("x.mp4"), runner=lambda cmd: R())

    def test_grab_frame_failure(self):
        class R:
            returncode = 1
            stderr = "no"
        with tempfile.TemporaryDirectory() as d:
            self.assertRaises(ValueError, vf.grab_frame, Path("x.mp4"), 1.0, Path(d) / "f.png",
                              runner=lambda cmd: R())


class TestTaskVerifiers(unittest.TestCase):
    """任务级 verify：setup 后人为模拟「正确终态/错误终态」，断言判定方向正确。"""

    def test_t2(self):
        with tempfile.TemporaryDirectory() as d:
            wd = Path(d)
            fx.setup_t2(wd)
            ctx = {"workdir": wd}
            self.assertFalse(d3tasks.D3_TASKS[1].verify(ctx))  # 还没改名 → 不过
            for (a_name, _, _), b_name in zip(fx.T2_SHAPES, fx.T2_B_NAMES):
                (wd / "B" / b_name).rename(wd / "B" / a_name)
            self.assertTrue(d3tasks.D3_TASKS[1].verify(ctx))   # 改对了 → 过
            (wd / "B" / "yuan.png").write_bytes((wd / "B" / "sanjiao.png").read_bytes())  # 张冠李戴
            self.assertFalse(d3tasks.D3_TASKS[1].verify(ctx))

    def test_t3(self):
        with tempfile.TemporaryDirectory() as d:
            wd = Path(d)
            fx.setup_t3(wd)
            ctx = {"workdir": wd}
            self.assertFalse(d3tasks.D3_TASKS[2].verify(ctx))
            col = wd / "collection"
            col.mkdir()
            for n in fx.T3_TARGET:
                shutil.copy(wd / "pool" / n, col / n)
            self.assertTrue(d3tasks.D3_TASKS[2].verify(ctx))
            shutil.copy(wd / "pool" / next(iter(fx.T3_DECOYS)), col / next(iter(fx.T3_DECOYS)))
            self.assertFalse(d3tasks.D3_TASKS[2].verify(ctx))  # 多收干扰项 → 挂

    def test_t5(self):
        with tempfile.TemporaryDirectory() as d:
            wd = Path(d)
            fx.setup_t5(wd)
            ctx = {"workdir": wd}
            self.assertFalse(d3tasks.D3_TASKS[4].verify(ctx))
            m = json.loads((wd / fx.T5_MANIFEST).read_text(encoding="utf-8"))
            for orig, new in m["expected"].items():
                (wd / "files" / orig).rename(wd / "files" / new)
            self.assertTrue(d3tasks.D3_TASKS[4].checklist[1][1](ctx))  # 字节未损坏
            self.assertTrue(d3tasks.D3_TASKS[4].checklist[2][1](ctx))  # 旧名无残留
            (wd / "files" / "img_001.png").write_bytes(b"corrupted")
            self.assertFalse(d3tasks.D3_TASKS[4].checklist[1][1](ctx))  # 内容坏了要逮住

    def test_t1(self):
        with tempfile.TemporaryDirectory() as d:
            wd = Path(d)
            fx.setup_t1(wd)
            ctx = {"workdir": wd}
            self.assertFalse(d3tasks.D3_TASKS[0].verify(ctx))
            rows = [["文件名", "关键词", "描述"]] + [
                [n, "关键词，测试，图", f"{n} 的描述"] for n in fx.T1_FILENAMES]
            _write_xlsx(wd / "catalog.xlsx", rows)
            self.assertTrue(d3tasks.D3_TASKS[0].verify(ctx))


class TestFriction(unittest.TestCase):
    def test_parse_session_log(self):
        recs = [
            {"role": "user", "content": "干活"},
            {"role": "assistant", "content": "", "tool_calls": ["glob"],
             "usage": {"prompt_tokens": 100, "completion_tokens": 10}},
            {"role": "tool", "name": "glob", "content": "ok", "is_error": False},
            {"role": "assistant", "content": "", "tool_calls": ["run_command"],
             "usage": {"prompt_tokens": 200, "completion_tokens": 20}},
            {"role": "tool", "name": "run_command", "content": "exit code: 2 'ls' 不是命令", "is_error": True},
            {"role": "user", "content": "[独立验收] 客观证据未显示目标达成：x"},
            {"role": "assistant", "content": "（工具调用轮数过多，已停止）", "tool_calls": []},
        ]
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.jsonl"
            p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in recs), encoding="utf-8")
            fr = friction.parse_session_log(p)
        self.assertEqual(fr["rounds"], 2)
        self.assertEqual(fr["tool_calls"], 2)
        self.assertEqual(fr["tool_errors"], 1)
        self.assertEqual(fr["error_by_tool"], {"run_command": 1})
        self.assertEqual(fr["verify_nudges"], 1)
        self.assertEqual(fr["prompt_tokens"], 300)
        self.assertTrue(fr["hit_round_limit"])
        self.assertIn("轮数过多", fr["final_reply"])
        self.assertFalse(fr["compaction_observable"])  # 无压缩事件时 False

    def test_parse_session_log_compaction_events(self):
        """P2-7：压缩事件可观测——system event=compaction 被 friction 消费统计（真实落盘格式）。"""
        recs = [
            {"role": "user", "content": "干活"},
            {"role": "assistant", "content": "", "tool_calls": ["glob"],
             "usage": {"prompt_tokens": 100, "completion_tokens": 10}},
            {"role": "tool", "name": "glob", "content": "ok", "is_error": False},
            {"role": "system", "event": "compaction", "kind": "auto_compact",
             "ts": "2026-07-26T10:00:00+08:00", "reason": "75% 触发自动压缩",
             "before_msgs": 20, "after_msgs": 5, "before_chars": 150000, "after_chars": 30000,
             "depth": 0},
            {"role": "assistant", "content": "done", "tool_calls": []},
        ]
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.jsonl"
            p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in recs), encoding="utf-8")
            fr = friction.parse_session_log(p)
        self.assertTrue(fr["compaction_observable"])
        self.assertEqual(len(fr["compaction_events"]), 1)
        self.assertEqual(fr["compaction_events"][0]["kind"], "auto_compact")
        self.assertEqual(fr["compaction_events"][0]["before_chars"], 150000)
        self.assertEqual(fr["compaction_events"][0]["after_chars"], 30000)
        self.assertEqual(fr["compaction_stats"]["chars_saved"], 120000)

    def test_missing_log(self):
        fr = friction.parse_session_log(Path("不存在的文件.jsonl"))
        self.assertEqual(fr["rounds"], 0)


class TestEndToEndScripted(unittest.TestCase):
    """假 LLM 端到端：T5 任务走真 core.run_once（真 setup/真 run_command/真 verify），证明任务接线正确。"""

    # 注意：末行注释里的 "files/" 是有意的——permission.py 的别名路径扫描会把「无斜杠但含冒号」的
    # write_file 内容误判成 NTFS ADS 敏感路径硬拒（D3 已记录的误伤，修复属后续阶段）；末行带斜杠可绕开误伤。
    _NORMALIZE = (
        "import os\r\n"
        "d = 'files'\r\n"
        "names = sorted((f for f in os.listdir(d) if f.lower().endswith(('.png', '.jpg', '.jpeg'))), key=str.lower)\r\n"
        "for i, name in enumerate(names, 1):\r\n"
        "    ext = name.rsplit('.', 1)[-1].lower()\r\n"
        "    os.rename(os.path.join(d, name), os.path.join(d, 'img_%03d.%s' % (i, ext)))\r\n"
        "# end of script (files/ done)\r\n"
    )

    def test_t5_scripted_e2e(self):
        task = d3tasks.D3_TASKS[4]
        # 命令解释器按平台分支：Windows 用 py 启动器（保持原字面命令），POSIX 无 py → sys.executable。
        py_cmd = "py -3 normalize.py" if sys.platform == "win32" else f'"{sys.executable}" normalize.py'
        scripted = core.Task(
            name=task.name, prompt=task.prompt, allow=task.allow, setup=task.setup,
            checklist=task.checklist, verify=task.verify,
            make_model=lambda: _script(
                {"content": "", "tool_calls": [
                    _tc("write_file", {"path": "normalize.py", "content": self._NORMALIZE}, 1)]},
                {"content": "", "tool_calls": [_tc("run_command", {"command": py_cmd}, 2)]},
                {"content": "已完成规范化", "tool_calls": []},
            ))
        with tempfile.TemporaryDirectory() as d:
            out = core.run_once(scripted, Path(d))
        self.assertTrue(out.passed, f"failed_step={out.failed_step} rc={out.rc} denied={out.denied_calls}")
        self.assertIsNone(out.failed_step)
        self.assertEqual(out.denied_calls, 0)


if __name__ == "__main__":
    unittest.main()
