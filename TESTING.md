# Тестирование AutoMontage-Agent

Проверки идут слоями: быстрые тесты ловят логику, демо проверяет сборку, а контрольные
кадры и медиапроверка подтверждают, что ролик действительно можно отдавать человеку.

## 1. Быстрый обязательный уровень

```bash
npm ci
npm test
```

`npm test` использует встроенный Node test runner и запускает `tests/*.test.js`.
Проверяются, среди прочего:

- draft/approved-гейт и неизменность source/theme/aspect;
- геометрия source/vertical/horizontal;
- нормализация и валидация lesson brief;
- глобальный таймкод видео между сценами;
- музыкальный gain, fade, стартовый фрагмент и скорость;
- создание project-папки, транслитерация, локальный транскрипт и повторное открытие;
- версии draft/approved brief, render history и канонический final;
- lifecycle `started → failed/complete`, сохранность прежнего final и атомарную публикацию;
- CLI-правила `--project`, `--project-dir` и `--version-label`;
- process regression matrix: leading `-`, пробелы, кавычки, `$()`, `;`, newline и Unicode;
- fail-closed ошибки ENOENT, non-zero, signal и некорректный ffprobe JSON;
- safe-zone длинных денежных подписей;
- анимации CTA, воронки, градиента и логотипов.

Любое исправление бага должно добавлять регрессионный тест его причины.

Для host filesystem path тест проверяет абсолютный отдельный argv. Ссылки Remotion/public
остаются web-relative и не преобразуются в host path. Capture разрешён только для коротких
ffprobe/JSON-результатов с явным `maxBuffer`.

Статический guard для `scripts/build.js` запрещает `execSync` и `shell: true`. Опции
`--frames`, `--max`, `--beatSec`, `--brandLock` и `--reframe` проверяются до ffprobe.
Та же граница действует для `finish.js`, `mix-music.js` и `pack-tg.js`: filter values,
FPS, bitrate и resolution имеют конечные диапазоны, а пути остаются отдельными argv.
`tighten.js` и `cut-pauses.js` дополнительно валидируют word/keep intervals; временный
ffmpeg filter script удаляется через `finally` и при успешном, и при аварийном завершении.
Chunk-render проверяет positive integer `totalFrames/--chunk`, рендерит part во временный
соседний MP4 и публикует его rename только после успешного Remotion exit.

## 2. Проверка окружения

```bash
npm run doctor
```

Команда проверяет Node.js 20+, Python 3, ffmpeg и установленные зависимости. Chromium
нужен только для пересборки PNG через Playwright, не для обычного рендера.

## 3. Воспроизводимый демо-рендер

```bash
npm run demo
```

Демо пишет MP4, transcript и captions только в игнорируемый `out/`. После прогона
`git status --short` не должен показывать новые изменения в `src/data/`.

Демо использует небольшие файлы из `examples/`, не требует API-ключей и не скачивает
Whisper-модель. Проверить, что созданный MP4 открывается и содержит звук.

## 4. Проверка монтажных листов

Для Dynamic до Remotion:

```bash
node scripts/validate.js path/to/scenario.json
node scripts/quality-gate.js path/to/scenario.json
node scripts/dynamic-gate.js path/to/scenario.json path/to/transcript.json
```

В обычном `scripts/build.js` эти гейты вызываются автоматически. Ошибку схемы или
качества нужно исправлять до полного рендера.

## 5. Проверка lesson-процесса

1. Запустить `--template lesson --project "Test lesson"` без `--brief`.
2. Убедиться, что созданы project-папка, локальный транскрипт, Markdown и JSON со статусом
   `draft`, а Remotion не стартовал.
3. Проверить исправления распознавания, сцены, тексты, таймкоды и кадрирование.
4. Только после явного утверждения создать approved-копию через
   `scripts/project/approve-brief.js`.
5. Рендерить локальным исходником через `--project-dir`, `--brief` и `--version-label`.
6. Отдельно проверить, что draft, другой source, тема или аспект блокируются.
7. Убедиться, что повторный рендер создаёт новый `renders/vNN-<label>/`, не стирая прошлый.
8. Убедиться, что `final/<slug>.mp4` совпадает с последним успешным рендером.
9. При искусственном сбое render/finish/music/publish проверить статус `failed`, прежние
   `latestRender` и canonical final.

Полные команды – в `docs/TEMPLATES.md`.

## 6. Визуальная и медиапроверка финала

Для заметного изменения сцен или пайплайна:

- сделать still/короткий рендер до полного;
- посмотреть начало, каждую смену сцены, середину и финал;
- проверить обе ориентации, если менялась адаптивная раскладка;
- убедиться, что лицо, текст и логотипы внутри safe-zone;
- сравнить A/V-синхрон в начале, середине и конце;
- декодировать итог целиком через ffmpeg и проверить параметры через ffprobe;
- проверить громкость и отсутствие обрыва музыки/голоса.

`pack-tg.js` требует video и audio stream с конечными start/duration. Разница start или
duration в 80 мс и больше является ошибкой с ненулевым exit code; 79 мс ещё проходит.

Готовность означает не только зелёные тесты: итоговый MP4 должен открываться, полностью
декодироваться и визуально соответствовать утверждённому монтажному листу.
Для chunk-render отдельно сверяется `nb_read_frames`: он должен точно равняться запрошенному
`totalFrames`, включая последний неполный chunk.

Для локальной миграции существующего ролика дополнительно проверяется наличие исходника,
истории brief, всех перенесённых версий рендера, превью и принятого финала в одной игнорируемой
project-папке. Старые артефакты в `out/` при миграции не удаляются.

## 7. CI

`.github/workflows/ci.yml` запускает `npm ci` и `npm test` на pull request и push в
`main` под Node.js 20. Отдельный job Gitleaks сканирует полную Git-историю на секреты.
Полные рендеры в CI не запускаются: им нужны тяжёлые медиа, ffmpeg/Whisper-модели и
иногда приватные темы. Их проверяют локально по разделам выше.

## 8. Проверка секретов и зависимостей

```bash
gitleaks git --staged --redact=100      # что готовится в ближайший коммит
gitleaks git . --log-opts=--all --redact=100  # вся история и все локальные ветки
npm audit                               # известные проблемы зависимостей
```

Локальный `.githooks/pre-commit` выполняет первый скан автоматически. Активировать его
один раз: `git config core.hooksPath .githooks`. Реальное совпадение нельзя добавлять в
allowlist: сначала удалить секрет из staged-файлов и немедленно перевыпустить ключ, если
он уже успел попасть в коммит или удалённый репозиторий.

CI блокирует high/critical уязвимости командой `npm audit --audit-level=high`.
Dependabot еженедельно проверяет npm-пакеты и используемые GitHub Actions. Все actions в
workflow закреплены по неизменяемому commit SHA, чтобы плавающий тег нельзя было незаметно
подменить.
