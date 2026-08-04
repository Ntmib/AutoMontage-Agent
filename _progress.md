# Прогресс: lesson через утверждённые ReelScenes

Цель: сделать горизонтальные версии грандж-сцен и подключить двухступенчатый lesson-процесс
«draft-ТЗ -> утверждение -> ReelScenes» с форматом исходника по умолчанию и явным override.
Ветка: agent/lesson-presentation. Тема dima-grunge приходит из props (приватная).

## Сцены (адаптив width>height):
- [x] fullscreen (центр)
- [x] split -> ГОРИЗОНТ: спикер-карточка слева | номер+заголовок+буллеты справа
- [x] bottom-diagram -> ГОРИЗОНТ: спикер слева | заголовок+схема справа
- [x] blur-overlay (центр)
- [x] text-only (центр)
- [x] stat (центр)
- [x] broll (картинка фон, спикер-карточка в угол, текст снизу)
- [x] chart (экспериментальная, не входит в официальную библиотеку из 7 сцен)

## Шаги
- [x] baseline рендер 1920x1080 (увидеть что ломается)
- [x] адаптив каждой сцены + рендер-проверка кадра
- [x] демо-ролик горизонт все сцены -> показать Диме
- [x] подключить build.js: без brief создаётся draft-ТЗ, approved brief рендерит ReelScenes
- [x] формат source по умолчанию + vertical/horizontal override
- [x] добавить gen-brief.js: 7 готовых сцен, словарь, проруф, Markdown + JSON
- [x] запретить рендер draft, другого исходника, темы и аспекта
- [x] добавить утверждаемое кадрирование facePos + faceZoom
- [x] закоммитить исправления сцен отдельно
- [x] закоммитить build.js после согласования

## Тестовые данные
- faceSrc/audioSrc: public/source.mp4 (gitignored, локально)
- тема: dima-grunge из локального automontage-dima-brand через THEMES_EXT
- прямой remotion render не вызывает load-ext-theme.js, поэтому для точного локального
  теста тема передана объектом в inline props; build.js уже умеет загружать внешний JSON

## Проверено 2026-08-04

- Финальный рендер: out/scenes-h.mp4, H.264, 1920x1080, 24 секунды
- Текст всех 8 сцен внутри SAFE_16x9
- Вертикальные split, bottom-diagram и broll повторно проверены после правок
- Коммиты: f9c3752 (SceneBg), 56e9b05 (split), 776033e (bottom-diagram), 4de6790 (broll)
- Unit-тесты: 30/30 зелёные через npm test
- Draft-гейт проверен реальным build.js: Remotion не запускается
- Approved source-рендер: out/lesson-approved-h.mp4, 1920x1080, 25 FPS, H.264 + AAC
- Approved vertical override из того же исходника: out/lesson-approved-v.mp4, 1080x1920,
  25 FPS, H.264 + AAC; лицо центрировано, посторонний экран убран через facePos + faceZoom
- Коммиты интеграции: f0a719f (aspect), a9b4bef (brief), 926c97a (gen-brief),
  e037cad (build.js), f0eb0ce (speaker crop)
