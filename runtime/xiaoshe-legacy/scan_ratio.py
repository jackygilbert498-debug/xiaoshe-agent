#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 扫描筛选目录所有二级 video 文件夹下的视频，判断比例是否匹配 16:9/9:16/4:3/3:4/1:1
# 用 mdls 取宽高（subprocess 列表传参，正确处理带空格/括号的文件名）
import os, subprocess

ROOT = '/Users/example/Desktop/视频编辑/对比结果/筛选'
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

# 只统计"一级文件夹/二级文件夹"两层：遍历 ROOT 下的一级目录，再遍历其二级目录
# 二级目录名为 video / video1 等
unmatched = []
total = 0
nofile = 0
err = 0
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
                err += 1
                continue
            ratio = w / h
            matched = any(abs(ratio - m) <= TOL * m for m in MATCH)
            if not matched:
                unmatched.append((full, w, h, round(ratio,4)))

print('TOTAL_VIDEOS', total)
print('NO_DIMENSION', nofile)
print('BAD_DIM', err)
print('UNMATCHED', len(unmatched))
print('===== UNMATCHED LIST =====')
for path, w, h, r in unmatched:
    print('%dx%d\tratio=%.4f\t%s' % (w, h, r, path))
