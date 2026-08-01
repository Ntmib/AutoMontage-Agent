import { useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme, glowText } from '../theme';
import { springIn, clamp } from '../anim';

// Верхний лейбл-бренд ">_ АНОНС" — выезд сверху
export const LabelTop = ({ text = '>_ АНОНС' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = useTheme();
  const s = springIn(frame, fps, 2, t.motion.spring);
  const y = clamp(s, 0, 1, -80, 0);

  return (
    <div style={{
      position: 'absolute', top: 70, left: 44,
      transform: `translateY(${y}px)`, opacity: s,
      fontFamily: t.fonts.mono, fontWeight: 700, fontSize: 26, letterSpacing: 2,
      color: t.colors.milk, background: t.colors.accent,
      padding: '12px 22px', borderRadius: 10,
      boxShadow: t.motion.glow ? t.cardShadow : '0 8px 24px rgba(61,46,36,.35)',
    }}>
      {text}
    </div>
  );
};
