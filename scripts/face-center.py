#!/usr/bin/env python3
# face-center.py: находит лицо в видео и возвращает нормализованный центр (0..1).
# Нужно, чтобы движок центрировал спикера в карточке (objectPosition).
# Использование: python3 face-center.py <video> -> печатает JSON {"x":..,"y":..,"found":bool}
import sys, json
import cv2

if len(sys.argv) < 2:
    print(json.dumps({"x": 0.5, "y": 0.5, "found": False})); sys.exit(0)

path = sys.argv[1]
cap = cv2.VideoCapture(path)
cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
step = max(1, total // 40)  # ~40 проб по всему ролику

xs, ys = [], []
i = 0
while True:
    ok, frame = cap.read()
    if not ok:
        break
    if i % step == 0:
        h, w = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
        if len(faces):
            x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
            xs.append((x + fw / 2) / w)
            ys.append((y + fh / 2) / h)
    i += 1
cap.release()

if not ys:
    print(json.dumps({"x": 0.5, "y": 0.5, "found": False})); sys.exit(0)

xs.sort(); ys.sort()
mx = xs[len(xs) // 2]
my = ys[len(ys) // 2]
print(json.dumps({"x": round(mx, 4), "y": round(my, 4), "found": True, "samples": len(ys)}))
