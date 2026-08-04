import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { FontStyle } from './fonts';
import { ThemeContext, getTheme } from './theme';
import { LessonBackground, LessonTopBar, SpeakerCard, SlidePanel } from './blocks/LessonSlide';

// Секвенсор шаблона lesson-presentation.
// Карточка спикера (видео лица) держится постоянно слева; справа слайды
// сменяются по таймкодам монтажного листа. Каждый слайд играет свой вход.
export const LessonSequence = ({ theme = 'lesson-neutral', slides = [], faceSrc = null, name, role }) => {
  const t = getTheme(theme);
  const { fps } = useVideoConfig();
  const total = String(slides.length).padStart(2, '0');
  const CARD = { position: 'absolute', left: 96, top: 190, width: 700, bottom: 84, display: 'flex' };
  const PANEL = { position: 'absolute', left: 860, top: 190, right: 96, bottom: 84, display: 'flex' };

  return (
    <ThemeContext.Provider value={t}>
      <AbsoluteFill style={{ background: t.colors.bg, fontFamily: t.fonts.body, color: t.colors.cream || t.colors.text, overflow: 'hidden' }}>
        <FontStyle />
        <LessonBackground />

        {/* карточка спикера, постоянная */}
        <div style={CARD}><SpeakerCard name={name} role={role} faceSrc={faceSrc} /></div>

        {/* слайды по таймкодам */}
        {slides.map((sl, i) => {
          const from = Math.round((sl.start || 0) * fps);
          const dur = Math.max(1, Math.round(((sl.end ?? (sl.start || 0) + 4) - (sl.start || 0)) * fps));
          return (
            <Sequence key={i} from={from} durationInFrames={dur} layout="none">
              <LessonTopBar num={sl.num || String(i + 1).padStart(2, '0')} total={total} badgeTop={sl.badgeTop} />
              <div style={PANEL}><SlidePanel {...sl} dur={dur} /></div>
            </Sequence>
          );
        })}
      </AbsoluteFill>
    </ThemeContext.Provider>
  );
};
