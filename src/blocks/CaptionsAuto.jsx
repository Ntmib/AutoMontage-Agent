import { useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme, glowText } from '../theme';
import { springIn, clamp } from '../anim';

// Авто-субтитры: показывает активную фразу по времени,
// текущее слово подсвечивается accent-цветом (караоке).
export const CaptionsAuto = ({ groups = [], offset = 520, tail = 0.15, pos = 'bottom' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = useTheme();
  const time = frame / fps;

  // активная группа
  const gi = groups.findIndex((g) => time >= g.start && time <= g.end + tail);
  if (gi < 0) return null;
  const g = groups[gi];

  // локальный кадр от начала группы — для входной анимации плашки
  const localFrame = frame - Math.round(g.start * fps);
  const s = springIn(localFrame, fps, 0, { damping: 12, mass: 0.5 });
  const scale = clamp(s, 0, 1, 0.85, 1);

  return (
    <div style={{
      position: 'absolute', [pos]: offset, left: '50%', width: 640,
      textAlign: 'center', transform: `translateX(-50%) scale(${scale})`,
      opacity: s,
    }}>
      <div style={{
        display: 'inline-block',
        background: t.motion.glow ? 'rgba(14,14,12,.82)' : 'rgba(61,46,36,.9)',
        border: t.cardBorder, borderRadius: 18, padding: '16px 26px',
        boxShadow: t.cardShadow, maxWidth: 640,
        fontFamily: t.fonts.display, fontWeight: 700, textTransform: 'uppercase',
        fontSize: 46, lineHeight: 1.06, letterSpacing: 0.5,
      }}>
        {g.words.map((w, i) => {
          const active = time >= w.s && time <= w.e + tail;
          return (
            <span key={i} style={{
              color: active ? t.colors.accent : t.colors.milk,
              textShadow: active ? glowText(t, t.colors.accent) : 'none',
              transition: 'none',
              marginRight: 10,
              display: 'inline-block',
              transform: active ? 'translateY(-2px)' : 'none',
            }}>{w.w}</span>
          );
        })}
      </div>
    </div>
  );
};
