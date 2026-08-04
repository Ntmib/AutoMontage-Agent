import { AbsoluteFill, OffthreadVideo, staticFile } from 'remotion';
import { useTheme } from '../theme';

// ГЕНЕРИК-шаблон слайда-урока (16:9): слева карточка спикера (видео лица),
// справа слайд-панель (номер, двухцветный заголовок, подзаголовок, буллеты, чипы).
// Отличительный ВИД (цвета, грунж-текстура, набор декора) приходит из ТЕМЫ
// (t.colors + t.lesson). Сам компонент нейтральный и может скиниться любой темой.
export const LessonSlide = ({
  num = '01', headCream = 'ЗАГОЛОВОК', headOrange = '',
  sub = '', bullets = [], chipsLabel = '', chips = [],
  name = 'Имя Спикера', role = 'профессия', faceSrc = null,
}) => {
  const t = useTheme();
  const c = t.colors;
  const L = t.lesson || {};
  const D = L.decor || {};
  const orange = c.orange || c.accent;
  const cream = c.cream || c.text;
  const muted = c.textSoft || '#9A8C78';
  const line = c.line || 'rgba(255,255,255,.1)';
  const panel = c.panel || c.cardBg;

  const star = (st) => (
    <div style={{ position: 'absolute', color: orange, fontFamily: t.fonts.mono, ...st }}>✳</div>
  );
  const plus = (st) => (
    <div style={{ position: 'absolute', color: muted, fontFamily: t.fonts.mono, opacity: 0.6, ...st }}>+</div>
  );

  return (
    <AbsoluteFill style={{ background: c.bg, fontFamily: t.fonts.body, color: cream, overflow: 'hidden' }}>
      {/* виньетка/подсветка */}
      <AbsoluteFill style={{
        background: `radial-gradient(120% 90% at 78% 40%, ${orange}18, transparent 55%),
          radial-gradient(80% 70% at 8% 100%, rgba(0,0,0,.6), transparent 60%),
          radial-gradient(80% 70% at 100% 100%, rgba(0,0,0,.55), transparent 60%),
          radial-gradient(140% 120% at 50% 30%, transparent 55%, rgba(0,0,0,.5))`,
      }} />

      {/* грунж-текстура из темы (только если тема её даёт) */}
      {L.grungeTexture && (
        <AbsoluteFill style={{
          backgroundImage: `url(${L.grungeTexture})`, backgroundSize: 'cover',
          opacity: 0.14, mixBlendMode: 'overlay', pointerEvents: 'none',
        }} />
      )}

      {/* декор */}
      {D.orbit && <div style={{
        position: 'absolute', right: -40, top: 130, width: 900, height: 620, borderRadius: '50%',
        border: `2px dotted ${orange}59`, transform: 'rotate(-18deg)',
      }} />}
      {D.stars && <>{star({ right: 150, top: 250, fontSize: 52 })}{star({ right: 640, bottom: 210, fontSize: 34 })}</>}
      {D.plus && <>{plus({ right: 100, top: 640, fontSize: 46 })}{plus({ right: 720, top: 320, fontSize: 32 })}{plus({ left: 880, bottom: 150, fontSize: 34 })}</>}

      {/* верхняя панель */}
      <div style={{ position: 'absolute', top: 78, left: 96, right: 96, display: 'flex', alignItems: 'center', gap: 26 }}>
        <div style={{
          background: orange, color: c.bg, fontFamily: t.fonts.mono, fontWeight: 700, fontSize: 26,
          letterSpacing: 3, padding: '13px 24px', borderRadius: 9,
        }}>{'▸_ ' + (L.badgeTop || 'УРОК ' + num)}</div>
        <div style={{ flex: 1, borderTop: `2px dotted ${line}`, height: 1 }} />
        <div style={{ fontFamily: t.fonts.mono, fontWeight: 700, fontSize: 34, letterSpacing: 2 }}>
          <span style={{ color: orange }}>{num}</span><span style={{ color: muted }}>/08</span>
        </div>
      </div>

      {/* сцена */}
      <div style={{ position: 'absolute', top: 190, left: 96, right: 96, bottom: 84, display: 'flex', gap: 64 }}>
        {/* карточка спикера */}
        <div style={{
          width: 700, flexShrink: 0, position: 'relative', borderRadius: t.radius + 4,
          background: `linear-gradient(160deg, ${panel}, ${c.bg})`,
          border: `1px solid ${orange}70`, boxShadow: t.cardShadow,
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            position: 'absolute', top: 26, left: 26, zIndex: 3, background: orange, color: c.bg,
            fontFamily: t.fonts.mono, fontWeight: 700, fontSize: 22, letterSpacing: 2,
            padding: '10px 18px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: c.bg }} />{L.badge || 'ЭФИР'}
          </div>
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
            background: `radial-gradient(60% 60% at 50% 42%, ${panel}, ${c.bg})`,
          }}>
            {faceSrc ? (
              <OffthreadVideo src={faceSrc.startsWith('http') ? faceSrc : staticFile(faceSrc)}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted />
            ) : (
              <>
                <svg width="220" height="220" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.5 }}>
                  <circle cx="12" cy="8.5" r="4.2" stroke={orange} strokeWidth="1.1" />
                  <path d="M4.5 20c0-4.1 3.4-6.5 7.5-6.5s7.5 2.4 7.5 6.5" stroke={orange} strokeWidth="1.1" strokeLinecap="round" />
                </svg>
                <div style={{
                  position: 'absolute', bottom: 100, left: 0, right: 0, textAlign: 'center',
                  fontFamily: t.fonts.mono, fontSize: 22, color: muted, letterSpacing: 1,
                }}>[ видео спикера из эфира ]</div>
              </>
            )}
          </div>
          <div style={{ padding: '28px 34px', borderTop: `1px solid ${orange}38`, background: 'linear-gradient(180deg, transparent, rgba(0,0,0,.25))' }}>
            <div style={{ fontFamily: t.fonts.display, fontWeight: 700, fontSize: 42, textTransform: 'uppercase' }}>{name}</div>
            <div style={{ color: muted, fontSize: 25 }}>{role}</div>
          </div>
        </div>

        {/* слайд */}
        <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{
            fontFamily: t.fonts.display, fontWeight: 700, fontSize: 150, lineHeight: 0.8,
            color: 'transparent', WebkitTextStroke: `3px ${orange}`, opacity: 0.85, marginBottom: 8,
          }}>{num}</div>
          <div style={{ fontFamily: t.fonts.display, fontWeight: 700, textTransform: 'uppercase', lineHeight: 0.92, fontSize: 118 }}>
            <div style={{ color: cream }}>{headCream}</div>
            {headOrange ? <div style={{ color: orange }}>{headOrange}</div> : null}
          </div>
          {sub ? <div style={{ marginTop: 26, fontSize: 32, color: cream, opacity: 0.9, maxWidth: 1000, lineHeight: 1.35 }}>{sub}</div> : null}
          {bullets.length > 0 && (
            <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 18 }}>
              {bullets.map((b, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 32 }}>
                  <span style={{ width: 16, height: 16, background: orange, flexShrink: 0 }} />{b}
                </div>
              ))}
            </div>
          )}
          {chips.length > 0 && (
            <div style={{ marginTop: 38, display: 'flex', alignItems: 'center', gap: 15, flexWrap: 'wrap' }}>
              {chipsLabel ? <span style={{ fontFamily: t.fonts.mono, fontWeight: 700, fontSize: 22, letterSpacing: 2, color: muted }}>{chipsLabel}</span> : null}
              {chips.map((ch, i) => (
                <span key={i} style={{
                  fontFamily: t.fonts.mono, fontWeight: 600, fontSize: 24, color: cream,
                  border: `1px solid ${orange}80`, borderRadius: 30, padding: '10px 22px', background: `${orange}14`,
                }}>{ch}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* нарисованная стрелка */}
      {D.arrow && (
        <svg style={{ position: 'absolute', right: 70, bottom: 130 }} width="160" height="128" viewBox="0 0 150 120" fill="none">
          <path d="M8 20 C 60 5, 120 30, 120 85" stroke={cream} strokeWidth="4" strokeLinecap="round" fill="none" />
          <path d="M100 78 L122 90 L112 66" stroke={cream} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      )}

      {/* рамка */}
      {D.frame && <div style={{ position: 'absolute', inset: 40, border: `1px dashed ${line}`, borderRadius: 10, opacity: 0.5, pointerEvents: 'none' }} />}
    </AbsoluteFill>
  );
};
