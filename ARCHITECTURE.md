# Архитектура AutoMontage-Agent

Актуально на 2026-08-22. Документ описывает существующий код, а не будущую дорожную карту.

## 1. Назначение и границы

AutoMontage-Agent – локальный конвейер «видео + монтажное решение → MP4». Он объединяет:

- Node.js-оркестратор и CLI;
- faster-whisper для локальной транскрибации;
- Remotion + React для программной графики;
- ffmpeg для подготовки исходника, музыки и финишной обработки;
- OpenCV/Python для анализа лица и перекадрирования;
- JSON-монтажные листы, отделяющие смысл и тайминг от визуальной темы.

Проект не является видеоредактором с GUI, облачным сервисом или хранилищем пользовательских
роликов. Исходники, музыка и результаты живут локально и не входят в репозиторий.

## 2. Главная модель: тема → композиция → монтажный лист

1. **Тема** (`src/theme/`) хранит цвета, шрифты, радиусы, тени и параметры движения.
2. **Композиция** (`src/`, `src/blocks/`, `src/scenes/`) знает, как рисовать и анимировать.
3. **Монтажный лист** (`props/*.json`, `schema/*.json`) определяет, что и когда показать.

Так один сценарий можно отрендерить в другой теме, не переписывая компоненты, а приватный
стиль можно подключить извне через `THEMES_EXT`.

Default зависит от композиции: lesson/ReelScenes использует встроенную
`lesson-neutral`, Dynamic использует `craft`. Оба значения задаются до построения props;
внешний theme id всегда передаётся явно.

## 3. Потоки данных

### 3.1 Dynamic – общий монтаж

```mermaid
flowchart LR
  A["Видео"] --> B["ffprobe: геометрия, FPS, длительность"]
  B --> C["ffmpeg: WAV 16 kHz mono"]
  C --> D["faster-whisper: transcript.json"]
  D --> E["Опционально: tighten / reframe / autopos"]
  E --> F["scenario JSON + captions.js"]
  F --> G["JSON Schema + quality gates"]
  G --> H["Remotion: Dynamic"]
  H --> I["ffmpeg finish / music"]
  I --> J["MP4 в projects/ или legacy out/"]
```

`scripts/build.js` является границей пользовательского ввода: пути сначала разрешаются
как host paths, затем ffprobe, ffmpeg, Python и Remotion получают их отдельными argv через
`scripts/process.js`. Числовые CLI-параметры проходят конечные диапазоны до первого spawn.
После исходного и каждого производного видео (reframe/tighten) build берёт геометрию, FPS и
длительность из соответствующего ffprobe. `scripts/source-timing.js` сохраняет точный numeric
FPS, включая NTSC `30000/1001` и `24000/1001`, вычисляет `durationInFrames` через `ceil` и
не даёт положительному целому `--frames` увеличить доступную длину.

Точка оркестрации – `scripts/build.js`. Без `--scenario` он создаёт черновой монтажный
лист; смысловую расстановку блоков агент затем правит и запускает повторно с готовым JSON.

В project-режиме `scripts/project/workspace.js` оборачивает render, finish, music и
публикацию в единый lifecycle. Ошибка переводит текущую версию из `started` в `failed`,
не меняя `latestRender`; новый canonical final сначала копируется во временный соседний
файл, синхронизируется и только затем атомарно заменяет предыдущий.

