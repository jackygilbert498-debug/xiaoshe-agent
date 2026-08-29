#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WinRT OCR 盲区选型回归集（方案 §4.4.2 换型决策包的量化底座，可重复跑、纯标准库、离线不调 Kimi API）。

三类用例（HTML 源在 evals/ocr_cases/，纯文本可入 git；渲染图现跑现生成、只走临时文件、绝不入 git）：

- isolated_digits  孤立数字（计算器式稀疏按钮，浅/深双主题）——WinRT 已知系统性盲区
  （2026-07-23 探针矩阵：放大/反色/二值化/加白边全 0 词），真机上由 UIA 框源承接，
  故不计入换型门禁主判据，只如实报丢弃率/反色救回率。
- cjk_mixed        繁简混排/白字深底（深/浅双对照）——画布/自绘界面里 UIA 看不到的文本由 OCR 独担，
  计入门禁主判据。
- zoom_small       小字号密集文本。生产管线里小字恒经 zoom ×3 放大重 OCR（tools._zoom 主路径），
  故门禁样本=×3 放大后形态（small-dense-x3）；原尺形态（small-dense）只作原始盲区参考值报告。

链路：harness.render（无头 Chrome/Edge，HTML→PNG 字节）→（可选 imaging.upscale ×3，同 zoom 管线的
放大算法）→ 写临时文件 → harness.observe.ocr_words（Windows=WinRT / macOS=Vision，只调不改）→
反色补跑（harness.imaging.invert，对齐 tools._ocr_words_of_png 的救回思路）→ 统计命中/漏认/救回。
harness 函数全程只读复用。

门禁（换型立项门槛，先验定义、不靠跑出来的数据回头改）：
  主判据 = 门禁用例（cjk_mixed 全部 + zoom_small 的 ×3 放大形态）合并词召回率 ≥ 0.85
  → 达标（走完现有承接通道后盲区率未超门槛，不换引擎）。
  孤立数字类丢弃率、zoom 小字原尺召回率单独报告：分别由 UIA 框源 / zoom 放大承接，
  不单独触发换型；反色救回率高则提示「补跑通道可消化」。

退出码：0=达标（未超门槛）  1=超门槛（立项换引擎，先 Tesseract 备案）  2=环境不可用（无浏览器/非
Win/Mac/OCR 引擎缺失，无法判定）。

跑法：cd /c/Users/example/Desktop/ke && PYTHONIOENCODING=utf-8 py -3 evals/ocr_blindspot_suite.py
报告：stdout + 落档 .state/ocr-blindspot/ocr-blindspot-<时间戳>.md（.state 已 gitignore）。
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from harness import imaging, observe, render  # noqa: E402

CASES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ocr_cases")
STATE_DIR = os.path.join(REPO, ".state", "ocr-blindspot")

CLS_DIGITS = "isolated_digits"
CLS_CJK = "cjk_mixed"
CLS_SMALL = "zoom_small"
CLASSES = (CLS_DIGITS, CLS_CJK, CLS_SMALL)

# 门禁主判据只算「走完现有承接通道后仍由 OCR 独担」的用例：
# - 孤立数字类：已知系统性盲区，真机由 UIA 框源承接（docs/验收/裁剪重问-Win金标准-证据.md）→ 只报告不卡门；
# - zoom 小字·原尺：生产管线里小字恒经 zoom ×3 放大重 OCR（tools._zoom 主路径），原尺数字只是原始盲区
#   参考值 → 只报告不卡门；放大后形态（small-dense-x3）才是门禁样本。
GATE_CLASSES = (CLS_CJK, CLS_SMALL)
GATE_MIN_RECALL = 0.85          # 门禁用例合并词召回率下限（先验值，低于即「盲区率超门槛」）

RENDER_SIZE = (1200, 900)       # 用例渲染视口；长边 ≤1600 与 harness 压图预算对齐

_KEYPAD_TOKENS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "52", "CE"]
_CJK_TOKENS = ["显示为", "52", "简体中文", "繁體中文", "混排測試", "設定", "设置",
               "檔案", "文件", "訪問", "访问", "計算器", "键盘", "窗口", "标题"]
_SMALL_TOKENS = ["2026-07-24", "render", "width=1600", "height=1000", "viewport",
                 "origin=(0,0)", "uia+ocr", "scale=3.0", "52", "goldstd-win",
                 "84.844", "1397", "tesseract", "psm=7", "0.93", "quorum"]

