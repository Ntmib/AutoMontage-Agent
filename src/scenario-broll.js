import { CAPTIONS } from './data/captions';

// Демо этапа 3: субтитры + полноэкранная broll-врезка на 6.2–9.5с.
export const scenarioBroll = {
  source: 'source.mp4',
  theme: 'craft',
  blocks: [
    { type: 'LabelTop', start: 0.3, text: '>_ АНОНС' },
    { type: 'CaptionsAuto', start: 0, groups: CAPTIONS, offset: 300 },
    {
      type: 'BrollFullscreen', start: 6.2, end: 9.5,
      image: 'broll/growth.png', caption: 'рост х10 за 2,5 месяца',
    },
  ],
};
