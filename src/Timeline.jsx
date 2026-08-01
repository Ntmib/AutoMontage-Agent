import {
  AbsoluteFill, OffthreadVideo, staticFile, Sequence,
  useVideoConfig, useCurrentFrame, interpolate,
} from 'remotion';
import { ThemeContext, getTheme } from './theme';
import { REGISTRY } from './blocks';
import { FontStyle } from './fonts';

// Движок: читает монтажный лист (props) и раскладывает блоки по таймкодам.
// Стиль задаётся полем theme — контент и стиль полностью разделены.
// ракурсы для зум-ритма: крупность + лёгкий сдвиг = «новый план» каждые ~3с
const POSES = [
  { s: 1.06, x: 0, y: 0 },
  { s: 1.16, x: 0, y: -2.5 },
  { s: 1.09, x: 2.5, y: 1 },
  { s: 1.18, x: -2.5, y: -3 },
  { s: 1.10, x: 0, y: 2 },
];
const smooth = (p) => p * p * (3 - 2 * p); // smoothstep

export const Timeline = ({ source = 'source.mp4', theme = 'craft', blocks = [], beatZoom = false, beatSec = 3 }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const t = getTheme(theme);
  const frame = useCurrentFrame();

  // зум-ритм: каждые beatSec секунд плавный переход к новому ракурсу
  let bg;
  if (beatZoom) {
    const P = beatSec * fps;
    const idx = Math.floor(frame / P);
    const a = POSES[idx % POSES.length];
    const b = POSES[(idx + 1) % POSES.length];
    const p = smooth((frame % P) / P);
    const s = a.s + (b.s - a.s) * p;
    const x = a.x + (b.x - a.x) * p;
    const y = a.y + (b.y - a.y) * p;
    bg = `scale(${s.toFixed(4)}) translate(${x.toFixed(2)}%, ${y.toFixed(2)}%)`;
  } else {
    bg = `scale(${interpolate(frame, [0, durationInFrames], [1.0, 1.08]).toFixed(4)})`;
  }

  return (
    <ThemeContext.Provider value={t}>
      <AbsoluteFill style={{ backgroundColor: t.colors.bg }}>
        <FontStyle />
        {/* видео-подложка с зум-ритмом */}
        <AbsoluteFill style={{ transform: bg }}>
          <OffthreadVideo src={staticFile(source)} />
        </AbsoluteFill>

        {/* блоки монтажного листа */}
        {blocks.map((b, i) => {
          const Comp = REGISTRY[b.type];
          if (!Comp) return null;
          const from = Math.round((b.start || 0) * fps);
          const dur = b.end
            ? Math.round((b.end - b.start) * fps)
            : durationInFrames - from;
          const { type, start, end, ...props } = b;
          return (
            <Sequence key={i} from={from} durationInFrames={Math.max(1, dur)}>
              <Comp {...props} />
            </Sequence>
          );
        })}
      </AbsoluteFill>
    </ThemeContext.Provider>
  );
};