CASES = [
    {"id": "keypad-light", "cls": CLS_DIGITS, "html": "calc-keypad-light.html",
     "expect": list(_KEYPAD_TOKENS), "digits": _KEYPAD_TOKENS[:10], "gate": False,
     "note": "计算器式稀疏按钮·浅色（孤立数字=WinRT 已知盲区，UIA 承接）"},
    {"id": "keypad-dark", "cls": CLS_DIGITS, "html": "calc-keypad-dark.html",
     "expect": list(_KEYPAD_TOKENS), "digits": _KEYPAD_TOKENS[:10], "gate": False,
     "note": "计算器式稀疏按钮·深色白字（验反色补跑救回；UIA 承接）"},
    {"id": "cjk-dark", "cls": CLS_CJK, "html": "cjk-mixed-dark.html",
     "expect": list(_CJK_TOKENS), "note": "繁简混排·白字深底（OCR 独担，计门禁）"},
    {"id": "cjk-light", "cls": CLS_CJK, "html": "cjk-mixed-light.html",
     "expect": list(_CJK_TOKENS), "note": "繁简混排·浅色对照（OCR 独担，计门禁）"},
    {"id": "small-dense", "cls": CLS_SMALL, "html": "small-text-dense.html",
     "expect": list(_SMALL_TOKENS), "gate": False,
     "note": "12px 密集小字·原尺（原始盲区参考；生产恒经 zoom 放大，不计门禁）"},
    {"id": "small-dense-x3", "cls": CLS_SMALL, "html": "small-text-dense.html",
     "expect": list(_SMALL_TOKENS), "upscale": 3,
     "note": "12px 密集小字·×3 放大（zoom 承接后的真实形态，计门禁）"},
]


# ───────────────────────── 基础件（可注入，离线可测） ─────────────────────────

def squash(s):
    """去全部空白：WinRT 的 CJK 结果字间常带空格（「显 示 为 5 2」），比对前一律压平。"""
    return "".join(str(s).split())


def winrt_ocr(png, runner=None):
    """PNG 字节 → (ok, 全文或错误, words)。写临时文件喂 observe.ocr_words（它吃文件路径），
    用完即删——照 tools._ocr_words_via_tmp 的零残留先例。runner 可注入（离线 TDD）。"""
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        with open(tmp, "wb") as f:
            f.write(png)
        return observe.ocr_words(tmp, runner=runner)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


# ───────────────────────── Tesseract 臂（换型决策包 §5 第 2 条备案实测） ─────────────────────────

TESS_LANGS = "eng+chi_sim+chi_tra"
# psm 逐类选型（2026-07-25 真机探针：同一渲染图多 psm 对比召回，原始记录见决策包「Tesseract 臂实测」节）：
# - isolated_digits：psm=6 命中 12/12，psm=11 仅 2/12——稀疏文本模式（11）把计算器按钮岛
#   拆成碎片反而全丢孤立数字，单一均匀块假设（6）反而把每个按钮当一行字读，全中；
# - cjk_mixed：6 与 3 打平（10/15、9/15），取 6；
# - zoom_small：原尺 6>3（11/16 vs 10/16），×3 打平（10/16），取 6。
# 结论：三类统一 psm=6（单一均匀文本块），表保留逐类槽位便于将来再调。
TESS_PSM = {CLS_DIGITS: 6, CLS_CJK: 6, CLS_SMALL: 6}
TESSDATA_FALLBACK = os.path.join(REPO, ".state", "tessdata")   # UB-Mannheim 静默装只带 eng，
# chi_sim/chi_tra（tessdata_best）放这里，经 TESSDATA_PREFIX 喂给子进程（.state 已 gitignore）