`project.json` – недоверенная граница между сохранёнными метаданными и файловой системой:
`project.json → schema/project.schema.json → resolveProjectPath() → filesystem`.
Перед чтением и записью старый manifest без `transcript` мигрируется к каноническим путям,
затем AJV-схема запрещает неизвестные поля, а resolver проверяет каждый project-путь.
Даже schema-valid manifest не получает доверия к путям: resolver принимает только канонический
относительный путь внутри workspace, отвергает
absolute/Windows/traversal-варианты, проверяет `lstat` каждого уже существующего компонента,
включая dangling symlink, и затем подтверждает containment через `realpath`. Slug ограничен
каноническим lowercase token. Legacy `--id` отдельно ограничен безопасным filename token,
а общий для lesson и Dynamic экспорт через `--outdir` проверяет `lstat` каждого существующего
компонента outdir и финала, включая dangling link, создаёт отсутствующие родители по одному,
подтверждает `realpath` containment и копирует в непредсказуемый exclusive/no-follow temp.
Атомарный `rename` публикует temp вместо прямой записи через статическую ссылку назначения.
Единственное исключение – `source.originalPath`: это provenance исходника, а не workspace-путь.

`project.json` записывается через непредсказуемый соседний temp, открытый с exclusive и
no-follow flags там, где платформа их поддерживает. Temp-файл проверяется как regular file,
синхронизируется и атомарно переименовывается; cleanup удаляет его только при совпадении
file identity с созданным процессом.

Все изменяющие project-операции используют один межпроцессный lease из
`scripts/project/workspace.js`: Save, approval, регистрация brief и lifecycle render не могут
одновременно менять один workspace, но чтения остаются доступными. Полный owner record
публикуется атомарно; live owner и owner с другого host сохраняются. Lease умершего PID на том
же host можно забрать через identity-проверенный recovery claim. Под lease manifest заново
читается с диска, stale in-memory snapshot получает `PROJECT_MANIFEST_CONFLICT`, а замена
`project.json` выполняется только после повторной проверки persisted file snapshot. Для
существующего manifest даже низкоуровневый writer обязан передать expected snapshot; успешный
`rename` является однозначной commit point и после него transaction не запускает fallible probe,
который мог бы ошибочно откатить уже опубликованную историю.

Containment защищает от вредоносного manifest и symlink, существующих на момент проверки.
Соперничающий локальный процесс с правом записи в workspace или внешний `--outdir` может заменить предка между
проверкой и файловой операцией; portable Node API не даёт для этого кроссплатформенный
descriptor-relative `openat`-аналог. Такая конкурентная подмена вне границы модели угроз:
не предоставляйте untrusted локальным процессам запись в папку проекта или каталог экспорта;
проверки и операции в коде расположены настолько близко друг к другу, насколько позволяет API.

### 3.2 Lesson – ТЗ до рендера

```mermaid
flowchart LR
  A["Видео"] --> B["Транскрипт с таймкодами"]
  B --> C["Словарь + LLM-проруф"]
  C --> D["Markdown + JSON status=draft"]
  D --> E{"Явно утверждено?"}
  E -- "нет" --> D
  E -- "да" --> F["JSON status=approved"]
  F --> G["Проверка source/theme/aspect"]
  G --> H["Remotion: ReelScenes"]
  H --> I["AAC-компенсация и finish"]
  I --> J["MP4"]
```

`scripts/lesson/workflow.js` определяет режим `plan` или `render`.
`scripts/gen-brief.js` выбирает только официальные сцены и создаёт draft.
`scripts/lesson/brief.js` валидирует данные и превращает approved brief в props.
`schema/lesson-brief.schema.json` фиксирует контракт.

Approval под project lease заново читает и полностью валидирует текущий persisted draft и
manifest. Markdown и JSON публикуются первыми атомарными no-replace hard links, поэтому уже
существующая историческая ревизия никогда не заменяется. `project.json` публикуется CAS-последним:
reader либо видит прежний currentBrief, либо новый указатель на уже существующий JSON. Сбой до
manifest удаляет только собственные опубликованные файлы; hard exit может оставить безопасный
orphan, и следующая draft-ревизия пропускает занятое имя. При рендере точный legacy
`faceSrc: "source.mp4"` внутри сцены переводится на
текущий source lease вместе с top-level `faceSrc` и `audioSrc`.

