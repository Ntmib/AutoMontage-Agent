# Каталог сцен ReelScenes

Это полный повторно используемый набор lesson-сцен. Автоматический режиссёр выбирает только
из семи типов ниже; новая стилистическая просьба не должна создавать восьмой тип во время
монтажа клиентского ролика.

| Сцена | Когда использовать | Основные свойства |
|---|---|---|
| `fullscreen` | Хук, связка, вывод | `caption`; вариант `side-overlay` использует `steps`, `stepStartsSec`, `facePos`; `centerOnFade` за последнюю секунду переводит заголовок в центр |
| `split` | Основное объяснение | `num`, `headCream`, `headOrange`, `bullets`; `animated-gradient` и `bulletDelaySec` управляют подачей |
| `bottom-diagram` | Последовательность | `headCream`, `headOrange`, `steps` |
| `blur-overlay` | Сильный акцент | `label`, `big`, `headCream`, `headOrange`, `sub` |
| `text-only` | Дословная цитата | `label`, `quoteCream`, `quoteOrange`, `author` |
| `stat` | Произнесённая метрика | `label`, `statCream`, `statOrange`, `headCream`, `headOrange`, `sub` |
| `broll` | Реальный визуальный пример | `brollMedia`, `headCream`, `headOrange`, `sub`, `showSpeakerPip` |

## Отрицательное пространство и постепенный текст

`fullscreen.variant: "side-overlay"` помещает текст с противоположной стороны от лица в
горизонтальном кадре. `stepStartsSec` содержит локальные секунды появления элементов `steps` и
должен совпадать с произнесением соответствующих фраз. Без явных времён используется безопасная
последовательная подача. `centerOnFade: true` оставляет последнюю секунду для плавного переезда
заголовка в центр.

## Настоящий b-roll

`brollMedia` принимает изображение или видео. `brollMedia.fit` равен `contain` или `cover`.
Для видео `brollMedia.trimStartSec` задаёт глобально проверенный вход в клип, а
`brollMedia.audioMode` равен `mute`, `mix` или `replace`. Демонстрация экрана - всегда настоящее
видео, не zoom/pan скриншота. По умолчанию используется `audioMode: "mute"`, чтобы сохранить
голос мастера. `showSpeakerPip: false` убирает спикера поверх полноэкранного скринкаста.

Все цвета и шрифты берутся из `theme`; локальная FFmpeg-отрисовка текста не является сценой.
Публичные примеры: `examples/lesson-horizontal-workflow-draft.json` и
`examples/lesson-vertical-workflow-draft.json`.