def find_tesseract(which=None, isfile=None):
    """自动探测 tesseract 可执行：PATH 查找 → 常见安装路径。找不到 → None（臂如实报「未安装」跳过）。"""
    which = which or shutil.which
    isfile = isfile or os.path.isfile
    p = which("tesseract")
    if p:
        return p
    for cand in (r"C:\Program Files\Tesseract-OCR\tesseract.exe",
                 r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
                 os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe")):
        if isfile(cand):
            return cand
    return None


def find_tessdata_prefix(exe, isfile=None):
    """语言包前缀：exe 旁 tessdata 已含 chi_sim+chi_tra → 不用设前缀；否则回落 .state/tessdata；
    两处都没有 → None（子进程会报缺语言，臂如实记 ocr_ok=False）。"""
    isfile = isfile or os.path.isfile

    def _has(d):
        return all(isfile(os.path.join(d, f"{lang}.traineddata")) for lang in ("chi_sim", "chi_tra"))

    if _has(os.path.join(os.path.dirname(exe), "tessdata")):
        return None
    if _has(TESSDATA_FALLBACK):
        return TESSDATA_FALLBACK
    return None


def _run_tess(argv, env):
    cp = subprocess.run(argv, capture_output=True, timeout=120, env=env)
    return cp.returncode, cp.stdout, cp.stderr


def tesseract_ocr(png, runner=None, psm=6, langs=TESS_LANGS, exe=None, tessdata_prefix=None):
    """PNG 字节 → (ok, 全文或错误, words)，与 winrt_ocr 同口径签名。
    写临时 png 喂 `tesseract <png> stdout -l … --psm N`，词表=全文按空白切词（CLI 无词框，
    统计口径里词表只用于整词精确命中，tesseract 的切词结果等价承担）。runner 可注入（离线 TDD）。"""
    exe = exe or find_tesseract()
    if not exe:
        return False, "tesseract 未安装（PATH 与常见安装路径均未探测到）", []
    if tessdata_prefix is None:
        tessdata_prefix = find_tessdata_prefix(exe)
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        with open(tmp, "wb") as f:
            f.write(png)
        env = dict(os.environ)
        if tessdata_prefix:
            env["TESSDATA_PREFIX"] = tessdata_prefix
        argv = [exe, tmp, "stdout", "-l", langs, "--psm", str(psm)]
        runner = runner or _run_tess
        try:
            rc, out, err = runner(argv, env)
        except (OSError, subprocess.TimeoutExpired) as e:
            return False, f"tesseract 调用失败: {type(e).__name__}: {str(e)[:200]}", []
        if rc != 0:
            return False, (err or b"").decode("utf-8", "replace")[:300], []
        text = out.decode("utf-8", "replace")
        words = [{"text": w} for w in text.split()]
        return True, text, words
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def invert_png(png):
    """反色图（对齐 tools._ocr_words_of_png 的补跑思路：几何不变、白字深底↔黑字白底互换）。
    不是有效 PNG → None（救回通道静默降级，不炸主流程）。"""
    try:
        w, h, rgba = imaging.decode_png(png)
        return imaging.encode_png(w, h, bytes(imaging.invert(w, h, rgba)))
    except ValueError:
        return None


def collect_text(text, words):
    """OCR 全文 + 词表合并压平成一条比对文本（词表是 boxes 模式产出，全文可能更全，两个都留）。"""
    parts = [text or ""] + [w.get("text", "") for w in (words or [])]
    return squash(" ".join(parts))


def _bounded_hit(hay, ch):
    """单字符在压平文本里的边界命中：两侧都不是字母数字才算（防「52」里的 5 冒充孤立字形 5）。"""
    i = hay.find(ch)
    while i >= 0:
        left = hay[i - 1] if i > 0 else ""
        right = hay[i + 1] if i + 1 < len(hay) else ""
        if not left.isalnum() and not right.isalnum():
            return True
        i = hay.find(ch, i + 1)
    return False


def token_hit(token, hay, word_texts=()):
    """期望词命中判定。多字词：压平子串命中（CJK 词天然夹在句子里）；单字词（孤立数字）：
    词框整词精确命中，或全文里边界命中——这是「孤立字形认没认出来」的诚实口径，不被数字串稀释。"""
    t = squash(token)
    if not t:
        return False
    if t in word_texts:
        return True
    if len(t) == 1:
        return _bounded_hit(hay, t)
    return t in hay


def _alnum(s):
    """只留字母数字：宽松口径（2026-07-25 真机探针驱动）——WinRT 对小字常把 - : = 误读成 一 ： 三，
    宽松口径量「文字内容认没认出」，严格口径量「字符级精确」，两者差距即标点/符号误读层。"""
    return "".join(ch for ch in str(s) if ch.isalnum())


def token_hit_loose(token, hay, word_texts=()):
    """宽松命中：双方滤掉非标点字符后按同一规则比对。单字词仍走边界/整词口径（防数字串稀释）。"""
    return token_hit(_alnum(token), _alnum(hay), [_alnum(w) for w in word_texts])


# ───────────────────────── 统计逻辑（纯函数，注入假 OCR 即可离线测） ─────────────────────────

def run_case(case, png, ocr_fn):
    """单个用例：（可选 ×k 放大，同 zoom 管线的成像形态）→ 主跑 + （有漏认时）反色补跑。
    返回结果 dict；ocr_fn(png)->(ok,text,words) 可注入。"""
    k = case.get("upscale")
    if k:
        w, h, rgba = imaging.decode_png(png)
        nw, nh, up = imaging.upscale(w, h, rgba, k)
        png = imaging.encode_png(nw, nh, up)
    ok, text, words = ocr_fn(png)
    hay = collect_text(text, words) if ok else ""
    wtexts = [squash(w.get("text", "")) for w in (words or [])] if ok else []
    hits = [t for t in case["expect"] if token_hit(t, hay, wtexts)]
    misses = [t for t in case["expect"] if not token_hit(t, hay, wtexts)]
    loose_hits = [t for t in case["expect"] if token_hit_loose(t, hay, wtexts)]
    rescued, invert_used = [], False
    if misses:
        inv = invert_png(png)
        if inv is not None:
            invert_used = True
            ok2, text2, words2 = ocr_fn(inv)
            if ok2:
                hay2 = collect_text(text2, words2)
                wtexts2 = [squash(w.get("text", "")) for w in (words2 or [])]
                rescued = [t for t in misses if token_hit(t, hay2, wtexts2)]
    return {"id": case["id"], "cls": case["cls"], "note": case.get("note", ""),
            "expect": list(case["expect"]), "hits": hits, "misses": misses,
            "loose_hits": loose_hits,
            "rescued": rescued, "invert_used": invert_used, "ocr_ok": bool(ok),
            "word_count": len(words or []) if ok else 0,
            "gate": case.get("gate", True), "upscale": k,
            "digits": list(case.get("digits", [])),
            "digit_dropped": [t for t in case.get("digits", []) if t in misses]}


def summarize(results):
    """按类聚合：词召回率、孤立数字丢弃率、反色补跑救回率（救回/漏认）；外加门禁类合并召回率。"""
    per_cls = {}
    for cls in CLASSES:
        rs = [r for r in results if r["cls"] == cls]
        if not rs:
            continue
        n_expect = sum(len(r["expect"]) for r in rs)
        n_hit = sum(len(r["hits"]) for r in rs)
        n_miss = sum(len(r["misses"]) for r in rs)
        n_digits = sum(len(r["digits"]) for r in rs)
        n_dropped = sum(len(r["digit_dropped"]) for r in rs)
        n_rescued = sum(len(r["rescued"]) for r in rs)
        n_loose = sum(len(r.get("loose_hits", r["hits"])) for r in rs)
        per_cls[cls] = {
            "cases": len(rs), "expect": n_expect, "hits": n_hit,
            "recall": (n_hit / n_expect) if n_expect else None,
            "loose_recall": (n_loose / n_expect) if n_expect else None,
            "digit_drop": (n_dropped / n_digits) if n_digits else None,
            "rescue": (n_rescued / n_miss) if n_miss else None,
        }
    gate_rs = [r for r in results if r["cls"] in GATE_CLASSES and r.get("gate", True)]
    g_expect = sum(len(r["expect"]) for r in gate_rs)
    g_hit = sum(len(r["hits"]) for r in gate_rs)
    gate_recall = (g_hit / g_expect) if g_expect else None
    return {"per_cls": per_cls, "gate_recall": gate_recall,
            "gate_expect": g_expect, "gate_hits": g_hit}


def judge(summary):
    """门禁判定：门禁类合并召回率 ≥ 阈值 → 达标（不换引擎）。返回判定 dict。"""
    g = summary["gate_recall"]
    over = (g is not None) and (g < GATE_MIN_RECALL)
    return {"over_gate": over, "gate_recall": g, "gate_min": GATE_MIN_RECALL,
            "verdict": ("超门槛（门禁用例召回率不足 → 立项换引擎）" if over
                        else "达标（走完承接通道后盲区率未超门槛 → 不换引擎，维持现状 + Tesseract 备案）"
                        if g is not None else "无门禁用例数据，无法判定")}


def exit_code_of(judgment):
    return 1 if judgment["over_gate"] else 0


# ───────────────────────── 报告 ─────────────────────────

def _pct(x):
    return "—" if x is None else f"{x * 100:.1f}%"


def format_report(results, summary, judgment, env_note="", tess=None):
    """tess=(results, summary, judgment) 或 None（未安装/未跑）。双臂时附对照表与各自门禁判定。"""
    lines = []
    lines.append(f"# OCR 盲区选型回归集报告 · {time.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")
    lines.append(f"- 平台：{sys.platform}（OCR 引擎：{'WinRT' if sys.platform == 'win32' else 'Vision' if sys.platform == 'darwin' else '不支持'}"
                 f"{' + Tesseract' if tess else ''}）")
    lines.append(f"- 门禁：门禁用例（cjk_mixed 全部 + zoom_small ×3 放大形态）合并召回率 ≥ {GATE_MIN_RECALL:.0%} → 达标")
    if env_note:
        lines.append(f"- 环境备注：{env_note}")
    lines.append("")
    if tess:
        lines.append("## 双臂对照（WinRT vs Tesseract）")
        lines.append("")
        lines.append("| 类 | WinRT 召回率（严格） | Tesseract 召回率（严格） | WinRT 孤立数字丢弃率 | Tesseract 孤立数字丢弃率 |")
        lines.append("|---|---|---|---|---|")
        for cls in CLASSES:
            a = summary["per_cls"].get(cls)
            b = tess[1]["per_cls"].get(cls)
            lines.append(f"| {cls} | {_pct(a['recall']) if a else '—'} | {_pct(b['recall']) if b else '—'} "
                         f"| {_pct(a['digit_drop']) if a else '—'} | {_pct(b['digit_drop']) if b else '—'} |")
        lines.append("")
        lines.append(f"| 门禁用例合并召回率 | **{_pct(summary['gate_recall'])}**（{summary['gate_hits']}/{summary['gate_expect']}）"
                     f" | **{_pct(tess[1]['gate_recall'])}**（{tess[1]['gate_hits']}/{tess[1]['gate_expect']}） | — | — |")
        lines.append("")
        lines.append(f"- WinRT 臂门禁判定：{judgment['verdict']}")
        lines.append(f"- Tesseract 臂门禁判定：{tess[2]['verdict']}")
        lines.append("")
    lines.append("## 用例明细（WinRT 臂）")
    lines.append("")
    lines.append("| 用例 | 类 | 计门禁 | 应认 | 认出 | 漏认 | 反色救回 | 漏认明细 |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for r in results:
        lines.append(f"| {r['id']} | {r['cls']} | {'是' if r.get('gate', True) else '否'} "
                     f"| {len(r['expect'])} | {len(r['hits'])} "
                     f"| {len(r['misses'])} | {len(r['rescued'])} "
                     f"| {'、'.join(r['misses']) or '无'} |")
    lines.append("")
    lines.append("## 分类汇总")
    lines.append("")
    lines.append("| 类 | 用例数 | 词召回率（严格） | 词召回率（宽松·滤标点） | 孤立数字丢弃率 | 反色救回率 |")
    lines.append("|---|---|---|---|---|---|")
    for cls in CLASSES:
        c = summary["per_cls"].get(cls)
        if not c:
            continue
        lines.append(f"| {cls} | {c['cases']} | {_pct(c['recall'])} | {_pct(c['loose_recall'])} "
                     f"| {_pct(c['digit_drop'])} | {_pct(c['rescue'])} |")
    lines.append("")
    lines.append(f"门禁用例合并召回率：**{_pct(summary['gate_recall'])}**"
                 f"（{summary['gate_hits']}/{summary['gate_expect']}），门槛 {GATE_MIN_RECALL:.0%}")
    if tess:
        lines.append("")
        lines.append("## 用例明细（Tesseract 臂）")
        lines.append("")
        lines.append("| 用例 | 类 | 计门禁 | 应认 | 认出 | 漏认 | 反色救回 | 漏认明细 |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for r in tess[0]:
            lines.append(f"| {r['id']} | {r['cls']} | {'是' if r.get('gate', True) else '否'} "
                         f"| {len(r['expect'])} | {len(r['hits'])} "
                         f"| {len(r['misses'])} | {len(r['rescued'])} "
                         f"| {'、'.join(r['misses']) or '无'} |")
        lines.append("")
        lines.append("## 分类汇总（Tesseract 臂）")
        lines.append("")
        lines.append("| 类 | 用例数 | 词召回率（严格） | 词召回率（宽松·滤标点） | 孤立数字丢弃率 | 反色救回率 |")
        lines.append("|---|---|---|---|---|---|")
        for cls in CLASSES:
            c = tess[1]["per_cls"].get(cls)
            if not c:
                continue
            lines.append(f"| {cls} | {c['cases']} | {_pct(c['recall'])} | {_pct(c['loose_recall'])} "
                         f"| {_pct(c['digit_drop'])} | {_pct(c['rescue'])} |")
        lines.append("")
        lines.append(f"门禁用例合并召回率：**{_pct(tess[1]['gate_recall'])}**"
                     f"（{tess[1]['gate_hits']}/{tess[1]['gate_expect']}），门槛 {GATE_MIN_RECALL:.0%}")
    lines.append("")
    lines.append(f"## 判定：{judgment['verdict']}")
    return "\n".join(lines)


# ───────────────────────── 真机主流程 ─────────────────────────

def render_case(case, browser=None):
    """渲染用例 HTML → PNG 字节（harness.render 现成管道；字节在内存，临时截图 render 自删）。"""
    path = os.path.join(CASES_DIR, case["html"])
    res = render.render(path, browser=browser, width=RENDER_SIZE[0], height=RENDER_SIZE[1])
    if not res.ok:
        raise RuntimeError(f"渲染失败（{case['html']}，exit={res.exit_code}）：{(res.stderr or '')[:200]}")
    return res.png


def main(argv=None):
    ap = argparse.ArgumentParser(description="WinRT OCR 盲区选型回归集（方案 §4.4.2）")
    ap.add_argument("--no-save", action="store_true", help="不落档 .state/ 报告（只打 stdout）")
    args = ap.parse_args(argv)

    if sys.platform not in ("win32", "darwin"):
        print(f"!! 当前平台 {sys.platform} 不支持 harness OCR（仅 Windows/macOS），无法判定", flush=True)
        return 2
    env_note = ""
    try:
        browser = render.detect_browser()
        env_note = f"浏览器 {browser}"
    except RuntimeError as e:
        print(f"!! {e} 无法判定", flush=True)
        return 2

    results = []
    tess_results = []
    tess_exe = find_tesseract()
    tess_prefix = find_tessdata_prefix(tess_exe) if tess_exe else None
    if tess_exe:
        env_note += f"；Tesseract {tess_exe}"
    else:
        print("[跳过] 未探测到 tesseract（PATH/常见安装路径均无），Tesseract 臂如实报「未安装」", flush=True)
    for case in CASES:
        print(f"[跑] {case['id']}（{case.get('note', '')}）…", flush=True)
        try:
            png = render_case(case, browser=browser)
        except RuntimeError as e:
            print(f"!! {e}", flush=True)
            return 2
        r = run_case(case, png, winrt_ocr)
        if not r["ocr_ok"]:
            print(f"!! {case['id']} OCR 引擎不可用，无法判定", flush=True)
            return 2
        results.append(r)
        print(f"    WinRT   认出 {len(r['hits'])}/{len(r['expect'])}，漏 {len(r['misses'])}"
              f"（救回 {len(r['rescued'])}），词数 {r['word_count']}", flush=True)
        if tess_exe:
            psm = TESS_PSM.get(case["cls"], 6)

            def _tess_fn(p, _psm=psm):
                return tesseract_ocr(p, psm=_psm, exe=tess_exe, tessdata_prefix=tess_prefix)

            tr = run_case(case, png, _tess_fn)
            tess_results.append(tr)
            if not tr["ocr_ok"]:
                print(f"    [警告] {case['id']} tesseract 调用失败，本用例 Tesseract 臂记全漏", flush=True)
            print(f"    Tess(psm={psm}) 认出 {len(tr['hits'])}/{len(tr['expect'])}，漏 {len(tr['misses'])}"
                  f"（救回 {len(tr['rescued'])}），词数 {tr['word_count']}", flush=True)

    summary = summarize(results)
    judgment = judge(summary)
    tess = None
    if tess_results:
        tess_summary = summarize(tess_results)
        tess = (tess_results, tess_summary, judge(tess_summary))
    report = format_report(results, summary, judgment, env_note=env_note, tess=tess)
    print("\n" + report, flush=True)
    if not args.no_save:
        os.makedirs(STATE_DIR, exist_ok=True)
        out = os.path.join(STATE_DIR, f"ocr-blindspot-{time.strftime('%Y%m%d-%H%M%S')}.md")
        with open(out, "w", encoding="utf-8") as f:
            f.write(report + "\n")
        print(f"\n报告已落档：{out}", flush=True)
    return exit_code_of(judgment)


if __name__ == "__main__":
    sys.exit(main())
