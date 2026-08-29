#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 扫描筛选目录，找出不符合 16:9/9:16/4:3/3:4/1:1 比例的视频
# 输出：完整清单到文件 + 按一级文件夹/比例汇总到 stdout
import os, subprocess
from collections import Counter, defaultdict

ROOT = '/Users/example/Desktop/视频编辑/对比结果/筛选'
OUT = os.path.join(ROOT, '不符合比例_视频清单.txt')
VIDEO_EXT = {'.mp4','.mov','.avi','.mkv','.webm','.flv','.wmv','.m4v','.mpg','.mpeg','.ts','.3gp','.rm','.rmvb','.mts','.m2ts','.m2v','.mpe','.vob','.asf','.ogv','.mxf','.f4v','.divx','.vid'}

MATCH = {16/9, 9/16, 4/3, 3/4, 1.0}
TOL = 0.02  # 2% 容差

def get_dim(p):
    try:
        w = subprocess.run(['mdls','-raw','-name','kMDItemPixelWidth',p], capture_output=True, text=True).stdout.strip()
        h = subprocess.run(['mdls','-raw','-name','kMDItemPixelHeight',p], capture_output=True, text=True).stdout.strip()
    except Exception:
        return None
    if not w or not h or 'null' in w or 'null' in h:
        return None
    try:
        return int(w), int(h)
    except:
        return None

unmatched = []
total = 0
nofile = 0
for d1 in sorted(os.listdir(ROOT)):
    p1 = os.path.join(ROOT, d1)
    if not os.path.isdir(p1):
        continue
    for d2 in sorted(os.listdir(p1)):
        p2 = os.path.join(p1, d2)
        if not os.path.isdir(p2):
            continue
        for name in sorted(os.listdir(p2)):
            full = os.path.join(p2, name)
            if not os.path.isfile(full):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in VIDEO_EXT:
                continue
            total += 1
            dim = get_dim(full)
            if dim is None:
                nofile += 1
                continue
            w, h = dim
            if w <= 0 or h <= 0:
                continue
            ratio = w / h
            matched = any(abs(ratio - m) <= TOL * m for m in MATCH)
            if not matched:
                unmatched.append((d1, full, w, h, ratio))

# 写完整清单
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('# 不符合比例的视频清单（目标比例:16:9 9:16 4:3 3:4 1:1，容差2%%）\n')
    f.write('# 共 %d 个\n\n' % len(unmatched))
    for d1, path, w, h, r in unmatched:
        f.write('%dx%d\tratio=%.4f\t%s\n' % (w, h, r, path))

# 按一级文件夹汇总
by_dir = Counter(d1 for d1, *_ in unmatched)
# 按比例分组（归类到最接近的常见比例标签）
def ratio_label(r):
    import math
    # 转成分数近似
    for num, den, name in [(3,2,'3:2'),(2,3,'2:3'),(3,5,'3:5'),(5,3,'5:3'),(1,2,'1:2'),(2,1,'2:1'),(3,4,'3:4'),(4,3,'4:3'),(10,7,'10:7'),(16,9,'16:9'),(9,16,'9:16'),(4,5,'4:5'),(5,4,'5:4'),(1,1,'1:1'),(11,12,'11:12'),(6,7,'6:7'),(7,8,'7:8'),(8,9,'8:9'),(9,10,'9:10')]:
        if abs(r - num/den) < 0.03:
            return name
    return 'other(%.3f)' % r

by_ratio = Counter(ratio_label(r) for *_d1, r in unmatched)

print('TOTAL_VIDEOS', total)
print('NO_DIMENSION', nofile)
print('UNMATCHED_TOTAL', len(unmatched))
print('===== 按一级文件夹 =====')
for d, c in by_dir.most_common():
    print('%-32s %d' % (d, c))
print('===== 按比例 =====')
for r, c in by_ratio.most_common():
    print('%-16s %d' % (r, c))
print('OUTPUT_FILE', OUT)
