import { CAPTIONS } from './data/captions';

// ПРЕВЬЮ-ролик «что умеет автомонтаж» (вертикаль, reframe). 124с.
// Зум-ритм лица (beatZoom) + чередование с broll-врезками + плашки на фокусных словах.
export const scenarioPreview = {
  source: 'source.mp4',
  theme: 'craft',
  width: 1080, height: 1920, fps: 25,
  durationInFrames: 3100,
  beatZoom: true, beatSec: 3,
  audio: { music: { file: 'assets/music/lofi.wav', gain_db: 2, ducking: { threshold_db: -24, reduction_db: 6, attack_ms: 8, release_ms: 420 } } },
  blocks: [
    { type: 'LabelTop', start: 0.3, text: '>_ ПРОКАЧАЙ АГЕНТА' },
    { type: 'CaptionsAuto', start: 0, groups: CAPTIONS, pos: 'top', offset: 150 },

    // хук
    { type: 'SubtitleCard', start: 1.2, end: 4.0, text: 'Прокачай агента', accent: true, sub: 'смотри результат' },
    { type: 'SubtitleCard', start: 6.2, end: 8.0, text: 'Смонтировано агентом', accent: false, sub: 'от и до' },

    // агент-монтажёр
    { type: 'InfoCard', start: 9.5, end: 13.5, tag: '// АГЕНТ', title: 'МОНТАЖЁР В КАРМАНЕ', pills: ['без программ', 'без монтажёра'] },

    // готовый ролик за минуты → врезка «экран монтажки»
    { type: 'BrollFullscreen', start: 15.5, end: 19.0, image: 'broll/screenshot.png', caption: 'готовый ролик за минуты' },

    // субтитры слово в слово
    { type: 'SubtitleCard', start: 25.2, end: 28.0, text: 'Субтитры слово в слово', accent: true },

    // плашки/анимация/цифра → сначала счётчик 100 000 ₽ на лице, потом график
    { type: 'CounterCard', start: 35.5, end: 39.2, label: 'ЭКОНОМИЯ НА МОНТАЖЕ', value: 100000, unit: '₽/мес' },
    { type: 'BrollFullscreen', start: 39.5, end: 44.0, image: 'broll/growth.png', caption: '100 000 ₽ экономии' },

    // подписи в нужный момент
    { type: 'SubtitleCard', start: 45.5, end: 48.5, text: 'Подписи в момент', accent: false },

    // картинку сгенерирует по смыслу → нейтральная врезка
    { type: 'BrollFullscreen', start: 51.0, end: 55.5, image: 'broll/growth.png', caption: 'сгенерирует картинку под смысл' },

    // нейтральная иллюстрация на весь экран
    { type: 'SubtitleCard', start: 62.0, end: 65.0, text: 'Реалистичное фото', accent: true, sub: 'на весь экран' },
    { type: 'BrollFullscreen', start: 65.5, end: 69.5, image: 'broll/screenshot.png', caption: 'визуальная врезка' },

    // «сделай скриншот» → скриншот его кадра в редакторе
    { type: 'BrollFullscreen', start: 73.0, end: 79.0, image: 'broll/screenshot.png', caption: 'скриншот твоего кадра' },

    // звук/музыка под голос
    { type: 'SubtitleCard', start: 84.0, end: 88.5, text: 'Музыка под голос', accent: false, sub: 'голос на 1-м плане' },

    // горизонт→вертикаль, следит за лицом → врезка iphone
    { type: 'SubtitleCard', start: 96.5, end: 99.5, text: 'Следит за лицом', accent: true },
    { type: 'BrollFullscreen', start: 99.8, end: 103.0, image: 'broll/iphone.png', caption: 'сам делает вертикаль' },

    // под соцсети
    { type: 'InfoCard', start: 103.5, end: 107.5, tag: '// ФИНИШ', title: 'ГОТОВЫЙ РОЛИК', pills: ['звук', 'картинка', 'под соцсети'] },

    // финал — прокачай агента вместо команды
    { type: 'SubtitleCard', start: 109.5, end: 112.5, text: 'Вместо целой команды', accent: false },
    { type: 'CTACard', start: 113.5, head: 'ПРОКАЧАЙ АГЕНТА', btn: 'экономь на монтаже' },
  ],
};
