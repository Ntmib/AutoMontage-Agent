import { useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme, glowText } from '../theme';
import { springIn, clamp } from '../anim';
import { centerPos, uiScale } from '../layout';
import { fitText } from '@remotion/layout-utils';

// Финальный призыв: заголовок + пульсирующая кнопка
export const CTACard = ({ head = 'ЖМИ НА КНОПКУ', btn = 'ССЫЛКА НИЖЕ ↓', pos = null }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = useTheme();
  const us = uiScale(width, height);
  const s = springIn(frame, fps, 0, t.motion.spring);
  const y = clamp(s, 0, 1, 60, 0);
  const pulse = 1 + Math.sin(frame / 7) * 0.03;
  // заголовок CTA ужимаем под ширину (uppercase — учитываем в измерении)
  const headFit = fitText({ text: head.toUpperCase(), withinWidth: 680, fontFamily: t.fonts.display, fontWeight: 700 });
  const headSize = Math.min(t.ctaHeadSize || 64, Math.max(30, headFit.fontSize));
  const plain = !!t.plain;
  const flatShadow = t.textShadow || '0 3px 16px rgba(0,0,0,.8)';

  return (
    <div style={{
      ...centerPos(pos, { bottomGap: 150 }),
      transform: `translateY(${y}px) scale(${us})`, opacity: s,
    }}>
      <div style={{
        fontFamily: t.fonts.display, fontWeight: 700, textTransform: 'uppercase',
        fontSize: headSize, color: t.colors.milk,
        textShadow: plain ? flatShadow : (t.motion.glow ? glowText(t, t.colors.accent) : '0 4px 18px rgba(61,46,36,.5)'),
      }}>{head}</div>
      <div style={{
        marginTop: 22, display: 'inline-block', transform: `scale(${pulse})`,
        fontFamily: t.fonts.mono, fontWeight: 700,
        fontSize: t.ctaBtnSize || 34, letterSpacing: 2,
        color: t.colors.milk, background: plain ? 'transparent' : t.colors.accent,
        padding: plain ? 0 : '22px 54px',
        borderRadius: plain ? 0 : 18, textTransform: 'uppercase',
        boxShadow: plain ? 'none' : (t.motion.glow ? t.cardShadow : '0 16px 40px rgba(184,92,62,.5)'),
        textShadow: plain ? flatShadow : undefined,
      }}>{btn}</div>
    </div>
  );
};
