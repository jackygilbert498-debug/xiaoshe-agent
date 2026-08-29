#!/bin/bash
# 扫描筛选目录下所有视频，输出不符合 16:9 / 9:16 / 4:3 / 3:4 / 1:1 比例的文件路径
# 用 python3 做比例判断（读 mdls 输出的宽高）

cd "/Users/example/Desktop/视频编辑/对比结果/筛选"

# 收集所有视频文件（所有常见格式），排除在子目录下的（只取 video 文件夹直下的，符合第二层结构）
all=$(find . -type d -name "video*" -exec sh -c 'find "$1" -maxdepth 1 -type f \( -iname "*.mp4" -o -iname "*.mov" -o -iname "*.avi" -o -iname "*.mkv" -o -iname "*.webm" -o -iname "*.flv" -o -iname "*.wmv" -o -iname "*.m4v" -o -iname "*.mpg" -o -iname "*.mpeg" -o -iname "*.ts" -o -iname "*.3gp" -o -iname "*.rm" -o -iname "*.rmvb" -o -iname "*.mts" -o -iname "*.m2ts" -o -iname "*.m2v" -o -iname "*.mpe" -o -iname "*.vob" -o -iname "*.asf" -o -iname "*.ogv" -o -iname "*.mxf" -o -iname "*.f4v" -o -iname "*.mts" -o -iname "*.divx" -o -iname "*.webm" -o -iname "*.vid" \)' sh {} + 2>/dev/null)

# 用 python 逐个读取 mdls 宽高并判断
python3 - "$all" <<'PYEOF'
import sys, subprocess, os

files = sys.argv[1:]
targets = []
mdls_errors = 0
no_md = 0

MATCH = {16/9, 9/16, 4/3, 3/4, 1.0}
TOL = 0.02  # 2% 容差

for f in files:
    try:
        w = subprocess.run(['mdls','-raw','-name','kMDItemPixelWidth',f], capture_output=True, text=True).stdout.strip()
        h = subprocess.run(['mdls','-raw','-name','kMDItemPixelHeight',f], capture_output=True, text=True).stdout.strip()
    except Exception as e:
        mdls_errors += 1
        continue
    if not w or not h or w == '(null)' or h == '(null)' or w == '(\n    null\n)' or h == '(\n    null\n)':
        no_md += 1
        continue
    try:
        w = int(w); h = int(h)
    except:
        targets.append((f, w, h, 'PARSE_ERR'))
        continue
    if w <= 0 or h <= 0:
        targets.append((f, w, h, 'ZERO'))
        continue
    ratio = w / h
    matched = False
    for m in MATCH:
        if abs(ratio - m) <= TOL * m:
            matched = True
            break
    if not matched:
        targets.append((f, w, h, round(ratio, 4)))

print('TOTAL_FILES', len(files))
print('MDLS_ERRORS', mdls_errors)
print('NO_DIMENSION', no_md)
print('UNMATCHED', len(targets))
print('===== UNMATCHED LIST =====')
for path, w, h, info in targets:
    print(f'{w}x{h}\t{info}\t{path}')
PYEOF