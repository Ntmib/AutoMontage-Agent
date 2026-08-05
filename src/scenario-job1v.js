import { CAPTIONS } from './data/captions';

// Боевой ролик – ВЕРТИКАЛЬНАЯ версия (reframe 16:9→9:16) с нейтральными broll.
// Таймкоды те же (reframe время не меняет).
export const scenarioJob1V = {
  source: 'source.mp4',
  theme: 'craft',
  width: 1080, height: 1920, fps: 25,
  durationInFrames: 1325,
  blocks: [
    { type: 'LabelTop', start: 0.3, text: '>_ АВТОМОНТАЖ' },
    { type: 'CaptionsAuto', start: 0, groups: CAPTIONS, pos: 'top', offset: 150 },

    { type: 'InfoCard', start: 1.4, end: 6.8, tag: '// ЭКСПЕРИМЕНТ',
      title: 'УЧУ АГЕНТОВ МОНТИРОВАТЬ', countPill: { value: 2, suffix: 'дня' }, pills: ['контент на вайбе'] },

    { type: 'SubtitleCard', start: 15.3, end: 18.8, text: 'Это сделал агент', accent: true, sub: 'плашка появилась сама' },

    // нейтральная врезка – интерфейс автомонтажа
    { type: 'BrollFullscreen', start: 19.4, end: 24.5, image: 'broll/screenshot.png', caption: 'агент монтирует за тебя' },

    // нейтральная врезка – автомонтаж в смартфоне
    { type: 'BrollFullscreen', start: 30.0, end: 35.0, image: 'broll/iphone.png', caption: 'автомонтаж в кармане' },

    { type: 'SubtitleCard', start: 36.5, end: 40.5, text: 'Смонтировано агентами', accent: false, sub: 'от и до' },

    { type: 'CTACard', start: 47.5, head: 'ЗАВТРА СМОЖЕТЕ ВЫ', btn: 'у кого наши агенты' },
  ],
};
