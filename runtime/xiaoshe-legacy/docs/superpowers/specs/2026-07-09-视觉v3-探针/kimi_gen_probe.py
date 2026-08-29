"""Kimi 代际+成本探针：对当前 coding 端点发多尺寸纯色图，读回真实 usage.prompt_tokens，
验证 v2 的图像 token 公式 ceil(W/28)*ceil(H/28)+4 在真实端点是否成立、模型自报身份、超大图是否被拒/降采样。"""
import base64, json, math, struct, sys, zlib
sys.path.insert(0, "/Users/example/Desktop/小蛇")
from harness import config, kimi_client

def solid_png(w, h, rgb=(40,120,200)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t,d):
        c=t+d; return struct.pack(">I",len(d))+c+struct.pack(">I",zlib.crc32(c)&0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB",w,h,8,2,0,0,0))
            + chunk(b"IDAT", zlib.compress(raw,6))
            + chunk(b"IEND", b""))

def predict(w,h):  # v2 公式
    return math.ceil(w/28)*math.ceil(h/28)+4

def probe(w, h, question="用一个词回答图里主色", want_id=False):
    b64 = base64.b64encode(solid_png(w,h)).decode()
    q = "你是什么模型？只回模型名。" if want_id else question
    payload = {"model": config.MODEL, "messages":[{"role":"user","content":[
        {"type":"text","text":q},
        {"type":"image_url","image_url":{"url":f"data:image/png;base64,{b64}"}}]}]}
    try:
        raw = kimi_client._post(payload, timeout=180, retry=0)
        usage = raw.get("usage") or {}
        pt = usage.get("prompt_tokens")
        content = (raw["choices"][0]["message"].get("content") or "").strip()[:40]
        pred = predict(w,h)
        line = f"{w}x{h}: prompt_tokens={pt}  v2公式预测={pred}  差={pt-pred if isinstance(pt,int) else '?'}  答:{content}"
        return line, (pt, pred)
    except kimi_client.KimiError as e:
        return f"{w}x{h}: ❌ {str(e)[:90]}", None

print(f"端点={config.BASE_URL if hasattr(config,'BASE_URL') else '?'}  模型={config.MODEL}\n")
print("=== 身份 ===")
print(probe(448,448, want_id=True)[0])
print("\n=== token 公式验证（v2: ceil(W/28)*ceil(H/28)+4）===")
for (w,h) in [(448,448),(1280,800),(1920,1080)]:
    print(probe(w,h)[0])
print("\n=== 超大图（验 v2 的 4096x2160 上限 / 是否服务端降采样）===")
print(probe(4096,2160)[0])
