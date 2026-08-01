// Монтажный лист (демо). Контент отдельно от стиля.
// Меняешь theme: 'craft' → 'cyber' — тот же ролик в другом стиле.
export const scenario = {
  source: 'source.mp4',
  theme: 'craft',
  blocks: [
    { type: 'LabelTop', start: 0.3, text: '>_ АНОНС' },
    {
      type: 'InfoCard', start: 0.9, end: 6.0,
      tag: '// МАРАФОН', title: 'РЕСУРС НА МИЛЛИОН',
      countPill: { value: 3, suffix: 'дня' },
      pills: ['бесплатно'], progress: true,
    },
    {
      type: 'CounterCard', start: 6.3, end: 11.5,
      label: 'ВСЕГО ЛИШЬ', value: 5, unit: 'мин/день',
    },
  ],
};
