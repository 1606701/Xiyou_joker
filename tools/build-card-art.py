#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把生图产出的方图，处理成能直接铺在 .card 上的卡面立绘。

做四件事：
1. 按文件名里的角色名认出这是哪张牌 —— 生成接口的文件名不可控，只能靠关键字，
   所以匹配顺序不能随便调：「六耳猕猴_假孙悟空」必须排在「孙悟空」之前，
   否则孙悟空会把六耳猕猴的图抢走。
2. 裁掉底部 —— 生成平台会在右下角烙「AI生成 WORKBUDDY」水印，位置固定在
   最后约 80px 内，先切掉再谈构图。
3. 按卡片真实的 5:7 比例做水平居中裁切 —— 让「看到的就是显示的」。
   .card 是 aspect-ratio: 5/7，用 background-size:cover 时源图比例不匹配
   就会被随意裁，肉眼对不上实际效果，改起来全靠猜。
4. 量化成调色板 PNG —— 立绘是大色块平涂，96 色足够，体积压到原来的 1/40。

原始大图放 art-src/（不进 public/），因为 public/ 下的东西会被浏览器直接下载，
原图对局域网对局毫无意义。art-src 存的是 JPEG q92：保留重新裁剪的余地，
但不必让仓库背 19MB 的 PNG。

用法：
  python tools/build-card-art.py            # 默认 art-src -> public/art/cards
  python tools/build-card-art.py --report   # 额外打印体积汇总
"""
import os
import shutil
import sys
from PIL import Image

# 卡片显示 60x84 CSS px；4 倍够覆盖高密度屏，再大纯属浪费带宽
OUT_W, OUT_H = 240, 336
# 水印高度：1024 版图上约 80px，取 9% 留点余量（宁可多切不可漏切）
TRIM_BOTTOM_RATIO = 0.09

SRC_DIR = 'art-src'
DST_DIR = os.path.join('public', 'art', 'cards')

# 关键字 -> 牌点。顺序敏感：长的、更具体的放前面。
RANK_BY_KEYWORD = [
    # 功能牌用「法宝」充当牌面：跳过＝紫金红葫芦（叫名就应，应声入袋→这一手作废），
    # 反转＝芭蕉扇（一扇风向就掉个个儿）。顺序敏感：更具体的放前面。
    ('紫金红葫芦', 'A'),
    ('芭蕉扇', '2'),
    ('六耳猕猴', 'SJ'),
    ('金翅大鹏', 'BJ'),
    ('孙悟空', '5'),
    ('沙僧', '3'),
    ('八戒', '8'),
    ('唐僧', '10'),
    ('小妖', '4'),
    ('黑熊精', '6'),
    ('黄风怪', '7'),
    ('白骨精', '9'),
    ('红孩儿', 'J'),
    ('牛魔王', 'Q'),
    ('青牛精', 'K'),
]


def rank_of(filename):
    for kw, rank in RANK_BY_KEYWORD:
        if kw in filename:
            return rank
    return None


def process(src_path, dst_path):
    im = Image.open(src_path).convert('RGB')
    w, h = im.size

    # 1) 切掉水印
    keep_h = int(h * (1 - TRIM_BOTTOM_RATIO))
    im = im.crop((0, 0, w, keep_h))

    # 2) 居中裁到 5:7
    target_ratio = float(OUT_W) / OUT_H
    cw, ch = im.size
    if cw / float(ch) > target_ratio:
        new_w = int(ch * target_ratio)
        left = (cw - new_w) // 2
        im = im.crop((left, 0, left + new_w, ch))
    else:
        new_h = int(cw / target_ratio)
        im = im.crop((0, 0, cw, new_h))

    # 3) 缩放 + 调色板量化
    im = im.resize((OUT_W, OUT_H), Image.LANCZOS)
    im = im.convert('P', palette=Image.ADAPTIVE, colors=96)
    im.save(dst_path, 'PNG', optimize=True)
    return os.path.getsize(dst_path)


def main():
    # 允许显式指定源/目的目录：视觉验证时可以把成品先落到临时目录，
    # 不污染 public/art/cards（那里有「孤儿图」断言盯着）。
    positional = [a for a in sys.argv[1:] if not a.startswith('--')]
    src_dir = positional[0] if positional else SRC_DIR
    dst_dir = positional[1] if len(positional) > 1 else DST_DIR
    report = '--report' in sys.argv

    if not os.path.isdir(src_dir):
        print('源目录不存在: %s（原始大图应放在仓库根目录的 art-src/ 下）' % src_dir)
        return 1
    os.makedirs(dst_dir, exist_ok=True)

    files = [f for f in sorted(os.listdir(src_dir))
             if f.lower().endswith(('.png', '.jpg', '.jpeg'))
             and os.path.isfile(os.path.join(src_dir, f))]
    if not files:
        print('art-src/ 里没有图片')
        return 1

    total = 0
    done = {}
    for f in files:
        rank = rank_of(f)
        if not rank:
            print('  [跳过] 认不出角色名: %s' % f)
            continue
        if rank in done:
            print('  [跳过] 牌点 %s 已由 %s 占用（本条: %s）' % (rank, done[rank], f))
            continue
        done[rank] = f
        dst = os.path.join(dst_dir, '%s.png' % rank)
        size = process(os.path.join(src_dir, f), dst)
        total += size
        print('  %-3s <- %-52s %6.1f KB' % (rank, f[:50], size / 1024.0))

    missing = [r for _, r in RANK_BY_KEYWORD if r not in done]
    print('\n共 %d 张，合计 %.1f KB' % (len(done), total / 1024.0))
    if missing:
        print('缺牌点: %s' % ', '.join(missing))
        return 2
    if report:
        print('平均 %.1f KB/张 —— %d 张全量首屏约 %.1f KB，可接受' % (
            total / 1024.0 / len(done), len(done), total / 1024.0))
    return 0


if __name__ == '__main__':
    sys.exit(main())
