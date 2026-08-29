"""macOS PDF→PNG 零依赖多路探针——堵 v3 最后一个"待补"洞。
先用系统自带手段造一个真 PDF，再对它试 qlmanage / sips / JXA-PDFKit 三条渲染路，报真实毫秒+产物尺寸。"""
import subprocess, time, os, tempfile, glob

def run(cmd, timeout=40, shell=False):
    t = time.perf_counter()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, shell=shell)
        return p.returncode, p.stdout, p.stderr, (time.perf_counter()-t)*1000
    except subprocess.TimeoutExpired:
        return -1, "", "TIMEOUT", (time.perf_counter()-t)*1000

def dims(png):
    if not (os.path.exists(png) and os.path.getsize(png)>0): return None
    rc,out,_,_ = run(["sips","-g","pixelWidth","-g","pixelHeight",png])
    px = "x".join(l.split(":")[-1].strip() for l in out.splitlines() if "pixel" in l)
    return f"{px} {os.path.getsize(png)//1024}KB"

TMP = tempfile.mkdtemp()
pdf = os.path.join(TMP, "src.pdf")

# —— 造真 PDF：三条系统自带手段依次试，谁成用谁 ——
print("=== 造测试 PDF（系统自带手段）===")
made = False
# 路1: cupsfilter（把文本经 CUPS 管线转 PDF，macOS 自带打印系统）
txt = os.path.join(TMP,"a.txt"); open(txt,"w").write("小蛇视觉 v3 · PDF probe\nHello 中文 world 123\n第二行内容\n")
rc,out,err,ms = run(f'cupsfilter "{txt}" > "{pdf}" 2>/dev/null', shell=True)
if os.path.exists(pdf) and os.path.getsize(pdf)>200:
    print(f"  ✅ cupsfilter 造 PDF {os.path.getsize(pdf)}B {ms:.0f}ms"); made=True
if not made:
    # 路2: JXA + PDFKit 直接写一页 PDF
    jxa = r'''ObjC.import("PDFKit");ObjC.import("AppKit");
var page=$.PDFPage.alloc.init;var doc=$.PDFDocument.alloc.init;doc.insertPageAtIndex(page,0);
doc.writeToFile($("%s"));''' % pdf
    rc,out,err,ms = run(["osascript","-l","JavaScript","-e",jxa])
    if os.path.exists(pdf) and os.path.getsize(pdf)>200:
        print(f"  ✅ JXA-PDFKit 造 PDF {os.path.getsize(pdf)}B {ms:.0f}ms"); made=True
    else:
        print(f"  ❌ JXA 造 PDF 也失败: {(err or out).strip()[:80]}")
if not made:
    print("  ⛔ 无法用系统自带手段造 PDF，后续渲染探针跳过"); raise SystemExit

# —— 三条渲染路 ——
print("\n=== PDF→PNG 三路渲染 ===")

# A. qlmanage -t（Quick Look 缩略图，系统自带）
for f in glob.glob(f"{TMP}/*.png"): os.remove(f)
rc,out,err,ms = run(["qlmanage","-t","-s","1024",pdf,"-o",TMP])
pngs = [f for f in glob.glob(f"{TMP}/src.pdf.png")] or glob.glob(f"{TMP}/*.png")
print(f"  A) qlmanage -t: {'✅ '+dims(pngs[0])+f'  {ms:.0f}ms' if pngs else '❌ '+(err or out).strip()[:70]}")

# B. sips 直接转（v2 说"Ventura 起坏"，真机验一下到底坏不坏）
outB = os.path.join(TMP,"sips.png")
rc,out,err,ms = run(["sips","-s","format","png",pdf,"--out",outB])
d = dims(outB)
print(f"  B) sips PDF→PNG: {'✅ '+d+f'  {ms:.0f}ms（v2说的\"Ventura坏\"在本机不成立）' if d else '❌ '+(err.strip()[:70])+' → v2说法成立'}")

# C. JXA + PDFKit 逐页渲染（可控 DPI，最像 Windows.Data.Pdf 的对称路）
outC = os.path.join(TMP,"pdfkit.png")
jxa = r'''ObjC.import("PDFKit");ObjC.import("AppKit");ObjC.import("Foundation");
var url=$.NSURL.fileURLWithPath($("%s"));var doc=$.PDFDocument.alloc.initWithURL(url);
if(doc.pageCount>0){var pg=doc.pageAtIndex(0);
var r=pg.boundsForBox($.kPDFDisplayBoxMediaBox);var scale=2.0;
var w=Math.round(r.size.width*scale),h=Math.round(r.size.height*scale);
var img=$.NSImage.alloc.initWithSize({width:w,height:h});img.lockFocus;
var ctx=$.NSGraphicsContext.currentContext;var t=ctx.CGContext;
$.CGContextScaleCTM(t,scale,scale);pg.drawWithBox($.kPDFDisplayBoxMediaBox,t);
img.unlockFocus;var tiff=img.TIFFRepresentation;
var rep=$.NSBitmapImageRep.imageRepWithData(tiff);
var png=rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG,$());
png.writeToFile($("%s"),true);"OK "+w+"x"+h;}else{"NOPAGE";}''' % (pdf, outC)
rc,out,err,ms = run(["osascript","-l","JavaScript","-e",jxa])
d = dims(outC)
print(f"  C) JXA-PDFKit 逐页渲染: {'✅ '+d+f'  {ms:.0f}ms（可控DPI，最对称 Windows.Data.Pdf）' if d else '❌ '+(err or out).strip()[:90]}")

import shutil; shutil.rmtree(TMP, ignore_errors=True)
print("\n=== 结论：至少一条✅ = macOS PDF 腿补实，v3 零'待补' ===")