Первичный lesson/scenario draft тоже использует этот contract: build context не резервирует
номер заранее, генератор сначала создаёт временную no-replace пару, а `publishBriefRevision()`
под lease выбирает свободную ревизию, публикует исторические файлы no-replace и обновляет
manifest последним. Поэтому параллельный build или foreign destination не перезаписывается.

Brief замораживает исходник, тему, аспект, размеры, FPS, длительность, сцены и проверенное
кадрирование лица. Это защищает от ситуации, когда утверждали один монтаж, а рендерится другой.

### 3.3 Review Workbench — локальная проверка до рендера

Путь нового b-roll проходит через несколько границ; браузер никогда не получает project path
или SHA-256:

```mermaid
flowchart LR
  A["Файл в браузере"] --> B["POST /api/assets/import"]
  B --> C["owned quarantine 0700"]
  C --> D["ffprobe + полный decode + лимиты"]
  D --> E["WebP или H.264/AAC master + WebM proxy"]
  E --> F["immutable UUID bundle + asset.json"]
  F --> G["opaque asset-N в Review"]
  G --> H["allowlist command + /api/validate"]
  H --> I["Save: brollMedia + SHA-256 в новом draft"]
  I --> J["approve: повторный probe/hash/identity"]
  J --> K["одноразовый render media bundle"]
  K --> L["Remotion Img / OffthreadVideo"]
```

`scripts/review/server.js` поднимает loopback-сервер с непредсказуемым session token и отдаёт
browser-safe модель: исходник, сцены, слова, разрешённые медиа и аудит таймингов. Реальные пути
остаются на сервере; `/api/*` и `/media/*` требуют токен, а файловые ответы привязаны к snapshot
regular-файла и закрываются при его подмене после старта.

`GET /api/state` каждый раз заново читает текущие manifest, brief и transcript с диска. Opaque
asset id сохраняется, пока совпадают server-side reference, device и inode; замена исходника или
зарегистрированного медиа завершает старую сессию с `409`, а не привязывает прежний handle к
новым байтам. Тот же identity gate действует перед validate/save. Для выбранного подменённого
asset preview даёт `404`, а validate/save — `422`.

По умолчанию сессия read-only и не имеет POST-маршрутов или edit controls. Флаг `--edit`
открывает `POST /api/validate`, `POST /api/save` и отдельный потоковый
`POST /api/assets/import`. Для protected edit-запроса token и Origin
своей loopback-сессии проверяются до чтения body. Сам body сервер вычитывает с жёстким лимитом;
лишь затем сверяет method, route, edit permission и точный content type. Только допущенный body
разбирается как JSON. Validate заново читает
зарегистрированный текущий brief и manifest, сверяет их hashes, воспроизводит allowlist-команды
и возвращает browser-safe diff. Save повторяет эту проверку на свежем snapshot и через project
workspace создаёт новую draft Markdown/JSON-ревизию и ровно одну manifest entry. Исходный draft,
approved-файлы и render history не перезаписываются. Review не вызывает approval или Remotion.
Перед повторным чтением CAS и выделением номера workspace берёт общий project mutation lease.
Живой или foreign-host owner даёт прежний `409`, а lease завершившегося PID восстанавливается
без удаления чужих байтов. Review публикует Markdown и канонический JSON через atomic
no-replace, повторно сверяет старый manifest и лишь после этого атомарно публикует новый
manifest. Поэтому `/api/state` продолжает видеть старую согласованную ревизию, пока оба файла
новой пары не стали видимы. Orphan после hard exit не перезаписывается: allocator выбирает
следующий свободный номер ревизии.

