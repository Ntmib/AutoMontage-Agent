# История изменений

Формат близок к Keep a Changelog, версии следуют SemVer. Здесь только заметные изменения
поведения; полный журнал разработки остаётся в Git.

## [Unreleased]

## [1.2.1] - 2026-08-05

### Исправлено

- Закрыт выход manifest-controlled путей, небезопасных slug/legacy id и `--outdir`-финала
  за разрешённые каталоги; path resolver отклоняет также dangling symlink на любом компоненте,
  а общий lesson/Dynamic export не следует static final или parent symlink.
- `project.json` публикуется через непредсказуемый exclusive temp, а утверждение brief атомарно
  согласует JSON, Markdown и manifest с cleanup/rollback при ошибке записи.
- Исходник каждого render получает отдельную public media lease вместо общего `public/source.mp4`;
  legacy scene-level `faceSrc` переводится на тот же lease, что top-level video/audio.
- Chunk cache инвалидируется при изменении Remotion-кода, lockfile, обычного public asset path
  или его байтов; случайный путь нормализуется только для generated source lease, включая
  источник без расширения и с непривычным расширением.
- Дробные FPS исходника, включая 30000/1001 и 24000/1001, передаются в Remotion без округления.
- Утверждённый Markdown brief регенерируется из approved JSON и больше не сохраняет статус draft.
- Release checker проверяет актуальную секцию версии, расширенный provenance бинарных файлов,
  свежую не будущую дату security review и точную dependency chain из candidate `package-lock.json`.

## [1.2.0] - 2026-08-05

### Добавлено

- Каноническая документация проекта: `AGENTS.md`, `ARCHITECTURE.md`, `TESTING.md`,
  `DECISIONS.md`, `.env.example` и CI.
- Локальные workspace-папки `projects/YYYY.MM.DD_<slug>/` с одним исходником, отдельным
  транскриптом, версиями brief/рендеров и каноническим final.
- Флаги `--project`, `--project-dir`, `--version-label` и команда фиксации approved brief.
- Project-режим для `lesson/ReelScenes` и `Dynamic` без изменения legacy-вывода в `out/`.
- Правила локальной трёхуровневой памяти для продолжения работы между сессиями.
- Двухслойная защита секретов: локальный pre-commit Gitleaks и полный Gitleaks-скан
  истории в GitHub Actions.
- GitHub Actions закреплены по commit SHA; Dependabot следит за npm и actions, а CI
  блокирует high/critical уязвимости зависимостей.
- В GitHub включены встроенные Secret Scanning, Push Protection и Dependabot Security Updates.
- Шаблон `lesson-presentation` с внешними темами и адаптивом 9:16/16:9.
- Библиотека из 7 официальных сцен и отдельный `ReelScenes`-режиссёр.
- Двухступенчатый процесс draft-ТЗ → явное утверждение → approved-рендер.
- Автоматический проруф, Markdown/JSON brief, словарь исправлений и проверенное кадрирование лица.
- Музыка в approved brief, выбор стартового фрагмента и скорости, анимации воронки,
  логотипов, CTA и живого градиента.
- `automontage doctor`, глобальный CLI и воспроизводимое демо без ключей.
- Общий checked process runner, строгий ffprobe parser и запуск локального Remotion CLI
  через текущий Node без `.cmd`, shell или fallback на скачивание через `npx`.
- Машинно проверяемый `ASSETS.md` с происхождением, лицензией и рецептом воспроизведения
  каждого публичного бинарного ассета, а также argv-only генераторы нейтральных fixtures.
- Object-aware `check:release` для точного Git-дерева и публичный smoke-runner двух путей
  рендера с медиапроверкой, manifest/hash-контролем и защитой transcript/captions.
- `SECURITY.md` с ограниченным по времени исключением для moderate advisory в optional
  `--autotheme`; release checker проверяет полноту записи и дату пересмотра.
- Публичные npm metadata: MIT license, repository/homepage/bugs и единый Node.js 20+
  contract в package и lock.

### Исправлено

- Публичный lesson-процесс теперь по умолчанию использует встроенную тему
  `lesson-neutral`; default Dynamic остаётся `craft`.
- Явная внешняя тема больше не подменяется молча на `craft`: отсутствующий pack,
  недопустимый id или повреждённый JSON останавливают сборку без раскрытия локального пути.
- Центральный `build.js` больше не собирает shell-строки из пользовательских путей и
  заранее отклоняет недопустимые numeric/reframe параметры.
- Сбой render, finish, music или публикации теперь фиксирует project-render как `failed`;
  canonical final заменяется атомарно только после успешной обработки.
- Finish, music mix и Telegram pack запускают ffmpeg без shell, валидируют filter/media
  параметры заранее; Telegram pack жёстко требует два потока и A/V drift меньше 80 мс.
- Нарезка пауз и filler-слов больше не интерполирует пути/тайминги в shell и очищает
  временный filter script даже после ошибки ffmpeg; positional maxGap/pad читаются верно.
- Порционный Remotion-рендер, покадровый concat и audio mux переведены на checked argv;
  незавершённый chunk больше не публикуется как готовый resume-файл.
- Resume cache порционного рендера теперь content-addressed и проверяет manifest,
  SHA-256, размер, диапазон и фактическое число кадров каждого chunk.
- Транскрипты разных роликов больше не перезаписывают общий `src/data/transcript.json` в
  project-режиме.
- Legacy-режим и `automontage demo` теперь хранят generated transcript/captions и demo MP4
  в игнорируемом `out/`, не затрагивая отслеживаемые `src/data/`.
- CLI не добавляет лишний `--outdir`, когда финалом владеет project-папка.
- Видеослой спикера теперь сохраняет глобальный таймкод при смене сцен.
- Компенсирована постоянная AAC-задержка после Remotion.
- Горизонтальные раскладки, safe-zone длинных метрик и тайминг коротких подписей.
- Защищён путь загрузки внешней темы от выхода за каталог `THEMES_EXT`.
- Рассинхрон звука и видео после вырезания пауз и тишина на месте слов-паразитов.
- Финишный проход ограничивает отфильтрованный AAC длительностью видео, чтобы хвост
  `loudnorm` не создавал A/V drift выше 80 мс на коротких рендерах.
- Публичный demo-preview заменён на нейтральный рендер без человека и сторонней музыки;
  персональные стоп-кадры удалены, а HTML-мокапы теперь строятся только средствами CSS.
- Удалены b-roll и логотипы без записанного источника распространения; архивные сценарии
  используют воспроизводимые CSS-мокапы, а названия соцсетей – нейтральные текстовые метки.

## [1.1.0] - 2026-08-02

### Добавлено

- Кросс-платформенная работа на Windows, macOS и Linux.
- `requirements.txt` для Python-зависимостей и глобальная команда `automontage`.

### Безопасность

- Remotion обновлён до 4.0.504; закрыты известные уязвимости предыдущей версии.

## [1.0.0] - 2026-08-01

### Добавлено

- Первая версия AutoMontage-Agent: Remotion-композиции, темы, блоки, монтажный лист,
  локальная транскрибация и ffmpeg-пайплайн.
