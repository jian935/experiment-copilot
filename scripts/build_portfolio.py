#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 portfolio/source.html 构建成「单文件自包含」的作品集页：
视频与截图全部内联成 data URI，任意预览器/单文件分发都能正常播放。

    python scripts/build_portfolio.py
"""
import base64
import json
import os
import subprocess
import sys

import imageio_ffmpeg

FF = imageio_ffmpeg.get_ffmpeg_exe()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

SRC = 'portfolio/source.html'
OUT = 'portfolio/index.html'
ASSETS = 'portfolio/assets'
VIDEO = 'deliverables/video/Experiment-Copilot-演示.mp4'
SHOTS = [
    ('SHOT1', 'docs/screenshots/01-实验列表.png'),
    ('SHOT2', 'docs/screenshots/02-实验详情-护栏拦截.png'),
    ('SHOT3', 'docs/screenshots/03-证据链-逐步代入.png'),
    ('SHOT4', 'docs/screenshots/08-评测看板.png'),
    ('SHOT5', 'docs/screenshots/10-Agent-智能模式.png'),
    ('SHOT6', 'docs/screenshots/05-结论卡导出.png'),
]

LINKS = {
    'DEMO': 'https://jian935.github.io/experiment-copilot/',
    'GITHUB': 'https://github.com/jian935/experiment-copilot',
}
if os.path.exists('portfolio/links.json'):
    LINKS.update(json.load(open('portfolio/links.json', encoding='utf-8')))

os.makedirs(ASSETS, exist_ok=True)


def run(args):
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        sys.stderr.write(p.stderr.decode('utf-8', 'ignore')[-2000:])
        raise SystemExit('ffmpeg 失败')


# 1. 网页版小视频（960 宽，便于内联）
web_video = os.path.join(ASSETS, 'web.mp4')
run([FF, '-y', '-i', VIDEO, '-vf', 'scale=960:-2', '-c:v', 'libx264', '-preset', 'slow', '-crf', '30',
     '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '80k', '-movflags', '+faststart', web_video])

# 2. 封面帧
poster = os.path.join(ASSETS, 'poster.jpg')
run([FF, '-y', '-i', 'docs/screenshots/01-实验列表.png', '-vf', 'scale=960:-2', '-q:v', '4', poster])


def data_uri(path, mime):
    with open(path, 'rb') as f:
        return f'data:{mime};base64,' + base64.b64encode(f.read()).decode('ascii')


# 3. 截图压成 JPEG
shots = {}
for key, png in SHOTS:
    if not os.path.exists(png):
        raise SystemExit(f'缺少截图：{png}')
    tmp = os.path.join(ASSETS, os.path.basename(png).replace('.png', '.jpg'))
    # 内联进单文件的是 1600px 高清版（点击可全屏看细节；q:v 3 约等于 JPEG 88）
    run([FF, '-y', '-i', png, '-vf', 'scale=1600:-2', '-q:v', '3', tmp])
    shots[key] = tmp

html = open(SRC, encoding='utf-8').read()
html = html.replace('{{VIDEO}}', data_uri(web_video, 'video/mp4'))
html = html.replace('{{POSTER}}', data_uri(poster, 'image/jpeg'))
for k, p in shots.items():
    html = html.replace('{{' + k + '}}', data_uri(p, 'image/jpeg'))
for k, v in LINKS.items():
    html = html.replace('{{' + k + '}}', v)

assert '{{' not in html, '还有未替换的占位符：' + str([l for l in html.split('>') if '{{' in l][:3])

open(OUT, 'w', encoding='utf-8').write(html)
size = os.path.getsize(OUT)
print(f'构建完成：{OUT}（{size / 1024 / 1024:.2f} MB，视频 {os.path.getsize(web_video) / 1024 / 1024:.2f} MB 内联）')
