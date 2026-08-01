import {
  AbsoluteFill, Img, OffthreadVideo, staticFile,
  useCurrentFrame, useVideoConfig, interpolate,
} from 'remotion';
import { useTheme, glowText } from '../theme';

// Полноэкранная врезка: картинка/видео перекрывает говорящую голову.
// Вход/выход fade, непрерывный зум (Ken Burns), подпись снизу в стиле темы.
// Звук исходника продолжает идти (фоновый OffthreadVideo в Timeline).
// transition — стиль входа/выхода врезки: 'fade' (по умолч.), 'slide', 'wipe'.
export const BrollFullscreen = ({ image, video, caption, fit = 'cover', transition = 'fade' }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = useTheme();

  const fade = 12; // кадров на вход/выход
  const kf = [0, fade, durationInFrames - fade, durationInFrames];
  const zoom = interpolate(frame, [0, durationInFrames], [1.05, 1.15]);
  const capY = interpolate(frame, [fade, fade + 8], [40, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  // выбор перехода
  let outer = {}, inner = {};
  if (transition === 'slide') {
    const tx = interpolate(frame, kf, [-100, 0, 0, 100], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    outer = { transform: `translateX(${tx}%)` };
  } else if (transition === 'wipe') {
    const w = interpolate(frame, kf, [0, 100, 100, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    outer = { clipPath: `inset(0 ${100 - w}% 0 0)` };
  } else {
    outer = { opacity: interpolate(frame, kf, [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) };
  }

  return (
    <AbsoluteFill style={outer}>
      <AbsoluteFill style={{ transform: `scale(${zoom})`, backgroundColor: t.colors.cardBg }}>
        {video ? (
          <OffthreadVideo src={staticFile(video)} muted />
        ) : (
          <Img src={staticFile(image)} style={{ width: '100%', height: '100%', objectFit: fit }} />
        )}
      </AbsoluteFill>

      {caption && (
        <div style={{
          position: 'absolute', bottom: 150, left: '50%',
          transform: `translateX(-50%) translateY(${capY}px)`,
          fontFamily: t.fonts.mono, fontWeight: 700, fontSize: 30, letterSpacing: 1,
          color: t.colors.milk, background: t.colors.accent,
          padding: '14px 30px', borderRadius: 14, textTransform: 'lowercase',
          boxShadow: t.motion.glow ? t.cardShadow : '0 12px 30px rgba(61,46,36,.4)',
          textShadow: glowText(t, t.colors.accent),
        }}>
          {caption}
        </div>
      )}
    </AbsoluteFill>
  );
};
