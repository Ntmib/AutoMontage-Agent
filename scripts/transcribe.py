#!/usr/bin/env python3
# Транскрипция аудио → JSON (сегменты + словные таймкоды). Локально, бесплатно.
#   python3 transcribe.py <audio> <out.json> [model] [--prompt "контекст"]
# Модель по умолчанию large-v3-turbo (~1.6 ГБ) — точность почти как large-v3,
# но вдвое легче/быстрее. Качается ОДИН раз при первом запуске, дальше офлайн.
# Другие: base (~140МБ, быстро/неточно), small (~460МБ), large-v3 (~3ГБ, максимум).
# Передать нужную вторым аргументом.
import sys, json
from faster_whisper import WhisperModel

audio = sys.argv[1]
out = sys.argv[2]
model_name = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith('--') else 'large-v3-turbo'

# initial_prompt — подсказка с лексикой темы: whisper реже коверкает термины
prompt = 'Вайбкодинг, ИИ-агенты, нейросети, автомонтаж, монтаж видео, субтитры, плашки, Claude, Codex, Reels, контент.'
if '--prompt' in sys.argv:
    prompt = sys.argv[sys.argv.index('--prompt') + 1]

# CPU int8 — работает без GPU. large-v3 медленнее base, но точность выше.
m = WhisperModel(model_name, device='cpu', compute_type='int8')
segments, info = m.transcribe(
    audio, language='ru', word_timestamps=True,
    initial_prompt=prompt,
    beam_size=5,                       # точнее жадного поиска
    condition_on_previous_text=True,   # связность между сегментами
    vad_filter=True,                   # отсечь тишину/шум → меньше галлюцинаций
    vad_parameters=dict(min_silence_duration_ms=400),
    temperature=[0.0, 0.2, 0.4],       # фолбэк при низкой уверенности
)

res = []
for s in segments:
    words = [{'w': w.word, 's': round(w.start, 2), 'e': round(w.end, 2)} for w in (s.words or [])]
    res.append({'start': round(s.start, 2), 'end': round(s.end, 2), 'text': s.text.strip(), 'words': words})

json.dump(res, open(out, 'w'), ensure_ascii=False, indent=1)
print(f'model={model_name} segments={len(res)}')
