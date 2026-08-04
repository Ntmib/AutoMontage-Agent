import { createContext, useContext } from 'react';
import craft from './craft';
import cyber from './cyber';
import lessonNeutral from './lesson-neutral';

const THEMES = { craft, cyber, 'lesson-neutral': lessonNeutral };

// name может быть: строкой ('craft'/'cyber') или объектом-темой
// (сгенерированным из палитры видео через scripts/palette.js).
export const getTheme = (name) => {
  if (name && typeof name === 'object' && name.colors) return name;
  return THEMES[name] || craft;
};

export const ThemeContext = createContext(craft);
export const useTheme = () => useContext(ThemeContext);

// helper: неоновое свечение текста, если тема его просит
export const glowText = (theme, color) =>
  theme.motion.glow ? `0 0 18px ${color}` : 'none';
