import { spring, interpolate } from 'remotion';

// Пружинный вход 0..1 с задержкой
export const springIn = (frame, fps, delay = 0, config = { damping: 14, mass: 0.9 }) =>
  spring({ frame: frame - delay, fps, config });

// Печать по буквам
export const typed = (frame, start, end, text) =>
  text.slice(0, Math.floor(clamp(frame, start, end, 0, text.length)));

// Накрутка числа 0→to (с разделением тысяч)
export const countUp = (frame, start, end, to) =>
  Math.round(clamp(frame, start, end, 0, to));

export const fmt = (n) => n.toLocaleString('ru-RU');

// Клэмп-интерполяция
export const clamp = (frame, a, b, from, to) =>
  interpolate(frame, [a, b], [from, to], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

// Мигающий курсор
export const caret = (frame, until) => frame % 16 < 8 && frame < until;
