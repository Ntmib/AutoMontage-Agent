#!/usr/bin/env python3
# Фаза 3.1 — авто-reframe: горизонт → вертикаль 9:16 с кропом по лицу.
#   python3 reframe.py <in.mp4> <out.mp4> [--mode static|track] [--ar 9:16] [--out-h 1920]
import sys, subprocess, statistics

def opt(k, d):
    return sys.argv[sys.argv.index(k)+1] if k in sys.argv else d

inp, out = sys.argv[1], sys.argv[2]
mode = opt('--mode', 'track')
ar = opt('--ar', '9:16'); arw, arh = map(int, ar.split(':'))
out_h = int(opt('--out-h', '1920'))

import cv2, numpy as np
cap = cv2.VideoCapture(inp)
W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
fps = cap.get(cv2.CAP_PROP_FPS) or 25
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
dur = total / fps

# целевой кроп: высота = вся H, ширина = H*arw/arh
cropH = H
cropW = int(round(H * arw / arh))
if cropW > W:  # исходник уже уже целевого — апскейл center
    cropW = W

# OpenCV Haar-детектор лица (надёжно, без mediapipe API-разнобоя)
cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

# семплируем ~ каждые 0.4с; детект на уменьшенном кадре (быстро), координаты назад
samples = []  # (t, cx_px)
step = max(1, int(fps * 0.4))
sc = 640.0 / W                # downscale для детекции
idx = 0
while True:
    ok = cap.grab()           # последовательно, без дорогого seek
    if not ok:
        break
    if idx % step == 0:
        ok, frame = cap.retrieve()
        if not ok:
            break
        small = cv2.resize(frame, (0, 0), fx=sc, fy=sc)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
        if len(faces):
            x, y, w, h = max(faces, key=lambda f: f[2])
            samples.append((idx / fps, (x + w / 2) / sc))
    idx += 1
cap.release()

clampx = lambda x: max(0, min(W - cropW, int(round(x - cropW / 2))))

if not samples:
    print('лицо не найдено → center-crop')
    xexpr = str((W - cropW) // 2)
elif mode == 'static' or len(samples) < 3:
    med = statistics.median([c for _, c in samples])
    print(f'static: центр лица x={med:.0f}px, кроп {cropW}x{cropH}')
    xexpr = str(clampx(med))
else:
    # сглаживание траектории + прореживание до keyframes ~каждые 1.2с
    ts = [t for t, _ in samples]; xs = [c for _, c in samples]
    # скользящее среднее окном 5
    sm = []
    for k in range(len(xs)):
        a = max(0, k-2); b = min(len(xs), k+3)
        sm.append(sum(xs[a:b]) / (b - a))
    keys = []
    last_t = -10
    for t, x in zip(ts, sm):
        if t - last_t >= 1.2:
            keys.append((t, clampx(x))); last_t = t
    if keys[-1][0] < dur - 0.5:
        keys.append((dur, clampx(sm[-1])))
    print(f'track: {len(keys)} keyframes, кроп {cropW}x{cropH}')
    # кусочно-линейное выражение x(t) для ffmpeg crop, строим справа-налево
    expr = str(keys[-1][1])
    for (t0, x0), (t1, x1) in reversed(list(zip(keys, keys[1:]))):
        span = max(0.001, t1 - t0)
        lerp = f'({x0}+({x1}-{x0})*(t-{t0:.3f})/{span:.3f})'
        expr = f'if(lt(t\\,{t1:.3f})\\,{lerp}\\,{expr})'
    xexpr = expr

vf = f"crop={cropW}:{cropH}:{xexpr}:0,scale={int(out_h*arw/arh)}:{out_h}:flags=lanczos"
subprocess.run(
    ['ffmpeg', '-y', '-i', inp, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast',
     '-crf', '20', '-c:a', 'copy', '-movflags', '+faststart', out],
    check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(f'✅ {out}  ({int(out_h*arw/arh)}x{out_h})')