Редактор принимает только `move-boundary`, `replace-broll`, `set-broll-fit`,
`set-broll-video-start` и `set-broll-audio-mode` с непрозрачным `asset-N` из текущего allowlist.
Первая команда меняет только `left.end` и `right.start`: это adjacent edit, а не global ripple.
Остальные выбирают image/video, `contain|cover`, покадрово округлённый старт и
`mute|mix|replace`; video default равен `contain`, frame 0, `mute`, image default — `cover`.
Видео без аудиопотока допускает только `mute`. Все времена brief остаются абсолютными временами
исходника; поздние сцены не сдвигаются. Undo/redo хранит команды только в памяти браузера;
серверный validate заново строит registry, пробует/хэширует тот же открытый descriptor и остаётся
источником геометрии, diff и timing audit. Текст, scene type, effects, keyframes, masks и прочие
поля fail closed как unsupported diff.

`POST /api/assets/import` доступен только в edit-сессии и принимает один raw body за раз.
Заявленный размер, MIME и безопасное имя проверяются до обработки; поток пишется в отдельный
owner-only quarantine с точным `Content-Length`, abort signal и фиксированным запасом диска.
Затем ffprobe и полный decode подтверждают реальный контейнер, codec, геометрию, длительность и
аудио. Изображение нормализуется в WebP; видео — в H.264/yuv420p master с AAC 48 kHz stereo при
наличии звука и отдельный VP8/Opus WebM proxy для браузера. Metadata удаляется. Публикация
атомарно переносит один immutable UUID bundle в `assets/broll/images|video/` и proxy в
`previews/broll/`; `asset.json` содержит параметры и hashes без путей, а фиксированные
относительные ссылки сервер выводит из UUID и типа медиа.
Импорт не отправляет `replace-broll`: после refresh новая карточка появляется в media lane, но
пользователь обязан отдельно назначить её сцене.

Save не доверяет browser descriptor. Он повторно сканирует immutable bundle, открывает master
без следования symlink, передаёт тот же descriptor в bounded ffprobe, хэширует те же байты и
только после повторной identity-проверки материализует канонический `brollMedia` в новый draft.
Approval повторяет containment, probe, metadata/proxy/hash и clip-duration проверки, удерживает
descriptors до commit boundary и публикует approved только если все identities сохранились.
Один и тот же UUID можно использовать в нескольких сценах с разными start/fit/audio; удалить
или заменить опубликованный asset на месте в V1 нельзя.

Внешний `409` синхронно переводит браузер в отдельное конфликтное состояние ещё до асинхронной
перезагрузки: active/redo stacks очищаются, проверенный diff сбрасывается, а timeline, b-roll,
undo/redo и Save блокируются. Ошибка `GET /api/state` сохраняет quarantine и не разрешает discard.
Только успешно загруженный канонический state выставляет отдельный fresh-ready gate; после него
явное удаление устаревших правок снимает блокировку. Никакого silent rebase нет, и следующая
команда валидируется отдельно от свежей базы, поэтому дорефрешные команды не могут попасть в
новый replay. Тот же порядок действует для `409` от validate и save.

Asset registry публикует только browser-safe descriptors и capabilities. Изображения и
нормализованные видео можно назначать b-roll; audio-only остаётся только preview-активом и не
проходит командный/approval/render contract. Канонические ссылки, UUID, hashes и абсолютные пути
остаются server-side. Drag может притянуть границу к слову, Arrow — только к следующему кадру;
timing audit использует нормализованные word timestamps и объясняет `reason: frame|word`.

Token обычно передаётся только существующему browser-launch process. Для `--no-open` или ошибки
launch сервер вместо URL в stdout создаёт в системной temp-папке exclusive regular URL-файл
mode `0600`; stdout содержит лишь путь. Owned файл удаляется при закрытии сервера либо через
10 минут, а collision, symlink или ошибка записи закрывают старт сервера. CLI обрабатывает
обычные `SIGINT` и `SIGTERM` через `server.close()`: close-listener удаляет owned handoff до
завершения процесса. Для не перехватываемого `SIGKILL` cleanup намеренно не обещается.

