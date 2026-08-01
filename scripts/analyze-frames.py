#!/usr/bin/env python3
# analyze-frames.py — анализ говорящей головы → адаптивные позиции акцентных плашек.
#
# КЛЮЧЕВОЕ (fix «плашка налазит на лицо»): лицо проверяется НЕ в один момент, а на
# ВСЁМ интервале показа плашки [start..end]. По интервалу сэмплится несколько
# кадров, берётся ОБЪЕДИНЕНИЕ (union) прямоугольников лица — «опасная зона лица».
# Затем для каждой стороны считается bbox плашки и проверяется пересечение с этой
# зоной. Выбирается сторона с НУЛЕВЫМ перекрытием; если все пересекаются — берётся
# минимальное перекрытие и плашка уводится дальше от лица.
#
# Использование:
#   python3 analyze-frames.py <video.mp4> --intervals "1.2-4.0,9.5-13.5,25-28"
#   python3 analyze-frames.py <video.mp4> --slots "3,11,19"      # старый режим (точка)
#   python3 analyze-frames.py <video.mp4> --interval 8           # авто каждые N сек
#
# Опции:
#   --intervals "a-b,c-d" — интервалы показа плашек (сек). ПРЕДПОЧТИТЕЛЬНО.
#   --slots "t1,t2,..."   — точки (совместимость); каждая = интервал [t, t+3]
#   --interval N          — плашка каждые N сек (авто-генерация интервалов N сек)
#   --samples K           — кадров на интервал для проверки лица (по умолч. 6)
#   --out path.json       — куда писать placement.json
#
# Вывод: placement.json = [{start, end, pos, x, y, side, textColor, collision, faceMoves}].
#
# Детекция лица: OpenCV Haar cascade (frontalface) — надёжный фолбэк (в mediapipe 1.0
# legacy solutions-API удалён).

import sys
import json

import cv2
import numpy as np


# --- safe-zones (доли кадра, куда плашку ставить НЕЛЬЗЯ) -----------------------
SAFE_TOP = 0.15      # верхние 15% (заголовки/прогресс-бар)
SAFE_BOTTOM = 0.25   # нижние 25% (субтитры, кнопки)
SAFE_RIGHT = 0.12    # правые 12% (лайк/шер/подписка)
SAFE_LEFT = 0.04

# запас вокруг лица (доля ширины кадра) — плашка не должна подходить ближе
FACE_MARGIN = 0.03


def get_opt(key, default=None):
    if key in sys.argv:
        i = sys.argv.index(key)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def build_intervals(dur):
    """Список (start, end) из --intervals / --slots / --interval."""
    iv = get_opt('--intervals')
    slots_arg = get_opt('--slots')
    interval_arg = get_opt('--interval')

    out = []
    if iv:
        for part in iv.split(','):
            part = part.strip()
            if not part:
                continue
            a, b = part.split('-')
            out.append((float(a), float(b)))
    elif slots_arg:
        for s in slots_arg.split(','):
            if s.strip():
                t = float(s)
                out.append((t, t + 3.0))
    elif interval_arg:
        n = float(interval_arg)
        t = n
        while t < dur:
            out.append((t, min(t + n, dur)))
            t += n
    else:
        raise SystemExit('нужен --intervals "a-b,c-d" | --slots "t1,t2" | --interval N')

    # клип по длительности
    return [(max(0, a), min(dur, b)) for a, b in out if a < dur and b > a]


def detect_face(frame, cascade):
    """Крупнейшее лицо → (x0, y0, x1, y1) в пикселях кадра, или None."""
    H, W = frame.shape[:2]
    sc = 640.0 / W
    small = cv2.resize(frame, (0, 0), fx=sc, fy=sc)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5,
                                     minSize=(30, 30))
    if len(faces) == 0:
        return None
    x, y, w, h = max(faces, key=lambda f: f[2])
    x0, y0, x1, y1 = x / sc, y / sc, (x + w) / sc, (y + h) / sc
    return (x0, y0, x1, y1)


