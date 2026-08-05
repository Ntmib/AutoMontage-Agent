import { CAPTIONS } from './data/captions';

// Боевой ролик Димы (горизонт 1870x1080): автомонтаж агентами.
export const scenarioJob1 = {
  source: 'source.mp4',
  theme: 'craft',
  width: 1870, height: 1080, fps: 25,
  durationInFrames: 1325, // 53с * 25
  blocks: [
    { type: 'LabelTop', start: 0.3, text: '>_ АВТОМОНТАЖ' },
    // субтитры сверху (снизу — плашки-события)
    { type: 'CaptionsAuto', start: 0, groups: CAPTIONS, pos: 'top', offset: 56 },

    // вступление: 2 дня учу агентов
    {
      type: 'InfoCard', start: 1.4, end: 6.8,
      tag: '// ЭКСПЕРИМЕНТ', title: 'УЧУ АГЕНТОВ МОНТИРОВАТЬ',
      countPill: { value: 2, suffix: 'дня' }, pills: ['контент на вайбе'],
    },

    // «может появиться плашка — это сделал агент»
    { type: 'SubtitleCard', start: 15.3, end: 18.8, text: 'Это сделал агент', accent: true, sub: 'плашка появилась сама' },

    // «накладываются картинки, генерирует под запрос» → broll агент монтирует
    { type: 'BrollFullscreen', start: 19.4, end: 24.3, image: 'broll/screenshot.png', caption: 'агент генерирует картинку под запрос' },

    // «делай скриншот этого видео» → broll скриншот
    { type: 'BrollFullscreen', start: 25.4, end: 31.0, image: 'broll/screenshot.png', caption: 'скриншот готов за секунду' },

    // «это видео смонтировано полностью агентами»
    { type: 'SubtitleCard', start: 36.5, end: 40.5, text: 'Смонтировано агентами', accent: false, sub: 'от и до' },

    // финал-объявление
    { type: 'CTACard', start: 47.5, head: 'ЗАВТРА СМОЖЕТЕ ВЫ', btn: 'у кого наши агенты' },
  ],
};
