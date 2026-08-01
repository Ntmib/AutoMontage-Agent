# Фаза 1 — tighten + finish. Инструкция исполнения

## 1.1 tighten (scripts/tighten.js) — рез пауз + слов-паразитов
Вход: video, transcript.json(words). Выход: tightened.mp4 + пересчитанный transcript.json.
Логика:
- keepWords = words минус филлеры (RU-регэксп: э/эм/ну/типа/короче/значит/как бы/это самое/вот).
- keep-сегменты речи: идём по keepWords; если gap до следующего > maxGap(0.6) → разрыв (вырезаем паузу), иначе пауза остаётся. Филлеры выпадают → их время режется автоматически.
- GUARD: (а) не создавать разрез, пока время < hookGuard(1.5с) — защита хука; (б) pad 0.1с дыхания вокруг сегментов; (в) если суммарный keep < minDur — не резать (вернуть исходник).
- ffmpeg trim+concat keep-сегментов → tightened.mp4.
- Пересчёт таймкодов слов: для слова в keep-сегменте i: newT = (t - a_i) + Σ(b_j-a_j, j<i). Филлеры удаляются. → новый transcript.json.
Критерий: речь плотнее, субтитры синхронны, хук цел.

## 1.2 finish (scripts/finish.js) — аудио+картинка
Вход: rendered.mp4 → out.mp4.
- аудио: loudnorm=I=-14:TP=-1.5:LRA=11 (всегда).
- видео HDR→SDR (флаг --hdrfix, автодетект smpte2084/arib-std-b67): zscale linear→tonemap=hable→zscale bt709.
- резкость (--sharpen): unsharp=5:5:0.8; даунскейл flags=lanczos.
Критерий: громкость ≈ -14 LUFS, iPhone-исходник не серый.

## Встраивание в build.js
--tighten между транскрипцией и субтитрами; finish — финальным шагом после render (loudnorm по умолч.).
Тест: на job1 (боевой ролик) — проверить сколько вырезано и что хук цел.
