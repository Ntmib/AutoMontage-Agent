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
- schema-контракт project manifest, миграция legacy `transcript`, traversal/Windows-path
  payload, dangling symlink на final/intermediate component и safe slug/id: каждый сохранённый
  или generated путь обязан остаться внутри своего workspace/outdir;
- общий lesson/Dynamic export: реальный existing/dangling final symlink и symlinked/non-directory
  parent отклоняются без изменения внешнего sentinel, а новый вложенный `--outdir` создаётся;
- exclusive unpredictable temp для manifest; версии draft/approved brief, rollback JSON/Markdown/
  manifest при I/O failure, render history и канонический final;
- lifecycle `started → failed/complete`, сохранность прежнего final и атомарную публикацию;
- CLI-правила `--project`, `--project-dir` и `--version-label`;
- process regression matrix: leading `-`, пробелы, кавычки, `$()`, `;`, newline и Unicode;
- Review waveform: буквальный ffmpeg argv, cache reuse/invalidation, очистка partial temp,
  отказ от regular/symlink/dangling-symlink подмен, включая замену `previews/` на runner boundary,
  и неизменность manifest/approved brief;
- Review security: random token на каждом `/api/*` и `/media/*`, same-session Origin для POST,
  read-only `405`, traversal/symlink, oversized body, unknown command и stale-session fail closed;
- Review edit contract: только adjacent boundary и allowlisted b-roll, отсутствие global ripple,
  серверный diff/timing, in-memory undo/redo, новая draft-пара на Save и byte-identical approved;
- fail-closed ошибки ENOENT, non-zero, signal и некорректный ffprobe JSON;
- timing regression: NTSC `30000/1001` и `24000/1001` FPS не округляются, число кадров
  считается через `ceil`, а положительный целый `--frames` не превышает длину source;
- повторный ffprobe после reframe и tighten обновляет FPS, по которому строятся props;
- уникальный public media lease каждого render, его cleanup и запрет symlink-escape;
- cache identity: изменение Remotion-кода, lockfile, обычного public resource path или его bytes
  отменяет reuse; меняющийся generated source lease с теми же bytes сохраняет key также без
  расширения и с непривычным расширением;
- safe-zone длинных денежных подписей;
- анимации CTA, воронки, градиента и маркеров соцсетей.

Любое исправление бага должно добавлять регрессионный тест его причины.

Для waveform и защищённого process boundary отдельно можно запустить:

```bash
node --test tests/review-waveform.test.js tests/process-security.test.js
npm run test:review-ui
```

Chromium suite поднимает настоящий loopback-сервер и проверяет read-only/edit DOM, token/origin,
waveform fallback, drag/keyboard boundary, b-roll, undo/redo, save confirmation, 409 conflict и
неизменность approved. Она не заменяет `npm test`: browser и Node suites обязательны отдельно.

Для золотого пути свежего клона отдельно проверь:

```bash
git clone https://github.com/Ntmib/AutoMontage-Agent.git
cd AutoMontage-Agent
npm ci
npm run doctor
npm run demo
```

Одна папка checkout допускает только одну активную сборку: Remotion source bridge изолирован
уникальным lease в `public/.automontage/`, но `tmp/` и legacy-пути остаются общими.
Параллельные проверки запускай в отдельных clone/worktree. Unit и integration tests также
проверяют, что leases не пересекаются, cleanup идемпотентен и удаляет источник после успеха
или ошибки рендера.

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
Resume cache v2 адресуется SHA-256 от composition, канонизированных props, source/audio
identities, диапазонов, Remotion options, всего `src/`, `package.json` и `package-lock.json`.
Тесты меняют JSX byte, referenced b-roll и package metadata, проверяют, что каждый случай
инвалидирует key, а неиспользуемый `public/` файл – нет. Для public media фиксируются только
contained regular files, отсортированные по JSON pointer; traversal не читается, symlink в
`src/` или на любом сегменте public media отклоняется. Descriptor сохраняет порядок ключей,
который получает Remotion, поэтому перестановка props тоже меняет key. Одинаковые bytes в разных
generated `.automontage/<lease>/source.<ext>` дают одинаковый resume key, но byte-identical
обычные b-roll A и B сохраняют разную наблюдаемую path identity.
Manifest разрешает reuse только при совпадении range/hash/size/frames.

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

