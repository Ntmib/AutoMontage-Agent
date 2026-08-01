import { useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme, glowText } from '../theme';
import { springIn, clamp } from '../anim';
import { centerPos, uiScale } from '../layout';

// Плашка-реплика (субтитр). accent=true → акцентная рамка/цвет.
export const SubtitleCard = ({ text = 'РЕПЛИКА', accent = false, sub = null, pos = null }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = useTheme();
  const us = uiScale(width, height);
  const s = springIn(frame, fps, 0, { damping: 10, mass: 0.6 });
  const scale = clamp(s, 0, 1, 0.6, 1) * us;

  return (
    <div style={{
      ...centerPos(pos, { bottomGap: 210 }),
      transform: `scale(${scale})`, opacity: s,
    }}>
      <div style={{
        display: 'inline-block',
        fontFamily: t.fonts.display, fontWeight: 700, textTransform: 'uppercase',
        fontSize: 62, letterSpacing: 1,
        color: accent ? t.colors.milk : t.colors.text,
        background: accent ? t.colors.accent : t.colors.milk,
        border: accent ? 'none' : t.cardBorder,
        padding: '14px 38px', borderRadius: 16,
        boxShadow: t.cardShadow,
        textShadow: glowText(t, accent ? t.colors.accent : t.colors.text),
      }}>
        {text}
      </div>
      {sub && (
        <div style={{
          marginTop: 12, fontFamily: t.fonts.mono, fontWeight: 500, fontSize: 24,
          letterSpacing: 2, color: t.colors.textSoft, textTransform: 'uppercase',
        }}>{sub}</div>
      )}
    </div>
  );
};
