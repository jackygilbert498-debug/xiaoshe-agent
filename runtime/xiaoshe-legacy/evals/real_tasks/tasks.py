"""D3 真实任务定义：用户的 5 类日常任务，真 Kimi（kimi_chat）经 core.run_once 端到端跑。

- model=真 kimi_chat，prompt=自然话（一个真实用户会怎么说就怎么写，含必要的环境提示）。
- allow 白名单只放该任务必需的工具；工作目录=core.run_once 起的独立沙盒（.d3/<ts>/<任务名>）。
  ⚠ 绝不能放 .state 下——permission 对 .state 整树硬拒，文件类工具全灭（P0-2 实测教训）。
- verify/checklist 全部走 verifiers.py 的确定性判定，不看模型自称。
- T3 诚实口径：web_fetch 的 SSRF 护栏（harness/web.py is_safe_url）只放行公网，localhost fixture 站
  会被拦——故「收集指定类型媒体」用本地素材库筛选变体（从 pool/ 按内容挑红色圆形收进 collection/），
  这本身就是用户场景「从已有素材里按描述挑」的合理离线近似；公网抓取能力不在本次评测范围。
"""
from __future__ import annotations

from pathlib import Path

from harness import kimi_client

from ..core import Task
from . import make_fixtures as fx
from . import verifiers as vf

_ENV = ("（环境：Windows，当前目录即工作目录，一律用相对路径；跑 Python 用 `py -3 脚本名`；"
        "ffmpeg/ffprobe 已在 PATH；run_command 执行的是 cmd 命令。）")

# ── T1 看图写描述做 xlsx ─────────────────────────────────────────────

_T1_PROMPT = (
    "当前目录的 imgs/ 文件夹里有 4 张 PNG 图（pic_01.png 到 pic_04.png）。请逐张用 read_image 查看，"
    "给每张图写出 3 个中文关键词和一句中文描述。然后在当前目录生成 catalog.xlsx：第一张工作表，"
    "第 1 行是表头「文件名」「关键词」「描述」，后面 4 行对应 4 张图（文件名列只写文件名本身，如 pic_01.png；"
    "关键词列把 3 个关键词用顿号连起来）。xlsx 没有现成库，请用 py -3 写一个 Python 脚本"
    "（标准库 zipfile + xml 手拼）生成它，生成后确认文件存在。" + _ENV
)


def _t1_rows(ctx):
    return vf.t1_catalog_rows(ctx["workdir"])


def _t1_header(ctx):
    rows = _t1_rows(ctx)
    return bool(rows) and all(h in rows[0] for h in ("文件名", "关键词", "描述"))


def _t1_all_pics(ctx):
    rows = _t1_rows(ctx)
    names = {r[0] for r in rows[1:] if r}
    return set(fx.T1_FILENAMES) <= names


def _t1_filled(ctx):
    rows = _t1_rows(ctx)
    body = [r for r in rows[1:] if r and r[0] in fx.T1_FILENAMES]
    return len(body) == 4 and all(len(r) >= 3 and r[1].strip() and r[2].strip() for r in body)


# ── T2 双文件夹特征匹配改名 ──────────────────────────────────────────

_T2_PROMPT = (
    "当前目录有 A/ 和 B/ 两个文件夹，各 3 张 PNG 图。B 里每张图的内容（颜色+形状）都和 A 里某一张对应，"
    "只是文件名对不上。请用 read_image 逐张查看两组图，按内容配对，然后用 run_command（cmd 的 ren 命令）"
    "把 B/ 里的文件改名成与它内容匹配的 A/ 文件的同名——改完后 B/ 里的 3 个文件名应与 A/ 完全一致"
    f"（A/ 里是：{'、'.join(fx.T2_A_NAMES)}）。A/ 不要动。" + _ENV
)


def _t2_names(ctx):
    b = ctx["workdir"] / "B"
    got = {p.name for p in b.glob("*.png")} if b.is_dir() else set()
    return set(fx.T2_A_NAMES) == got


# ── T3 按主题收集媒体（本地素材库变体，见模块 docstring） ────────────

_T3_PROMPT = (
    "当前目录的 pool/ 文件夹是一批素材图（6 张 PNG，文件名是随机字符、看不出内容）。"
    "请用 read_image 逐张查看，把内容是「红色圆形」的图挑出来，用 run_command（cmd 的 copy 命令，"
    "目标文件夹不存在就先 mkdir）复制到当前目录的 collection/ 文件夹里，文件名保持不变。"
    "不是红色圆形的不要收。" + _ENV
)


# ── T4 视频裁剪/截图 ─────────────────────────────────────────────────

_T4_PROMPT = (
    "当前目录有一个 src.mp4（10 秒：前 5 秒红色画面、后 5 秒蓝色画面）。请用 run_command 调 ffmpeg 完成："
    "① 裁出第 2 秒到第 5 秒这段 3 秒片段，存为 clip.mp4；"
    "② 在第 1 秒和第 7 秒各截一帧，分别存为 frame1.png、frame2.png。"
    "完成后用 ffprobe 确认 clip.mp4 时长约 3 秒。" + _ENV
)


