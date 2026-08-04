import { AbsoluteFill } from 'remotion';
import { FontStyle } from './fonts';
import { ThemeContext, getTheme } from './theme';
import { LessonBackground, LessonTopBar, SpeakerCard, SlidePanel } from './blocks/LessonSlide';

// Вертикальный шаблон lesson-presentation для Stories/Shorts (9:16).
// Тот же грунж-стиль и элементы, но спикер СВЕРХУ, контент слайда СНИЗУ.
// imagePos: 'top' (по умолчанию) или 'bottom' = где карточка со спикером/картинкой.
export const LessonVertical = ({ theme = 'lesson-neutral', slide = {}, faceSrc = null, facePos = null, name, role, videoTitle = 'ВИДЕО', imagePos = 'top' }) => {
  const t = getTheme(theme);
  const CARD = { position: 'absolute', left: 80, right: 80, height: 820, display: 'flex' };
  const PANEL = { position: 'absolute', left: 80, right: 80, height: 720, display: 'flex' };
  const top = imagePos === 'top'
    ? { card: { ...CARD, top: 190 }, panel: { ...PANEL, top: 1050 } }
    : { card: { ...CARD, bottom: 90 }, panel: { ...PANEL, top: 190 } };

  return (
    <ThemeContext.Provider value={t}>
      <AbsoluteFill style={{ background: t.colors.bg, fontFamily: t.fonts.body, color: t.colors.cream || t.colors.text, overflow: 'hidden' }}>
        <FontStyle />
        <LessonBackground />
        <LessonTopBar title={videoTitle} showCounter={false} />
        <div style={top.card}><SpeakerCard name={name} role={role} faceSrc={faceSrc} facePos={facePos} fullWidth /></div>
        <div style={top.panel}><SlidePanel {...slide} /></div>
      </AbsoluteFill>
    </ThemeContext.Provider>
  );
};