`scripts/review/waveform.js` best-effort создаёт через argv-only ffmpeg изображение
`previews/review-waveform-<fingerprint>.png`. Fingerprint включает workspace-relative identity,
размер и временные метаданные исходника. Генерация идёт в непредсказуемый соседний temp,
проверяет regular file и публикует его атомарным rename; symlink и dangling symlink отклоняются.
Identity каталога `previews/` фиксируется до запуска ffmpeg и повторно сверяется через resolver,
realpath, device и inode после процесса и непосредственно перед rename. Если parent подменён,
публикация закрывается, а cleanup не следует по новому внешнему пути.
Ошибка или отсутствие ffmpeg дают `waveform: null` и не меняют manifest, brief или render state.
При успехе браузер видит только `{ url: "/media/waveform" }`, а timeline добавляет PNG внутрь
существующей дорожки исходника без отдельной пустой панели.

Workbench изолирован от OpenCut runtime/project format и Remotion Studio. Он не экспортирует
видео в браузере, не меняет текст, не делает global ripple и не реализует effects registry,
keyframes или masks. Канонический путь остаётся прежним: draft -> внешнее approval -> approved
brief -> `scripts/build.js --brief` -> Remotion. Перед вызовом Remotion lesson build копирует
source и все локальные legacy/structured b-roll в один immutable одноразовый каталог
`public/.automontage/`, переписывает только clone props на безопасные basenames, ещё раз сверяет
identity/hash и удаляет owned bundle после success/error. На iCloud File Provider допустим только
`ctime`-only metadata drift: при неизменных `dev/ino/size/mtime/mode/nlink` файл заново полностью
хэшируется и лишь затем получает новый bounded identity baseline. Если `ctime` сдвинулся во время
чтения, этот digest отбрасывается и выполняется ограниченный полный повтор. Изменение bytes или
любого другого identity-поля останавливает build до Remotion. Approved JSON не меняется.

## 4. Remotion-слой

`src/index.js` регистрирует композиции через `src/Root.jsx`.

- `Dynamic` – блоки из scenario: карточки, счётчики, b-roll, CTA и субтитры.
- `ReelScenes` – официальная библиотека lesson-сцен через `SceneDirector`.
- `LessonSeq` и связанные lesson-композиции – ранний слайдовый путь, сохранённый в коде.
- Демо-композиции используют готовые данные из `src/scenario-*.js` и `examples/`.

`SceneDirector.jsx` раскладывает сцены по глобальным таймкодам. Видео внутри каждой сцены
получает `trimBefore`, равный глобальному стартовому кадру; единая аудиодорожка не сбрасывается.
Сцены соединяются непрозрачным hard cut: fade-in без перекрытия запрещён, потому что он создавал
пустой кадр на каждом стыке.

`src/scenes/BrollMedia.jsx` сохраняет legacy image через `Img`, а structured video выводит через
Remotion `OffthreadVideo`. `trimBefore = round(trimStartSec × fps)`, а длину ограничивает
родительская scene `Sequence`. `mute` выключает только клип; `mix` оставляет исходный голос и
подаёт клип с постоянным коэффициентом −18 dB; `replace` плавно меняет source/clip gain на
границах сцены. Музыка остаётся отдельной root-level дорожкой. Отдельный loudness pass для
каждого b-roll asset в V1 намеренно не выполняется.

Официальные lesson-сцены находятся в `src/scenes/scenes.jsx`:

| JSON-ключ | Назначение |
|---|---|
| `fullscreen` | спикер на весь экран, короткая подпись |
| `split` | спикер + заголовок и тезисы |
| `bottom-diagram` | последовательность шагов |
| `blur-overlay` | сильный числовой или смысловой акцент |
| `text-only` | крупная цитата без спикера |
| `stat` | реально произнесённая метрика |
| `broll` | визуальный пример из доступного файла |

`chart` реализован как эксперимент, но запрещён в автоматическом lesson-brief.

## 5. Скрипты и ответственность

