import { useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme, glowText } from '../theme';
import { springIn, clamp, typed, countUp, caret } from '../anim';
import { cardPos, uiScale, originFor } from '../layout';
import { fitText } from '@remotion/layout-utils';

// Инфо-карточка: выезд снизу + typewriter заголовка + пилюли + прогресс-бар
export const InfoCard = ({
  tag = '// МАРАФОН', title = 'ЗАГОЛОВОК',
  pills = [], countPill = null, progress = false, pos = null,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = useTheme();
  const us = uiScale(width, height);

  const s = springIn(frame, fps, 0, t.motion.spring);
  const cardY = clamp(s, 0, 1, 420, 0);

  const tEnd = 18 + title.length * 2.2;
  const shown = typed(frame, 18, tEnd, title);

  // fitText: ужимаем заголовок так, чтобы самое длинное слово влезло по ширине
  // карточки (иначе длинное слово вылезает за плашку). Перенос по словам сохраняем.
  const longest = title.split(/\s+/).sort((a, b) => b.length - a.length)[0] || title;
  const fit = fitText({ text: longest, withinWidth: 556, fontFamily: t.fonts.display, fontWeight: 700 });
  const titleSize = Math.min(76, Math.max(34, fit.fontSize));

  const pill2S = springIn(frame, fps, 70, { damping: 12, mass: 0.7 });
  const barW = clamp(frame, 88, 128, 0, 100);

  // если задан countPill {value, suffix} — первая пилюля с накруткой
  const cnt = countPill ? countUp(frame, 60, 82, countPill.value) : null;

  return (
    <div style={{
      ...cardPos(pos, { width: 632 }),
      transform: `translateY(${cardY}px) scale(${us})`, transformOrigin: originFor(pos),
      background: t.colors.cardBg, border: t.cardBorder, borderRadius: t.radius,
      padding: '32px 38px 36px', boxShadow: t.cardShadow,
    }}>
      <div style={{
        fontFamily: t.fonts.mono, fontWeight: 700, fontSize: 24, letterSpacing: 3,
        color: t.colors.accentDark, textShadow: glowText(t, t.colors.accent),
      }}>{tag}</div>

      <div style={{
        fontFamily: t.fonts.display, fontWeight: 700, fontSize: titleSize, lineHeight: 0.98,
        color: t.colors.text, marginTop: 6, minHeight: 150,
        textShadow: glowText(t, t.colors.text),
      }}>
        {shown}
        <span style={{ opacity: caret(frame, tEnd + 4) ? 1 : 0, color: t.colors.accent }}>|</span>
      </div>

      {(pills.length > 0 || countPill) && (
        <div style={{ marginTop: 18, display: 'flex', gap: 14, alignItems: 'center' }}>
          {countPill && (
            <div style={{
              fontFamily: t.fonts.mono, fontWeight: 700, fontSize: 26, letterSpacing: 1,
              color: t.colors.milk, background: t.colors.accent,
              padding: '8px 20px', borderRadius: 999,
              boxShadow: glowText(t, t.colors.accent) !== 'none' ? t.cardShadow : 'none',
            }}>{cnt} {countPill.suffix}</div>
          )}
          {pills.map((p, i) => (
            <div key={i} style={{
              transform: `scale(${i === 0 && !countPill ? 1 : clamp(pill2S, 0, 1, 0.4, 1)})`,
              transformOrigin: 'left center',
              fontFamily: t.fonts.mono, fontWeight: 700, fontSize: 26, letterSpacing: 1,
              color: t.colors.text, background: t.colors.cardBg2,
              border: t.cardBorder, padding: '8px 20px', borderRadius: 999,
            }}>{p}</div>
          ))}
        </div>
      )}

      {progress && (
        <div style={{
          marginTop: 22, height: 16, borderRadius: 999, background: t.colors.cardBg2,
          border: t.cardBorder, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', width: `${barW}%`, borderRadius: 999,
            background: `linear-gradient(90deg, ${t.colors.accent}, ${t.colors.accentDark})`,
          }} />
        </div>
      )}
    </div>
  );
};
