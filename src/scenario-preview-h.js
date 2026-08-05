import { CAPTIONS } from './data/captions';

// ПРЕВЬЮ-ролик – ГОРИЗОНТАЛЬНАЯ версия. 1280x720.
// Правила соблюдены:
//  1) Плашки НЕ на лицо: стороны из autopos (analyze-frames по всему интервалу),
//     лицо в центре x0.37–0.61 → плашки в боковых колонках, чередуя право/лево.
//  2) Врезки используют только воспроизводимые CSS-мокапы из репозитория.
//  3) A/V-синхрон: музыка по длине видео (mix-music duration=first) + pack-tg cfr.
export const scenarioPreviewH = {
  source: 'source_h.mp4',
  theme: 'craft',
  width: 1280, height: 720, fps: 25,
  durationInFrames: 3100,
  beatZoom: true, beatSec: 3,
  audio: { music: { file: 'assets/music/trap.wav', gain_db: 1, ducking: { threshold_db: -24, reduction_db: 6, attack_ms: 8, release_ms: 420 } } },
  blocks: [
    { type: 'LabelTop', start: 0.3, text: '>_ ПРОКАЧАЙ АГЕНТА' },
    { type: 'CaptionsAuto', start: 0, groups: CAPTIONS, pos: 'bottom', offset: 40 },

    { type: 'SubtitleCard', start: 1.2, end: 4.0, text: 'Прокачай агента', accent: true, pos: { h: 'right', v: 'top' } },
    { type: 'SubtitleCard', start: 6.2, end: 8.0, text: 'Смонтировано агентом', accent: false, pos: { h: 'left', v: 'top' } },

    { type: 'InfoCard', start: 9.5, end: 13.5, tag: '// АГЕНТ', title: 'МОНТАЖЁР В КАРМАНЕ', pills: ['без программ'], pos: { h: 'right', v: 'top' } },

    // врезка 1 – рабочее место
    { type: 'BrollFullscreen', start: 15.5, end: 19.0, image: 'broll/screenshot.png', caption: 'готовый ролик за минуты', fit: 'cover', transition: 'slide' },
    // врезка 2 – таймлайн
    { type: 'BrollFullscreen', start: 21.5, end: 23.0, image: 'broll/screenshot.png', caption: 'таймлайн', fit: 'contain', transition: 'wipe' },

    { type: 'SubtitleCard', start: 25.2, end: 28.0, text: 'Субтитры слово в слово', accent: true, pos: { h: 'left', v: 'top' } },

    // врезка 3 – нейтральный интерфейс
    { type: 'BrollFullscreen', start: 30.5, end: 32.0, image: 'broll/screenshot.png', caption: 'монтаж', fit: 'cover', transition: 'slide' },

    { type: 'CounterCard', start: 35.5, end: 39.2, label: 'ЭКОНОМИЯ', value: 100000, unit: '₽/мес', pos: { h: 'right', v: 'top' } },
    // врезка 4 – рост/экономия
    { type: 'BrollFullscreen', start: 39.5, end: 44.0, image: 'broll/growth.png', caption: '100 000 ₽ экономии', fit: 'contain', transition: 'slide' },

    { type: 'SubtitleCard', start: 45.5, end: 48.5, text: 'Подписи в момент', accent: false, pos: { h: 'left', v: 'top' } },
    // врезка 5 – программа монтажа
    { type: 'BrollFullscreen', start: 48.8, end: 50.3, image: 'broll/screenshot.png', caption: 'редактор', fit: 'contain', transition: 'wipe' },

    // врезка 6 – генерация картинки ИИ
    { type: 'BrollFullscreen', start: 51.0, end: 55.5, image: 'broll/growth.png', caption: 'сгенерирует картинку под смысл', fit: 'cover', transition: 'slide' },

    { type: 'SubtitleCard', start: 62.0, end: 65.0, text: 'Реалистичное фото', accent: true, sub: 'на весь экран', pos: { h: 'right', v: 'top' } },
    // врезка 7 – нейтральная иллюстрация
    { type: 'BrollFullscreen', start: 65.5, end: 69.5, image: 'broll/iphone.png', caption: 'визуальная врезка', fit: 'cover', transition: 'wipe' },

    // врезка 8 – скриншот кадра
    { type: 'BrollFullscreen', start: 73.0, end: 79.0, image: 'broll/screenshot.png', caption: 'скриншот твоего кадра', fit: 'contain', transition: 'slide' },

    { type: 'SubtitleCard', start: 84.0, end: 88.5, text: 'Музыка под голос', accent: false, sub: 'голос на 1-м плане', pos: { h: 'left', v: 'top' } },
    // врезка 9 – нейтральный таймлайн
    { type: 'BrollFullscreen', start: 89.0, end: 90.5, image: 'broll/screenshot.png', caption: 'звук', fit: 'cover', transition: 'wipe' },

    { type: 'SubtitleCard', start: 96.5, end: 99.5, text: 'Следит за лицом', accent: true, pos: { h: 'right', v: 'top' } },
    // врезка 10 – вертикаль на телефоне
    { type: 'BrollFullscreen', start: 99.8, end: 103.0, image: 'broll/iphone.png', caption: 'сам делает вертикаль', fit: 'contain', transition: 'slide' },

    { type: 'InfoCard', start: 103.5, end: 107.5, tag: '// ФИНИШ', title: 'ГОТОВЫЙ РОЛИК', pills: ['под соцсети'], pos: { h: 'left', v: 'top' } },

    { type: 'SubtitleCard', start: 109.5, end: 112.5, text: 'Вместо целой команды', accent: false, pos: { h: 'right', v: 'top' } },
    { type: 'CTACard', start: 113.5, head: 'ПРОКАЧАЙ АГЕНТА', btn: 'экономь на монтаже', pos: { h: 'left', v: 'top' } },
  ],
};
