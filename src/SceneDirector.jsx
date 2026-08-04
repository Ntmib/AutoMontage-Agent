import { AbsoluteFill, Sequence, Audio, staticFile, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { FontStyle } from './fonts';
import { ThemeContext, getTheme } from './theme';
import { SCENES } from './scenes/scenes';
import { safeFor } from './scenes/safezone';

const src = (s) => (s && s.startsWith('http') ? s : staticFile(s));

export const getSceneTiming = (scene, fps) => {
  const start = scene.start || 0;
  const from = Math.round(start * fps);
  const durationInFrames = Math.max(1, Math.round(((scene.end ?? start + 3) - start) * fps));
  return { from, durationInFrames, sourceStartFrame: from };
};

export const getMusicVolume = (frame, {
  durationInFrames,
  fps,
  gainDb = -17,
  fadeInSec = 0,
  fadeOutSec = 0,
}) => {
  const base = 10 ** (gainDb / 20);
  const lastFrame = Math.max(0, durationInFrames - 1);
  const fadeInFrames = Math.max(0, Math.round(fadeInSec * fps));
  const fadeOutFrames = Math.max(0, Math.round(fadeOutSec * fps));
  const fadeIn = fadeInFrames > 0 ? Math.min(1, Math.max(0, frame / fadeInFrames)) : 1;
  const fadeOut = fadeOutFrames > 0
    ? Math.min(1, Math.max(0, (lastFrame - frame) / fadeOutFrames))
    : 1;
  return base * Math.min(fadeIn, fadeOut);
};

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
export const SceneDirector = ({ theme = 'lesson-neutral', scenes = [], faceSrc = null, facePos = null, faceZoom = 1, audioSrc = null, musicSrc = null, musicGainDb = -17, musicFadeInSec = 0, musicFadeOutSec = 0, videoTitle = 'ВИДЕО', debug = false }) => {
  const t = getTheme(theme);
  const { fps, durationInFrames } = useVideoConfig();
  return (
    <ThemeContext.Provider value={t}>
      <AbsoluteFill style={{ background: t.colors.bg, fontFamily: t.fonts.body }}>
        <FontStyle />
        {audioSrc && <Audio src={src(audioSrc)} />}
        {musicSrc && <Audio
          src={src(musicSrc)}
          volume={(frame) => getMusicVolume(frame, {
            durationInFrames,
            fps,
            gainDb: musicGainDb,
            fadeInSec: musicFadeInSec,
            fadeOutSec: musicFadeOutSec,
          })}
        />}
        {scenes.map((sc, i) => {
          const { from, durationInFrames, sourceStartFrame } = getSceneTiming(sc, fps);
          const Comp = SCENES[sc.scene] || SCENES.fullscreen;
          return (
            <Sequence key={i} from={from} durationInFrames={durationInFrames} layout="none">
              <FadeIn dur={durationInFrames}>
                <Comp {...sc} faceSrc={sc.faceSrc || faceSrc} facePos={sc.facePos || facePos} faceZoom={sc.faceZoom ?? faceZoom} sourceStartFrame={sourceStartFrame} videoTitle={sc.videoTitle || videoTitle} />
              </FadeIn>
            </Sequence>
          );
        })}
        {debug && <SafeGuide />}
      </AbsoluteFill>
    </ThemeContext.Provider>
  );
};
