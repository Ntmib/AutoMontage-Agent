import { CAPTIONS } from './data/captions';

// Демо этапа 4: лейбл + авто-субтитры по всей речи.
export const scenarioCaptions = {
  source: 'source.mp4',
  theme: 'craft',
  blocks: [
    { type: 'LabelTop', start: 0.3, text: '>_ АНОНС' },
    { type: 'CaptionsAuto', start: 0, groups: CAPTIONS, offset: 300 },
  ],
};
