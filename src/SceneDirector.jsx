import { AbsoluteFill, Sequence, Audio, staticFile, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { FontStyle } from './fonts';
import { ThemeContext, getTheme } from './theme';
import { SCENES } from './scenes/scenes';
import { safeFor } from './scenes/safezone';

const src = (s) => (s && s.startsWith('http') ? s : staticFile(s));

// Мягкое появление сцены (кроссфейд-cut)
const FadeIn = ({ children, dur }) => {
  const frame = useCurrentFrame();
  const op = interpolate(frame, [0, 8, dur - 6, dur], [0, 1, 1, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity: op }}>{children}</AbsoluteFill>;
};

// Отладочная рамка сейф-зоны (тексты должны быть внутри)
const SafeGuide = () => {
  const { width, height } = useVideoConfig(); const s = safeFor(width, height);
  return <div style={{ position: 'absolute', left: s.left, right: s.right, top: s.top, bottom: s.bottom, border: '2px dashed rgba(0,255,120,.7)', pointerEvents: 'none', zIndex: 999 }} />;
};

// Режиссёр сцен: рендерит список сцен по таймкодам с переходами.
export const SceneDirector = ({ theme = 'lesson-neutral', scenes = [], faceSrc = null, facePos = null, audioSrc = null, videoTitle = 'ВИДЕО', debug = false }) => {
  const t = getTheme(theme);
  const { fps } = useVideoConfig();
  return (
    <ThemeContext.Provider value={t}>
      <AbsoluteFill style={{ background: t.colors.bg, fontFamily: t.fonts.body }}>
        <FontStyle />
        {audioSrc && <Audio src={src(audioSrc)} />}
        {scenes.map((sc, i) => {
          const from = Math.round((sc.start || 0) * fps);
          const dur = Math.max(1, Math.round(((sc.end ?? (sc.start || 0) + 3) - (sc.start || 0)) * fps));
          const Comp = SCENES[sc.scene] || SCENES.fullscreen;
          return (
            <Sequence key={i} from={from} durationInFrames={dur} layout="none">
              <FadeIn dur={dur}>
                <Comp {...sc} faceSrc={sc.faceSrc || faceSrc} facePos={sc.facePos || facePos} videoTitle={sc.videoTitle || videoTitle} />
              </FadeIn>
            </Sequence>
          );
        })}
        {debug && <SafeGuide />}
      </AbsoluteFill>
    </ThemeContext.Provider>
  );
};