def _t4_clip_ok(ctx):
    f = ctx["workdir"] / "clip.mp4"
    if not f.is_file():
        return False
    try:
        return 2.0 <= vf.probe_duration(f) <= 4.0
    except ValueError:
        return False


def _t4_frames_exist(ctx):
    wd = ctx["workdir"]
    for n in ("frame1.png", "frame2.png"):
        if not (wd / n).is_file():
            return False
        try:
            vf.avg_color((wd / n).read_bytes())
        except ValueError:
            return False
    return True


def _t4_frame_colors(ctx):
    wd = ctx["workdir"]
    try:
        return (vf.classify(vf.avg_color((wd / "frame1.png").read_bytes())) == "red"
                and vf.classify(vf.avg_color((wd / "frame2.png").read_bytes())) == "blue")
    except (ValueError, OSError):
        return False


def _t4_clip_content(ctx):
    """clip 中点帧应是红色段内容（裁对区间的客观证据）。"""
    wd = ctx["workdir"]
    tmp = wd / ".verify_clip_frame.png"
    try:
        vf.grab_frame(wd / "clip.mp4", 1.5, tmp)
        return vf.classify(vf.avg_color(tmp.read_bytes())) == "red"
    except (ValueError, OSError):
        return False
    finally:
        tmp.unlink(missing_ok=True)


# ── T5 乱命名规范化小脚本 ────────────────────────────────────────────

_T5_PROMPT = (
    "当前目录的 files/ 文件夹里有 5 张图片，文件名很乱（有空格、中文、大小写混杂）。"
    "请在当前目录写一个 normalize.py 并用 `py -3 normalize.py` 运行它，把 files/ 里所有图片"
    "按原文件名大小写不敏感的字典序升序排序后，依次重命名为 img_001、img_002……（三位数字编号），"
    "扩展名保留但统一转成小写（如 .PNG → .png）。重命名在 files/ 文件夹内完成，只改名、不改文件内容。"
    "跑完后确认新文件名都生效了。" + _ENV
)


def _t5_script(ctx):
    return (ctx["workdir"] / "normalize.py").is_file()


def _t5_content(ctx):
    return vf.t5_renamed(ctx["workdir"])[0]


def _t5_no_leftover(ctx):
    return vf.t5_renamed(ctx["workdir"])[1]


# ── 任务表 ───────────────────────────────────────────────────────────

def _all(*fns):
    return lambda ctx: all(f(ctx) for f in fns)


D3_TASKS = [
    Task(
        name="T1看图写描述做xlsx",
        prompt=_T1_PROMPT,
        allow=("read_image", "write_file", "run_command", "glob", "read_file"),
        make_model=lambda: kimi_client.chat,
        setup=fx.setup_t1,
        checklist=(
            ("catalog.xlsx 已生成且可解析", lambda c: bool(_t1_rows(c))),
            ("表头三列正确", _t1_header),
            ("4 张图文件名全在表内", _t1_all_pics),
            ("关键词/描述列非空", _t1_filled),
        ),
        verify=_all(_t1_header, _t1_all_pics, _t1_filled),
    ),
    Task(
        name="T2双文件夹特征匹配改名",
        prompt=_T2_PROMPT,
        allow=("read_image", "run_command", "glob"),
        make_model=lambda: kimi_client.chat,
        setup=fx.setup_t2,
        checklist=(
            ("B 文件名集合与 A 一致", _t2_names),
            ("逐张内容（颜色分类）匹配", lambda c: vf.t2_color_match(c["workdir"])),
        ),
        verify=lambda c: _t2_names(c) and vf.t2_color_match(c["workdir"]),
    ),
    Task(
        name="T3按主题收集媒体",
        prompt=_T3_PROMPT,
        allow=("read_image", "run_command", "glob"),
        make_model=lambda: kimi_client.chat,
        setup=fx.setup_t3,
        checklist=(
            ("3 张红色圆形全收进 collection", lambda c: vf.t3_collection(c["workdir"])[0]),
            ("没有多收干扰项", lambda c: vf.t3_collection(c["workdir"])[1]),
        ),
        verify=lambda c: all(vf.t3_collection(c["workdir"])),
    ),
    Task(
        name="T4视频裁剪与截图",
        prompt=_T4_PROMPT,
        allow=("run_command", "glob", "read_file"),
        make_model=lambda: kimi_client.chat,
        setup=fx.setup_t4,
        checklist=(
            ("clip.mp4 生成且时长≈3s", _t4_clip_ok),
            ("frame1/frame2 存在且可解码", _t4_frames_exist),
            ("frame1 红 / frame2 蓝", _t4_frame_colors),
            ("clip 内容确为红色段", _t4_clip_content),
        ),
        verify=_all(_t4_clip_ok, _t4_frames_exist, _t4_frame_colors, _t4_clip_content),
    ),
    Task(
        name="T5乱命名规范化脚本",
        prompt=_T5_PROMPT,
        allow=("write_file", "run_command", "read_file", "glob", "edit"),
        make_model=lambda: kimi_client.chat,
        setup=fx.setup_t5,
        checklist=(
            ("normalize.py 已写", _t5_script),
            ("新文件名就位且字节未损坏", _t5_content),
            ("旧文件名无残留", _t5_no_leftover),
        ),
        verify=_all(_t5_script, _t5_content, _t5_no_leftover),
    ),
]
