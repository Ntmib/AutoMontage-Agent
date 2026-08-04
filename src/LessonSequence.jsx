import { AbsoluteFill, Sequence, Audio, staticFile, useVideoConfig } from 'remotion';
import { FontStyle } from './fonts';
import { ThemeContext, getTheme } from './theme';
import { LessonBackground, LessonTopBar, SpeakerCard, SlidePanel } from './blocks/LessonSlide';

// Секвенсор шаблона lesson-presentation.
// Карточка спикера (видео лица) держится постоянно слева; справа слайды
// сменяются по таймкодам монтажного листа. Каждый слайд играет свой вход.
export const LessonSequence = ({ theme = 'lesson-neutral', slides = [], faceSrc = null, facePos = null, audioSrc = null, name, role, videoTitle = 'ВИДЕО', showCounter = false }) => {
  const t = getTheme(theme);
  const { fps } = useVideoConfig();
  const total = String(slides.length).padStart(2, '0');
  const CARD = { position: 'absolute', left: 96, top: 190, width: 700, bottom: 84, display: 'flex' };
  const PANEL = { position: 'absolute', left: 860, top: 190, right: 96, bottom: 84, display: 'flex' };

  return (
    <ThemeContext.Provider value={t}>
      <AbsoluteFill style={{ background: t.colors.bg, fontFamily: t.fonts.body, color: t.colors.cream || t.colors.text, overflow: 'hidden' }}>
        <FontStyle />
        {audioSrc && <Audio src={audioSrc.startsWith('http') ? audioSrc : staticFile(audioSrc)} />}
        <LessonBackground />

        {/* СТАТИЧНЫЙ заголовок видео (не меняется со слайдами) */}
        <LessonTopBar title={videoTitle} total={total} showCounter={showCounter} />

        {/* карточка спикера, постоянная, лицо центрируется по facePos */}
        <div style={CARD}><SpeakerCard name={name} role={role} faceSrc={faceSrc} facePos={facePos} /></div>

        {/* слайды по таймкодам (справа) */}
        {slides.map((sl, i) => {
          const from = Math.round((sl.start || 0) * fps);
          const dur = Math.max(1, Math.round(((sl.end ?? (sl.start || 0) + 4) - (sl.start || 0)) * fps));
          return (
            <Sequence key={i} from={from} durationInFrames={dur} layout="none">
              <div style={PANEL}><SlidePanel {...sl} dur={dur} /></div>
            </Sequence>
          );
        })}
      </AbsoluteFill>
    </ThemeContext.Provider>
  );
};