| Область | Основные файлы |
|---|---|
| Пользовательский CLI | `scripts/cli.js`, `scripts/doctor.js` |
| Оркестрация и процессы | `scripts/build.js`, `scripts/env.js`, `scripts/process.js`, `scripts/media-probe.js`, `scripts/source-timing.js` |
| Папки и версии роликов | `scripts/project/workspace.js`, `scripts/project/build-context.js` |
| Транскрипция и субтитры | `scripts/transcribe.py`, `scripts/build-captions.js` |
| Lesson brief | `scripts/gen-brief.js`, `scripts/lesson/*` |
| Локальная проверка | `scripts/review/*`, `review/*` |
| Валидация и качество | `scripts/validate.js`, `scripts/quality-gate.js`, `scripts/dynamic-gate.js` |
| Монтаж аудио/видео | `scripts/finish.js`, `scripts/finish-audio.js`, `scripts/mix-music.js`, `scripts/pack-tg.js` |
| Длинные рендеры | `scripts/render-chunks.js` |
| Паузы и кадрирование | `scripts/tighten.js`, `scripts/cut-pauses.js`, `scripts/reframe.py`, `scripts/face-center.py` |
| Внешние темы | `scripts/load-ext-theme.js` |
| Release gates | `scripts/check-release.js`, `scripts/smoke-release.js` |

Длинный рендер хранит части в `out/.chunks/<job-sha256>/`. Cache descriptor v2 включает
composition, канонизированные props, identities source/audio, диапазоны и Remotion options,
а также identity реализации рендера: всего `src/`, `package.json` и `package-lock.json`. Для каждого реально
упомянутого в props файла из `public/` сохраняются JSON pointer, размер и SHA-256; остальные
ресурсы `public/` на key не влияют. Канонические props убирают volatile path только у generated
`.automontage/<lease>/source.<ext>`, поэтому новый lease с теми же байтами продолжает resume.
Обычные asset paths и произвольные видимые строки сохраняются: два разных b-roll path с
одинаковыми байтами дают разные keys. Также сохраняется исходный порядок ключей props, наблюдаемый
Remotion. Общий resolver public media отклоняет symlink на любом
сегменте и любой realpath escape. Обход `src/` сортирует POSIX-relative paths и не следует
symlink; symlink прерывает построение cache key.

## 6. Данные и артефакты

- `projects/YYYY.MM.DD_<slug>/` – основной локальный workspace одного ролика. В нём лежат
  `project.json`, один исходник, транскрипт, ревизии brief, активы, превью, версии рендера и финал.
- `project.json` – журнал относительных project-путей, статусов brief и рендеров. Только
  `source.originalPath` хранит исторический абсолютный путь исходника.
- `assets/broll/images|video/<uuid>/` – immutable normalized master и bounded `asset.json`;
  `previews/broll/<uuid>.webm` – браузерный video proxy. Review показывает их только через
  token-protected opaque routes.
- `out/<id>.transcript.json` и `out/<id>.captions.js` – generated data legacy-режима;
  отслеживаемые `src/data/` остаются только историческими fixtures и не перезаписываются.
- `props/` – входные props и сценарии для воспроизводимых рендеров.
- `public/` – ресурсы, доступные Remotion. Личные `public/source*.mp4`, музыка и `public/efir/`
  игнорируются. На время рендера исходник копируется в уникальный lease
  `public/.automontage/<safe-namespace>-<uuid>/source.<ext>` и удаляется в `finally`.
- `out/` – legacy/cache-путь для запуска без `--project` и `--project-dir`.
- `tmp/` – промежуточные файлы.
- `examples/` – небольшие публичные входы для проверки установки.