Для реальной проверки Review используй только копию fixture/project workspace. До запуска сними
SHA-256 `project.json`, всех brief и approved-файлов. Read-only сессию закрой и подтверди те же
bytes. В `--edit` перенеси одну общую границу, сделай Undo, перенеси снова и Save; должны появиться
одна новая draft Markdown/JSON-пара и одна manifest entry, а approved hash остаться прежним.
Утверждай новую draft только существующим `approve-brief.js`, затем рендери `--brief` и выполни
полный decode, ffprobe и визуальную проверку контрольных кадров. Review сам approval/render не делает.
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
- убедиться, что лицо, текст и маркеры соцсетей внутри safe-zone;
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

`.github/workflows/ci.yml` сохраняет обычный Node 20 job с `npm ci`, `npm test` и
`npm run check:release` на pull request и push в `main`. Отдельный browser job выполняет
`npm ci --no-audit --no-fund`, устанавливает только Playwright Chromium с системными
зависимостями и запускает `npm run test:review-ui`. Поэтому browser setup не может скрыть
обычную Node-регрессию. Release-checker проверяет committed current tree без base и работает
с shallow checkout. Отдельный job Gitleaks сканирует полную Git-историю на секреты.
Полные рендеры в CI не запускаются: им нужны тяжёлые медиа, ffmpeg/Whisper-модели и
иногда приватные темы. Их проверяют локально по разделам выше.

## 8. Release candidate

```bash
npm run check:release
npm run check:release -- --tree HEAD --base origin/main
npm run smoke:release
```

Перед commit можно проверить именно staged candidate, а не рабочую папку:

```bash
CANDIDATE_TREE="$(git write-tree)"
node scripts/check-release.js --tree "$CANDIDATE_TREE" --base <release-base>
```

`check:release` читает файлы через `git ls-tree`/`git show`, поэтому проверяет точный
Git-объект и игнорирует незакоммиченные пользовательские файлы. Current-tree правила
сверяют версию, Node engines, env-декларации, локальные Markdown-ссылки, приватные id,
версионные release notes, security exception и полный бинарный инвентарь `ASSETS.md`. Для release candidate
`CHANGELOG.md` обязан содержать ровно одну dated-секцию текущей версии вида
`## [X.Y.Z] - YYYY-MM-DD` с реальной UTC-календарной датой; `[Unreleased]` в этот момент полностью пуст.
В version section нужны хотя бы один `###` подраздел и bullet, а для patch-версии – `### Исправлено`.
Каждый tracked public binary (изображение, видео, аудио или шрифт) требует полную строку с repo-relative
путём в `ASSETS.md`. Исключение `node-vibrant` должно содержать ровно один machine-readable
`json security-exception` fence с проверяемыми `reviewedAt` (реальная календарная дата) и `reviewedFor`,
в точности равным текущей версии `package.json`. `reviewedAt` не может быть будущей или перенесённой
со старой даты релиза; chain содержит ровно пять записей и выводится повторно из candidate
`package-lock.json`, а не принимается только со слов `SECURITY.md`.
При наличии `--base` добавляется diff-проверка
публичной пунктуации; если history/ref недоступен, ошибка содержит команду fetch.

`smoke:release` с удалённым из дочернего окружения `THEMES_EXT` рендерит 75 кадров
`examples/lesson-neutral-approved.json`, затем через project API создаёт отдельный Dynamic
workspace и рендерит его через `--project-dir`. Для обоих финалов обязательны video/audio,
A/V drift меньше 80 мс, ровно 75 кадров и полный decode. У project-финала SHA-256 должен
совпасть с `renders[]`-версией, выбранной `latestRender`. Скрипт оставляет артефакты для
осмотра, печатает два абсолютных final path и подтверждает неизменность защищённых
`src/data/captions.js` и `src/data/transcript.json`.

## 9. Проверка секретов и зависимостей

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

Полный `npm audit` сейчас должен показывать ровно пять moderate записей по одной цепочке
`node-vibrant -> @vibrant/image-node -> @jimp/custom -> @jimp/core -> file-type` и ноль
high/critical. Исключение действительно только в форме, описанной в
[`SECURITY.md`](SECURITY.md), и автоматически истекает по `revisitBy`. После изменения
dependency tree, advisory severity или входа `--autotheme` документ и release gate нужно
пересмотреть вместе. `npm audit fix --force`, major override и downgrade на 3.x не являются
проверенным исправлением для этого релиза.
