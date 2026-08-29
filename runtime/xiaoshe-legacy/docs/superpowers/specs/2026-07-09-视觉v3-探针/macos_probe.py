"""macOS 零依赖视觉回路探针——填 v2 唯一的结构性空洞（§8 macOS 全未验）。
逐条对称 v2 的 Windows §1 表：a11y树/截屏/OCR/PDF→PNG/渲染自验。全部系统自带工具，报真实毫秒。"""
import subprocess, time, os, shutil, tempfile, platform

def run(cmd, timeout=30, shell=False):
    t = time.perf_counter()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, shell=shell)
        ms = (time.perf_counter() - t) * 1000
        return p.returncode, p.stdout, p.stderr, ms
    except subprocess.TimeoutExpired:
        return -1, "", "TIMEOUT", (time.perf_counter()-t)*1000

TMP = tempfile.mkdtemp()
print(f"平台: {platform.platform()}\n")

# ① a11y 树：osascript + System Events 读 AXUIElement（对称 Windows UIA）
print("=== ① a11y 树 (osascript System Events) ===")
rc,out,err,ms = run(["osascript","-e",
  'tell application "System Events" to return count of (processes whose background only is false)'])
if rc==0:
    print(f"  ✅ 可见进程数={out.strip()}  {ms:.0f}ms")
    # 深一层：读最前台应用的 UI 元素树规模
    rc2,out2,err2,ms2 = run(["osascript","-e",
      'tell application "System Events" to tell (first process whose frontmost is true)\n'
      ' set n to count of (entire contents of window 1)\n return n\nend tell'], timeout=20)
    if rc2==0:
        print(f"  ✅ 前台窗口 UI 元素总数={out2.strip()}  {ms2:.0f}ms（对称 UIA 的 521 元素）")
    else:
        print(f"  ⚠ 深层元素树: {(err2 or out2).strip()[:80]}")
else:
    print(f"  ❌ 被拦: {(err or out).strip()[:120]}")
    print("     → 这是 macOS 的辅助功能授权门（v2 §8 完全没预见的部署坑）")

# ② 截屏（对称 System.Drawing CopyFromScreen）
print("\n=== ② 截屏 (screencapture -x) ===")
shot = os.path.join(TMP,"s.png")
rc,out,err,ms = run(["screencapture","-x",shot])
if rc==0 and os.path.exists(shot):
    rc2,dim,_,_ = run(["sips","-g","pixelWidth","-g","pixelHeight",shot])
    px = " ".join(l.split(":")[-1].strip() for l in dim.splitlines() if "pixel" in l)
    sz = os.path.getsize(shot)//1024
    print(f"  ✅ 截屏 {ms:.0f}ms  尺寸={px}px  {sz}KB")
    os.remove(shot)  # 立即删，不读像素、不外传（隐私）
else:
    print(f"  ❌ {(err or out).strip()[:100]}")

# ③ OCR：macOS 有无零依赖 CLI？（对症 v2 说的 Windows WinRT OCR 一行可调）
print("\n=== ③ OCR 零依赖可及性 (对比 Windows.Media.Ocr 一行可调) ===")
has_swift = shutil.which("swift")
has_shortcuts = shutil.which("shortcuts")
print(f"  swift 编译器: {'✅在' if has_swift else '❌无(需装 Xcode CLT)'}  | shortcuts CLI: {'✅在' if has_shortcuts else '❌无'}")
print("  → 结论：macOS Vision OCR 强，但无预装 CLI，须 swift 编译小助手或走 shortcuts；" +
      ("swift 在，可零安装编译" if has_swift else "不如 Windows PS 直调 WinRT 那么零门槛"))

# ④ PDF→PNG（对称 Windows.Data.Pdf）
print("\n=== ④ PDF→PNG (系统自带 textutil→qlmanage/sips) ===")
pdf = os.path.join(TMP,"t.pdf")
rc,out,err,ms = run(f'echo "hello 小蛇 视觉 probe" | textutil -stdin -convert pdf -stdout > {pdf}', shell=True)
if os.path.exists(pdf) and os.path.getsize(pdf)>0:
    print(f"  ✅ textutil 造 PDF {os.path.getsize(pdf)}B {ms:.0f}ms")
    rc2,o2,e2,ms2 = run(["qlmanage","-t","-s","1024",pdf,"-o",TMP])
    thumbs = [f for f in os.listdir(TMP) if f.endswith(".png")]
    print(f"  qlmanage 缩略图: {'✅ '+thumbs[0]+f' {ms2:.0f}ms' if thumbs else '❌ '+(e2 or o2).strip()[:60]}")
    rc3,o3,e3,ms3 = run(["sips","-s","format","png",pdf,"--out",os.path.join(TMP,"pdf.png")])
    print(f"  sips PDF→PNG: {'✅ '+f'{ms3:.0f}ms' if rc3==0 else '❌(v2说Ventura起坏，实测:'+(e3.strip()[:50])+')'}")
else:
    print(f"  ❌ textutil 造 PDF 失败: {(err or out).strip()[:80]}")

# ⑤ 渲染自验（对称 Edge --headless --screenshot）
print("\n=== ⑤ HTML 渲染自验 (Chrome/Edge --headless=new --screenshot) ===")
cands = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
         "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
         "/Applications/Chromium.app/Contents/MacOS/Chromium"]
browser = next((c for c in cands if os.path.exists(c)), None)
if browser:
    html = os.path.join(TMP,"t.html"); open(html,"w").write("<h1 style='color:teal'>小蛇视觉 render probe</h1>")
    png = os.path.join(TMP,"r.png")
    rc,out,err,ms = run([browser,"--headless=new",f"--screenshot={png}","--window-size=1280,800",
                         "--no-sandbox",f"file://{html}"], timeout=40)
    ok = os.path.exists(png) and os.path.getsize(png)>0
    print(f"  ✅ {os.path.basename(browser)} 渲染截图 {ms:.0f}ms {os.path.getsize(png)//1024 if ok else '?'}KB" if ok
          else f"  ⚠ {os.path.basename(browser)} 在但截图失败: {(err or out).strip()[:70]}")
else:
    print("  ❌ 无 Chrome/Edge/Chromium（Mac 上渲染自验需装浏览器，或走 Playwright MCP）")

shutil.rmtree(TMP, ignore_errors=True)
print("\n（临时文件已清）")