Public source bridge изолирован: каждый build получает свой media lease, поэтому второй
рендер не может подменить байты источника первого. Lease удаляется после успеха и ошибки;
cleanup проверяет, что удаляет только свой настоящий каталог, а не symlink или общий base.
Статические/pre-existing symlink и symlink в финальном компоненте lease отклоняются до удаления.
Node не предоставляет portable descriptor-relative `unlinkat`/`openat`, поэтому соперничающий
вредоносный локальный процесс всё ещё может заменить parent между проверкой и `rm`: такой TOCTOU
вне модели угроз при одном доверенном build на checkout, а не дополнительная гарантия lease.
Но `tmp/` и legacy-пути пока общие, поэтому один checkout по-прежнему допускает только одну
активную сборку. Для параллельных рендеров нужны отдельные clone/worktree.

## 7. Переменные окружения

Источник списка – обращения к `process.env` в коде; значения хранятся только локально.

| Переменная | Обязательность | Назначение |
|---|---|---|
| `ANTHROPIC_API_KEY` | одна из двух для создания lesson draft | LLM-проруф и раскладка сцен |
| `OPENAI_API_KEY` | альтернатива Anthropic | LLM-проруф, lesson brief и слайды |
| `THEMES_EXT` | опционально | корневая папка внешних тем `<id>/theme.json` |
| `AUTOMONTAGE_FFMPEG_DIR` | опционально | каталог отдельной `ffmpeg` + `ffprobe`; CLI ставит его первым в дочерний `PATH` |

Основной Dynamic-рендер и `automontage demo` работают без API-ключей.

## 8. Внешние зависимости

- Node.js 20+ и npm – CLI, тесты, Remotion.
- Python 3 + пакеты из `requirements.txt` – Whisper/OpenCV-сценарии.
- ffmpeg/ffprobe – анализ, аудио, нормализация импорта, сборка и контроль результата. Для фото
  в Review обязателен encoder `libwebp`; video import также использует `libx264`, `libvpx`,
  `libopus` и AAC. `automontage doctor` проверяет WebP и объясняет выбор отдельной полной сборки.
- Chromium для Playwright – browser regression tests и пересборка PNG-моков скриптами
  `shot-*`; обычный Review открывается в установленном системном браузере.

## 9. Инварианты безопасности и качества

- Тексты и числа lesson-сцен происходят из транскрипта, а не из фантазии модели.
- Draft не рендерится; approved brief проверяется до тяжёлых шагов.
- Явный неизвестный theme id не подменяется на `craft`: внешняя тема обязана успешно
  загрузиться через `THEMES_EXT` до Remotion.
- Формат по умолчанию наследуется от исходника.
- Все визуальные слои используют общий таймкод; A/V-синхрон проверяется в начале, середине и конце.
- Тексты должны оставаться в safe-zone обеих ориентаций.
- Секреты, приватные темы, пользовательские медиа и локальная память не попадают в Git.
- Внешние инструменты получают отдельные argv без shell; длинные процессы наследуют stdio,
  а короткий capture ограничен явным `maxBuffer` и проверяет error/status/signal.
- Release checker читает committed Git-объект, а не рабочую папку; smoke подтверждает оба
  публичных render path и после них сверяет hashes защищённых transcript/captions fixtures.
- Временное принятие dependency advisory допустимо только через неистёкшую машинно
  проверяемую запись в `SECURITY.md`: review date совпадает с датой текущего release, не лежит
  в будущем, а документированная цепочка точно совпадает с candidate `package-lock.json`.

## 10. Как расширять

- Новая встроенная тема: добавить файл в `src/theme/` и зарегистрировать в `src/theme/index.js`.
- Приватная тема: положить `<theme-id>/theme.json` вне репозитория и задать `THEMES_EXT`.
- Новый Dynamic-блок: компонент в `src/blocks/`, поддержка в `Timeline`, контракт в
  `schema/scenario.schema.json`, тест и документация.
- Новая официальная lesson-сцена: это изменение продуктового контракта. Нужны компонент,
  адаптив обеих ориентаций, safe-zone, brief-схема, нормализация в `gen-brief`, тесты,
  обновление `docs/TEMPLATES.md` и отдельное решение в `DECISIONS.md`.
