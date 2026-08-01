# Этап 6 — Пайплайн одной командой. Инструкция исполнения

Цель: `node scripts/build.js <видео> [--theme craft] [--scenario лист.json] [--id auto]`
собирает ролик от исходника до готового mp4, наследуя аспект.

## Что делает скрипт (по шагам)
1. ffprobe исходника: width, height, duration, fps → определить durationInFrames и аспект.
2. Извлечь аудио (ffmpeg wav 16k mono) во временный файл.
3. faster-whisper (python) → transcript.json (words + таймкоды). Модель base по умолч., флаг --model.
4. build-captions: transcript → CAPTIONS (src/data/captions.js).
5. Если --scenario не задан → сгенерировать ЧЕРНОВОЙ монтажный лист:
   - LabelTop 0.3 ">_ ..." ;
   - CaptionsAuto на всю речь ;
   - эвристики: числа в тексте → CounterCard; последний сегмент с «ссылка/кнопка/жми» → CTACard.
   Сохранить в out/<id>.scenario.json для ревью.
6. Скопировать исходник в public/source.mp4.
7. Пробросить в Remotion динамические props: писать props JSON (source, theme, blocks, width, height) и рендерить композицию "Dynamic" с --props и --width/--height/--frames по факту.
8. Рендер: если duration ≤ ~15с — один заход; иначе рендер порциями по 12с и склейка ffmpeg concat.
9. Итог → out/<id>.mp4. Печать пути. (Отправка Диде документом — вручную тегом [ФАЙЛ:].)

## Требуется в проекте
- Композиция "Dynamic" в Root: width/height/durationInFrames берутся из props через calculateMetadata.
- python faster-whisper доступен (venv/global). Путь к python — флаг или автоопределение.

## Критерий готовности
Одна команда на новом видео (верт. ИЛИ гориз.) → out/<id>.mp4 с наследованным аспектом, субтитрами и черновыми плашками.

## Отложить (не в этом этапе)
- Умную расстановку broll (нужен смысловой разбор) — пока broll добавляется вручную в лист.
- Отправку в Telegram из скрипта.

## Тест этапа
Прогнать на public/source.mp4 (27с) с --scenario src готового листа → убедиться, что out/test.mp4 рендерится и играет.