def face_union(cap, cascade, start, end, samples, W, H):
    """
    Сэмплит `samples` кадров на [start..end], возвращает объединённый bbox лица
    (x0,y0,x1,y1) в пикселях + флаг движения. None если лицо ни разу не найдено.
    """
    ts = np.linspace(start, end, max(2, samples))
    boxes = []
    for t in ts:
        cap.set(cv2.CAP_PROP_POS_MSEC, float(t) * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        f = detect_face(frame, cascade)
        if f:
            boxes.append(f)
    if not boxes:
        return None, False
    xs0 = min(b[0] for b in boxes); ys0 = min(b[1] for b in boxes)
    xs1 = max(b[2] for b in boxes); ys1 = max(b[3] for b in boxes)
    # движется ли лицо: разброс центров > 6% ширины
    cxs = [(b[0] + b[2]) / 2 for b in boxes]
    moves = (max(cxs) - min(cxs)) / W > 0.06
    # запас вокруг лица
    m = FACE_MARGIN * W
    return (xs0 - m, ys0 - m, xs1 + m, ys1 + m), moves


def side_box(side, W, H):
    """
    Пиксельный bbox, который займёт плашка. Колонки ПРИЖАТЫ к краям кадра, чтобы
    для крупного центрированного лица (типичный говорящий план) оставаться вне лица:
    левая колонка кончается до лица, правая начинается после, верх — над лицом.
    """
    if side == 'left':
        return (SAFE_LEFT * W, SAFE_TOP * H, 0.31 * W, (1 - SAFE_BOTTOM) * H)
    if side == 'right':
        return (0.69 * W, SAFE_TOP * H, (1 - SAFE_RIGHT) * W, (1 - SAFE_BOTTOM) * H)
    if side == 'top':
        return (0.18 * W, SAFE_TOP * H, 0.82 * W, 0.23 * H)  # тонкая полоса над лицом
    # bottom
    return (0.18 * W, (1 - SAFE_BOTTOM - 0.12) * H, 0.82 * W, (1 - SAFE_BOTTOM) * H)


def overlap_area(a, b):
    """Площадь пересечения двух bbox (x0,y0,x1,y1)."""
    ix0 = max(a[0], b[0]); iy0 = max(a[1], b[1])
    ix1 = min(a[2], b[2]); iy1 = min(a[3], b[3])
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    return (ix1 - ix0) * (iy1 - iy0)


def anchor_for_side(side, W, H):
    """Нормализованный якорь (центр плашки) + bbox зоны для оценки яркости."""
    box = side_box(side, W, H)
    if side == 'left':
        return 0.17, 0.5, box            # центр левой колонки (0.03..0.31)
    if side == 'right':
        return 0.79, 0.5, box            # центр правой колонки (0.69..0.88)
    if side == 'top':
        return 0.5, SAFE_TOP + 0.04, box
    return 0.5, (1 - SAFE_BOTTOM) - 0.05, box


def zone_brightness(gray, x0, y0, x1, y1):
    H, W = gray.shape[:2]
    x0 = max(0, min(W - 1, int(x0))); x1 = max(x0 + 1, min(W, int(x1)))
    y0 = max(0, min(H - 1, int(y0))); y1 = max(y0 + 1, min(H, int(y1)))
    patch = gray[y0:y1, x0:x1]
    return 128.0 if patch.size == 0 else float(patch.mean())


def choose_side(face_box, W, H, last_side):
    """
    Выбор стороны, свободной от лица на ВСЁМ интервале.
    Перебираем стороны в порядке предпочтения, считаем перекрытие с зоной лица,
    берём первую с нулевым перекрытием (и не повторяющую прошлую сторону, если можно).
    """
    order = ['right', 'left', 'top', 'bottom']
    if face_box is not None:
        cx = (face_box[0] + face_box[2]) / 2 / W
        # антипод впереди: лицо слева → сначала пробуем right, и наоборот
        order = (['right', 'top', 'bottom', 'left'] if cx < 0.5
                 else ['left', 'top', 'bottom', 'right'])

    scored = []
    for side in order:
        ov = 0.0 if face_box is None else overlap_area(side_box(side, W, H), face_box)
        scored.append((side, ov))

    # свободные (ov==0), приоритет — не повторять прошлую сторону
    free = [s for s, ov in scored if ov <= 1.0]
    if free:
        for s in free:
            if s != last_side:
                return s, 0.0
        return free[0], 0.0

    # всё пересекается — минимальное перекрытие
    scored.sort(key=lambda x: x[1])
    return scored[0]


def main():
    if len(sys.argv) < 2 or sys.argv[1].startswith('--'):
        raise SystemExit('использование: analyze-frames.py <video> '
                         '(--intervals "a-b,c-d" | --slots | --interval N) [--out f.json]')
    video = sys.argv[1]
    samples = int(get_opt('--samples', '6'))

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f'не открыть видео: {video}')

    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    dur = total / fps if total else 0

    intervals = build_intervals(dur)
    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

    placement = []
    last_side = None

    for (start, end) in intervals:
        fbox, moves = face_union(cap, cascade, start, end, samples, W, H)
        side, ov = choose_side(fbox, W, H, last_side)
        x, y, box = anchor_for_side(side, W, H)

        # яркость по среднему кадру интервала
        cap.set(cv2.CAP_PROP_POS_MSEC, (start + end) / 2 * 1000.0)
        ok, frame = cap.read()
        bright = 128.0
        if ok and frame is not None:
            bright = zone_brightness(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), *box)
        text_color = 'dark' if bright > 140 else 'light'

        placement.append({
            'start': round(float(start), 2),
            'end': round(float(end), 2),
            'pos': side,
            'x': round(float(x), 4),
            'y': round(float(y), 4),
            'side': side,
            'textColor': text_color,
            'collision': round(float(ov), 1),   # 0 = плашка гарантированно вне лица
            'faceMoves': bool(moves),
        })
        last_side = side

    cap.release()

    out_json = json.dumps(placement, ensure_ascii=False, indent=2)
    print(out_json)

    n_coll = sum(1 for p in placement if p['collision'] > 1)
    sys.stderr.write(f'[ok] интервалов: {len(placement)}, с остаточным перекрытием лица: {n_coll}\n')

    out_path = get_opt('--out')
    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(out_json + '\n')
        sys.stderr.write(f'[ok] записано: {out_path}\n')


if __name__ == '__main__':
    main()
