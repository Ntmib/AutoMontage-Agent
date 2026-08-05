import { AbsoluteFill } from 'remotion';
import { FontStyle } from './fonts';
import { ThemeContext, getTheme } from './theme';
import { LessonSlide } from './blocks/LessonSlide';

// Композиция шаблона lesson-presentation. theme приходит из props:
// строкой ('lesson-neutral') или объектом-темой (внешний бренд-пак через --props).
export const LessonComp = ({ theme = 'lesson-neutral', slide = {} }) => {
  const t = getTheme(theme);
  return (
    <ThemeContext.Provider value={t}>
      <AbsoluteFill>
        <FontStyle />
        <LessonSlide {...slide} />
      </AbsoluteFill>
    </ThemeContext.Provider>
  );
};
