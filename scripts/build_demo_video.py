#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 record_demo.mjs 录下的真实操作帧，合成为带旁白与字幕的演示视频。

时序原则：视频保持真实操作节奏（用 CDP 帧时间戳重采样到 30fps），
旁白按每个片段的时长裁剪/微加速，绝不为了配音去拉长画面。

    python scripts/build_demo_video.py
"""
import json
import os
import subprocess
import sys

import edge_tts
import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

FF = imageio_ffmpeg.get_ffmpeg_exe()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

VDIR = 'deliverables/video'
FRAMES = os.path.join(VDIR, 'frames')
WORK = os.path.join(VDIR, 'build')
OUT = os.path.join(VDIR, 'Experiment-Copilot-演示.mp4')
FONT = 'C:/Windows/Fonts/msyh.ttc'
FONT_B = 'C:/Windows/Fonts/msyhbd.ttc'
VOICE = 'zh-CN-YunxiNeural'
W, H, FPS = 1280, 720, 30

# 片段旁白：必须能在该片段时长内说完（超时会自动加速，最多 1.4x）
NARRATION = {
    's1_list': '一百二十个实验，每个都有结论，也都有证据。',
    's2_srm': '分流不均的，先拒绝下结论。',
    's3_guardrail': '主指标涨了，但退款率恶化，所以不能上。',
    's4_evidence': '每条证据都能展开，看公式和代入的数字。',
    's5_calc': '计算过程全摊开，能手算核对。',
    's6_loss': '显不显著，和值不值得上，是两件事。',
    's7_compare': '两次实验放在同一条横轴上，线长就是不确定性。',
    's8_palette': '命令面板，搜编号直达。',
    's9_eval': '准确率九十三点三，失败案例也照实列出。',
}
TITLE_LINE = '一个 A/B 实验，到底能不能上线？'
END_LINE = 'Experiment Copilot · 实验结论官'
TITLE_SEC = 3.0
END_SEC = 3.4
SUBTITLE = {
    's1_list': '120 个实验，每个都有结论和证据',
    's2_srm': '分流不均的实验，先拒绝下结论',
    's3_guardrail': '主指标涨了，但退款率恶化 → 不能上',
    's4_evidence': '每条证据都能展开：公式 + 代入的数字',
    's5_calc': '计算过程摊开，可手算核对、可一键复算',
    's6_loss': '「显不显著」和「值不值得上」是两件事',
    's7_compare': '两次实验共用一条横轴，线长即不确定性',
    's8_palette': 'Ctrl+K 全局搜索，搜编号直达',
    's9_eval': '准确率 93.3%，失败案例照实列出',
}

os.makedirs(WORK, exist_ok=True)


def run(args, **kw):
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kw)
    if p.returncode != 0:
        sys.stderr.write(p.stderr.decode('utf-8', 'ignore')[-2500:])
        raise SystemExit(f'命令失败：{args[0]}')
    return p


def duration_of(path):
    # ffmpeg 只「看一眼」必然返回非 0，这里不能用 run()
    p = subprocess.run([FF, '-hide_banner', '-i', path], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    for line in p.stderr.decode('utf-8', 'ignore').splitlines():
        if 'Duration:' in line:
            t = line.split('Duration:')[1].split(',')[0].strip()
            h, m, s = t.split(':')
            return int(h) * 3600 + int(m) * 60 + float(s)
    return 0.0


# ---------- 1. 标题卡 / 尾卡 ----------
def make_card(path, lines, tone='#f97316'):
    """白底 + 暖橙点缀，和应用的浅色主题保持一致"""
    img = Image.new('RGB', (W, H), '#fffdf9')
    d = ImageDraw.Draw(img)
    for x in range(0, W, 44):
        d.line([(x, 0), (x, H)], fill='#f6efe7')
    for y in range(0, H, 44):
        d.line([(0, y), (W, y)], fill='#f6efe7')

    d.rounded_rectangle([W // 2 - 26, 214, W // 2 + 26, 266], radius=14, fill='#fff7ed', outline=tone, width=2)
    d.line([(W // 2 - 12, 248), (W // 2 - 4, 238), (W // 2 + 3, 243), (W // 2 + 13, 228)], fill=tone, width=4)

    f1 = ImageFont.truetype(FONT_B, 54)
    f2 = ImageFont.truetype(FONT, 24)
    d.text((W // 2, 340), lines[0], font=f1, fill='#241a12', anchor='mm')
    d.text((W // 2, 404), lines[1], font=f2, fill='#6f5f50', anchor='mm')
    f3 = ImageFont.truetype(FONT, 17)
    d.text((W // 2, 470), lines[2], font=f3, fill='#c2410c', anchor='mm')
    img.save(path, 'JPEG', quality=94)


title_jpg = os.path.join(WORK, 'title.jpg')
end_jpg = os.path.join(WORK, 'end.jpg')
make_card(title_jpg, ['Experiment Copilot', '实验结论官 · 可复算的实验决策', '不让模型算数，每个结论都能点开核对'])
make_card(end_jpg, ['每个结论都能点开核对', 'Experiment Copilot · 实验结论官', '作者：jian935'], tone='#f97316')

# ---------- 2. 用帧时间戳拼出真实时序的视频 ----------
marks = json.load(open(os.path.join(VDIR, 'marks.json'), encoding='utf-8'))
frames = json.load(open(os.path.join(VDIR, 'frames.json'), encoding='utf-8'))
ts = frames['timestamps']
total = marks['duration']

# 按时间戳重采样成严格 30fps 的序列：每个输出帧取「时间戳 <= 当前时刻」的最后一帧。
# 不用 concat demuxer 的 duration，因为它对图片的时长处理会漂移（实测多出 4.5s）。
import bisect
import shutil

SEQ = os.path.join(WORK, 'seq')
shutil.rmtree(SEQ, ignore_errors=True)
os.makedirs(SEQ, exist_ok=True)

n_out = int(round(total * FPS))
for k in range(n_out):
    t = k / FPS
    idx = bisect.bisect_right(ts, t + 1e-9) - 1
    idx = max(0, min(idx, len(ts) - 1))
    src = os.path.abspath(os.path.join(FRAMES, 'f%06d.jpg' % idx))
    dst = os.path.join(SEQ, 's%06d.jpg' % k)
    try:
        os.link(src, dst)          # 硬链接，不复制 25MB
    except OSError:
        shutil.copyfile(src, dst)

body = os.path.join(WORK, 'body.mp4')
run([FF, '-y', '-framerate', str(FPS), '-i', os.path.join(SEQ, 's%06d.jpg'),
     '-vf', f'scale={W}:{H}:flags=lanczos,setsar=1',
     '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
     '-r', str(FPS), '-vsync', 'cfr', body])

# 标题 + 正文 + 尾卡（同参数编码后 concat）
def encode_still(src, dst, sec):
    run([FF, '-y', '-loop', '1', '-i', src, '-t', str(sec),
         '-vf', f'fps={FPS},scale={W}:{H},setsar=1', '-c:v', 'libx264',
         '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', dst])


title_mp4 = os.path.join(WORK, 'title.mp4')
end_mp4 = os.path.join(WORK, 'end.mp4')
encode_still(title_jpg, title_mp4, TITLE_SEC)
encode_still(end_jpg, end_mp4, END_SEC)

silent = os.path.join(WORK, 'silent.mp4')
lst = os.path.join(WORK, 'parts.txt')
with open(lst, 'w', encoding='utf-8') as f:
    for p in (title_mp4, body, end_mp4):
        f.write("file '%s'\n" % os.path.abspath(p).replace(os.sep, '/'))
run([FF, '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', silent])

# ---------- 3. 每个片段的旁白（按时长裁剪/加速） ----------
slots = [('title', 0.0, TITLE_SEC, TITLE_LINE)]
offset = TITLE_SEC
for m in marks['marks']:
    slots.append((m['name'], offset, offset + (m['end'] - m['start']), NARRATION.get(m['name'], '')))
    offset += m['end'] - m['start']
slots.append(('end', offset, offset + END_SEC, ''))

audio_dir = os.path.join(WORK, 'audio')
os.makedirs(audio_dir, exist_ok=True)
parts, subs, cursor = [], [], 0.0

for name, start, end, line in slots:
    slot = round(end - start, 3)
    if not line:
        sil = os.path.join(audio_dir, f'{name}.wav')
        run([FF, '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', f'{slot:.3f}',
             '-c:a', 'pcm_s16le', sil])
        parts.append(sil)
        cursor += slot
        continue

    mp3 = os.path.join(audio_dir, f'{name}.mp3')
    async def tts(text=line, path=mp3):
        await edge_tts.Communicate(text, VOICE).save(path)
    import asyncio
    asyncio.run(tts())

    d = duration_of(mp3)
    tempo = 1.0
    if d > slot - 0.05:
        tempo = min(1.4, d / max(0.5, slot - 0.15))
    chain = f'atempo={tempo:.3f},apad' if tempo > 1.001 else 'apad'
    wav = os.path.join(audio_dir, f'{name}.wav')
    run([FF, '-y', '-i', mp3, '-af', chain, '-t', f'{slot:.3f}',
         '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
    parts.append(wav)
    subs.append((cursor, cursor + slot - 0.15, SUBTITLE.get(name, line)))
    cursor += slot

narration = os.path.join(WORK, 'narration.wav')
lst2 = os.path.join(WORK, 'audio.txt')
with open(lst2, 'w', encoding='utf-8') as f:
    for p in parts:
        f.write("file '%s'\n" % os.path.abspath(p).replace(os.sep, '/'))
run([FF, '-y', '-f', 'concat', '-safe', '0', '-i', lst2, '-ar', '24000', '-ac', '1', narration])

# ---------- 4. 字幕（ASS） ----------
def ass_time(t):
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f'{h}:{m:02d}:{s:05.2f}'


ass = os.path.join(WORK, 'subs.ass')
with open(ass, 'w', encoding='utf-8') as f:
    f.write('[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\n\n')
    f.write('[V4+ Styles]\n')
    f.write('Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, '
            'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n')
    # ASS 颜色是 &HAABBGGRR。用「深棕字 + 白色粗描边」而不是透明底框：
    # BorderStyle=3 的底框在 libass 下颜色不受控（实测底框没画出来，字幕直接压在表格上读不清），
    # 而描边在各种底色上都稳——界面是浅色、偶尔压到深色图表上也能读。
    f.write('Style: Sub,微软雅黑,29,&H00121A24,&H78FFFFFF,&H78FFFFFF,0,0,3,9,0,2,80,80,44,1\n\n')
    f.write('[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n')
    for a, b, text in subs:
        f.write(f'Dialogue: 0,{ass_time(a)},{ass_time(b)},Sub,,0,0,0,,{text}\n')

# ---------- 5. 合成 ----------
run([FF, '-y', '-i', silent, '-i', narration,
     '-vf', f'ass={ass.replace(os.sep, "/")}',
     '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
     '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', OUT])

print(f'成片：{OUT}')
print(f'时长 {duration_of(OUT):.2f}s ｜ 帧 {len(ts)} 张 ｜ 旁白 {len(subs)} 句')
