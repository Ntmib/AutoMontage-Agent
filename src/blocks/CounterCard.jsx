import { useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme, glowText } from '../theme';
import { springIn, clamp, countUp, fmt } from '../anim';
import { cardPos, uiScale, originFor } from '../layout';

// Крупный счётчик: выезд снизу + накрутка числа 0→value
export const CounterCard = ({ label = 'ВСЕГО ЛИШЬ', value = 5, unit = '', pos = null }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = useTheme();
  const us = uiScale(width, height);

  const s = springIn(frame, fps, 0, t.motion.spring);
  const cardY = clamp(s, 0, 1, 420, 0);
  const n = countUp(frame, 10, 40, value);
  const pop = springIn(frame, fps, 8, { damping: 9, mass: 0.6 });
  const scale = clamp(pop, 0, 1, 0.7, 1);

  return (
    <div style={{
      ...cardPos(pos, { width: 632 }),
      transform: `translateY(${cardY}px) scale(${us})`, transformOrigin: originFor(pos),
      background: t.colors.cardBg, border: t.cardBorder, borderRadius: t.radius,
      padding: '30px 38px', boxShadow: t.cardShadow, overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 10,
        background: t.colors.accent,
        boxShadow: glowText(t, t.colors.accent) !== 'none' ? `0 0 20px ${t.colors.accent}` : 'none',
      }} />
      <div style={{
        fontFamily: t.fonts.mono, fontWeight: 700, fontSize: 22, letterSpacing: 3,
        color: t.colors.accentDark, paddingLeft: 14, textShadow: glowText(t, t.colors.accent),
      }}>{label}</div>
      <div style={{
        fontFamily: t.fonts.display, fontWeight: 700, fontSize: 150, lineHeight: 0.9,
        color: t.colors.text, paddingLeft: 14, display: 'flex', alignItems: 'baseline', gap: 18,
        transform: `scale(${scale})`, transformOrigin: 'left center',
        textShadow: glowText(t, t.colors.text),
      }}>
        {fmt(n)}
        {unit && <small style={{
          fontSize: 52, fontWeight: 600, color: t.colors.textSoft, fontFamily: t.fonts.display,
        }}>{unit}</small>}
      </div>
    </div>
  );
};
