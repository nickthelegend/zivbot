"""Cut the recorded frames to the voiceover and burn in captions.

  python scripts/make-video.py <recDir> <script.json> <voDir> <out.mp4>

recDir holds frames/*.jpg and markers.json from desktop/scripts/record.cjs; voDir holds one
Chatterbox wav per script line (same ids as the scenes). Each scene is resampled to fit its
line plus a short breath, captions follow the words, and the audio is padded to match.
"""
import json, math, os, re, subprocess, sys, shutil
from PIL import Image, ImageDraw, ImageFont

rec, script_path, vo, out = sys.argv[1:5]
PAD = 1.3          # breath after each line
FPS = 15           # output frame rate (frames are resampled from the 10 fps recording)
W, H = 1440, 900

meta = json.load(open(os.path.join(rec, 'markers.json')))
marks = meta['markers']
frames = sorted(os.listdir(os.path.join(rec, 'frames')))
lines = {x['id']: x['text'] for x in json.load(open(script_path))}

def dur(path):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).strip())

def font(size, bold=False):
    for p in ['/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf']:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

CAP = font(30)
SMALL = font(20)

def chunks(text, max_words=9):
    words = text.split()
    out, cur = [], []
    for w in words:
        cur.append(w)
        if len(cur) >= max_words or (len(cur) >= 5 and re.search(r'[.,:;!?]$', w)):
            out.append(' '.join(cur)); cur = []
    if cur:
        out.append(' '.join(cur))
    return out

def caption(img, text):
    d = ImageDraw.Draw(img, 'RGBA')
    tw = d.textlength(text, font=CAP)
    x0, y0 = (W - tw) / 2 - 22, H - 104
    d.rounded_rectangle([x0, y0, x0 + tw + 44, y0 + 54], radius=14, fill=(10, 9, 8, 205))
    d.text(((W - tw) / 2, y0 + 10), text, font=CAP, fill=(246, 240, 232, 255))

def badge(img, text):
    d = ImageDraw.Draw(img, 'RGBA')
    tw = d.textlength(text, font=SMALL)
    d.rounded_rectangle([W - tw - 46, 18, W - 18, 52], radius=10, fill=(255, 138, 61, 230))
    d.text((W - tw - 32, 24), text, font=SMALL, fill=(20, 12, 6, 255))

work = os.path.join(rec, 'out-frames')
shutil.rmtree(work, ignore_errors=True)
os.makedirs(work)
k = 0
scene_durs = []
HERO = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'hero.jpg')
TITLE, SUB = font(64), font(28)

def card(lines_, seconds):
    """A still card (title / end) over the hero art, darkened."""
    global k
    base = Image.open(HERO).convert('RGB').resize((W, H))
    base = Image.blend(base, Image.new('RGB', (W, H), (10, 9, 8)), 0.55)
    d = ImageDraw.Draw(base)
    y = H / 2 - 40 * len(lines_)
    for text, f, col in lines_:
        tw = d.textlength(text, font=f)
        d.text(((W - tw) / 2, y), text, font=f, fill=col)
        y += f.size + 22
    for _ in range(round(seconds * FPS)):
        base.save(os.path.join(work, f'{k:06d}.jpg'), quality=92)
        k += 1
    return seconds

intro = card([('ZivBot', TITLE, (255, 255, 255)), ('Agents that act on connected data', SUB, (255, 200, 160)), ('FalkorDB Graph Hacks · Track 1', SUB, (220, 214, 206))], 3.0)
for i, m in enumerate(marks[:-1]):
    sid = m['id']
    if sid not in lines:
        continue
    a, b = m['frame'], marks[i + 1]['frame']
    src = frames[a:b] or frames[a:a + 1]
    speech = dur(os.path.join(vo, f'{sid}.wav'))
    T = speech + PAD
    n_out = max(1, round(T * FPS))
    caps = chunks(lines[sid])
    words = [len(c.split()) for c in caps]
    total_w = sum(words)
    # when each caption starts, in seconds from the scene start, proportional to its words
    starts, t = [], 0.0
    for wc in words:
        starts.append(t); t += speech * wc / total_w
    for j in range(n_out):
        f = src[min(len(src) - 1, math.floor(j * len(src) / n_out))]
        img = Image.open(os.path.join(rec, 'frames', f)).convert('RGB')
        if img.size != (W, H):
            img = img.resize((W, H))
        ts = j / FPS
        ci = max([c for c, s in enumerate(starts) if s <= ts] or [0])
        if ts <= speech + 0.2:
            caption(img, caps[ci])
        badge(img, 'Live app · real FalkorDB graph')
        img.save(os.path.join(work, f'{k:06d}.jpg'), quality=92)
        k += 1
    scene_durs.append((sid, n_out / FPS))
    print(sid, f'{len(src)} frames -> {n_out} ({n_out / FPS:.1f}s, speech {speech:.1f}s)', flush=True)

outro = card([('Try it live: zivbot.vercel.app', SUB, (255, 255, 255)), ('github.com/nickthelegend/zivbot', SUB, (255, 200, 160)), ('Built on FalkorDB · one graph per user · MCP', SUB, (220, 214, 206))], 5.0)

# audio: silence under the title, each line padded to its scene length, silence under the end card
inputs, filters = ['-f', 'lavfi', '-t', f'{intro:.3f}', '-i', 'anullsrc=r=48000:cl=stereo'], ['[0:a]anull[a0]']
for idx, (sid, d) in enumerate(scene_durs, start=1):
    inputs += ['-i', os.path.join(vo, f'{sid}.wav')]
    filters.append(f'[{idx}:a]aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur={d:.3f}[a{idx}]')
last = len(scene_durs) + 1
inputs += ['-f', 'lavfi', '-t', f'{outro:.3f}', '-i', 'anullsrc=r=48000:cl=stereo']
filters.append(f'[{last}:a]anull[a{last}]')
concat = ''.join(f'[a{i}]' for i in range(last + 1)) + f'concat=n={last + 1}:v=0:a=1[aout]'
audio = os.path.join(rec, 'voice.m4a')
subprocess.check_call(['ffmpeg', '-y', '-v', 'error', *inputs, '-filter_complex', ';'.join(filters) + ';' + concat, '-map', '[aout]', '-c:a', 'aac', '-b:a', '160k', audio])
subprocess.check_call(['ffmpeg', '-y', '-v', 'error', '-framerate', str(FPS), '-i', os.path.join(work, '%06d.jpg'), '-i', audio,
                       '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', out])
print('wrote', out, f'{intro + sum(d for _, d in scene_durs) + outro:.1f}s')
