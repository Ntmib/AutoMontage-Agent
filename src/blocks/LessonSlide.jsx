import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme } from '../theme';
import { springIn, clamp } from '../anim';

// Токены темы с fallback'ами (тема может быть нейтральной или брендовой).
const tokens = (t) => {
  const c = t.colors;
  return {
    bg: c.bg, orange: c.orange || c.accent, cream: c.cream || c.text,
    muted: c.textSoft || '#9A8C78', line: c.line || 'rgba(255,255,255,.1)',
    panel: c.panel || c.cardBg, fonts: t.fonts, radius: t.radius,
    cardShadow: t.cardShadow, L: t.lesson || {}, D: (t.lesson || {}).decor || {},
  };
};

// ── Фон: виньетка, грунж-текстура, декор (орбита/звёзды/плюсы/рамка) ──
export const LessonBackground = () => {
  const t = useTheme(); const k = tokens(t);
  const star = (st) => <div style={{ position: 'absolute', color: k.orange, fontFamily: k.fonts.mono, ...st }}>✳</div>;
  const plus = (st) => <div style={{ position: 'absolute', color: k.muted, fontFamily: k.fonts.mono, opacity: 0.6, ...st }}>+</div>;
  return (
    <>
      <AbsoluteFill style={{
        background: `radial-gradient(120% 90% at 78% 40%, ${k.orange}18, transparent 55%),
          radial-gradient(80% 70% at 8% 100%, rgba(0,0,0,.6), transparent 60%),
          radial-gradient(80% 70% at 100% 100%, rgba(0,0,0,.55), transparent 60%),
          radial-gradient(140% 120% at 50% 30%, transparent 55%, rgba(0,0,0,.5))`,
      }} />
      {k.L.grungeTexture && <AbsoluteFill style={{
        backgroundImage: `url(${k.L.grungeTexture})`, backgroundSize: 'cover',
        opacity: 0.14, mixBlendMode: 'overlay', pointerEvents: 'none',
      }} />}
      {k.D.orbit && <div style={{
        position: 'absolute', right: -40, top: 130, width: 900, height: 620, borderRadius: '50%',
        border: `2px dotted ${k.orange}59`, transform: 'rotate(-18deg)',
      }} />}
      {k.D.stars && <>{star({ right: 150, top: 250, fontSize: 52 })}{star({ right: 640, bottom: 210, fontSize: 34 })}</>}
      {k.D.plus && <>{plus({ right: 100, top: 640, fontSize: 46 })}{plus({ right: 720, top: 320, fontSize: 32 })}{plus({ left: 880, bottom: 150, fontSize: 34 })}</>}
      {k.D.frame && <div style={{ position: 'absolute', inset: 40, border: `1px dashed ${k.line}`, borderRadius: 10, opacity: 0.5, pointerEvents: 'none' }} />}
    </>
  );
};

// ── Верхняя панель: чип-лейбл + пунктир + счётчик ──
export const LessonTopBar = ({ num = '01', total = '08', badgeTop }) => {
  const t = useTheme(); const k = tokens(t);
  const frame = useCurrentFrame();
  const s = springIn(frame, 30, 0, { damping: 16, mass: 0.8 });
  return (
    <div style={{ position: 'absolute', top: 78, left: 96, right: 96, display: 'flex', alignItems: 'center', gap: 26, opacity: clamp(s, 0, 1, 0, 1), transform: `translateY(${clamp(s, 0, 1, -20, 0)}px)` }}>
      <div style={{ background: k.orange, color: k.bg, fontFamily: k.fonts.mono, fontWeight: 700, fontSize: 26, letterSpacing: 3, padding: '13px 24px', borderRadius: 9 }}>
        {'▸_ ' + (badgeTop || k.L.badgeTop || 'УРОК ' + num)}
      </div>
      <div style={{ flex: 1, borderTop: `2px dotted ${k.line}`, height: 1 }} />
      <div style={{ fontFamily: k.fonts.mono, fontWeight: 700, fontSize: 34, letterSpacing: 2 }}>
        <span style={{ color: k.orange }}>{num}</span><span style={{ color: k.muted }}>/{total}</span>
      </div>
    </div>
  );
};

// ── Карточка спикера (персистентная, с «дыханием») ──
export const SpeakerCard = ({ name = 'Имя Спикера', role = 'профессия', faceSrc = null }) => {
  const t = useTheme(); const k = tokens(t);
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const enter = springIn(frame, fps, 0, { damping: 18, mass: 1 });
  const breathe = 1 + 0.006 * Math.sin((2 * Math.PI * frame) / (fps * 7));
  return (
    <div style={{
      width: 700, flexShrink: 0, position: 'relative', borderRadius: k.radius + 4,
      background: `linear-gradient(160deg, ${k.panel}, ${k.bg})`,
      border: `1px solid ${k.orange}70`, boxShadow: k.cardShadow, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      opacity: clamp(enter, 0, 1, 0, 1), transform: `translateX(${clamp(enter, 0, 1, -40, 0)}px) scale(${breathe})`,
    }}>
      <div style={{ position: 'absolute', top: 26, left: 26, zIndex: 3, background: k.orange, color: k.bg, fontFamily: k.fonts.mono, fontWeight: 700, fontSize: 22, letterSpacing: 2, padding: '10px 18px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: k.bg }} />{k.L.badge || 'ЭФИР'}
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', background: `radial-gradient(60% 60% at 50% 42%, ${k.panel}, ${k.bg})` }}>
        {faceSrc ? (
          <OffthreadVideo src={faceSrc.startsWith('http') ? faceSrc : staticFile(faceSrc)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted />
        ) : (
          <>
            <svg width="220" height="220" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.5 }}>
              <circle cx="12" cy="8.5" r="4.2" stroke={k.orange} strokeWidth="1.1" />
              <path d="M4.5 20c0-4.1 3.4-6.5 7.5-6.5s7.5 2.4 7.5 6.5" stroke={k.orange} strokeWidth="1.1" strokeLinecap="round" />
            </svg>
            <div style={{ position: 'absolute', bottom: 100, left: 0, right: 0, textAlign: 'center', fontFamily: k.fonts.mono, fontSize: 22, color: k.muted, letterSpacing: 1 }}>[ видео спикера из эфира ]</div>
          </>
        )}
      </div>
      <div style={{ padding: '28px 34px', borderTop: `1px solid ${k.orange}38`, background: 'linear-gradient(180deg, transparent, rgba(0,0,0,.25))' }}>
        <div style={{ fontFamily: k.fonts.display, fontWeight: 700, fontSize: 42, textTransform: 'uppercase' }}>{name}</div>
        <div style={{ color: k.muted, fontSize: 25 }}>{role}</div>
      </div>
    </div>
  );
};

// ── Слайд-панель (АНИМИРОВАННАЯ): номер, двухцветный заголовок, sub, буллеты, чипы ──
// Анимация по локальному кадру (внутри Sequence кадр локальный → каждый слайд играет свой вход).
export const SlidePanel = ({ num = '01', headCream = '', headOrange = '', sub = '', bullets = [], chipsLabel = '', chips = [], dur = 0 }) => {
  const t = useTheme(); const k = tokens(t);
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const rise = (delay, px = 46) => {
    const s = springIn(frame, fps, delay, { damping: 15, mass: 0.9 });
    return { opacity: clamp(s, 0, 1, 0, 1), transform: `translateY(${clamp(s, 0, 1, px, 0)}px)` };
  };
  const pop = (delay) => {
    const s = springIn(frame, fps, delay, { damping: 11, mass: 0.6 });
    return { opacity: clamp(s, 0, 1, 0, 1), transform: `scale(${clamp(s, 0, 1, 0.6, 1)})` };
  };
  // общий фейд-аут в конце (если известна длительность)
  const out = dur ? clamp(frame, dur - 12, dur - 2, 1, 0) : 1;
  const bulletsStart = 30, chipsStart = bulletsStart + bullets.length * 7 + 6;

  return (
    <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'center', opacity: out }}>
      <div style={{ ...rise(2, 30), fontFamily: k.fonts.display, fontWeight: 700, fontSize: 150, lineHeight: 0.8, color: 'transparent', WebkitTextStroke: `3px ${k.orange}`, marginBottom: 8 }}>{num}</div>
      <div style={{ fontFamily: k.fonts.display, fontWeight: 700, textTransform: 'uppercase', lineHeight: 0.92, fontSize: 118 }}>
        <div style={{ ...rise(6), color: k.cream }}>{headCream}</div>
        {headOrange ? <div style={{ ...rise(12), color: k.orange }}>{headOrange}</div> : null}
      </div>
      {sub ? <div style={{ ...rise(22, 26), marginTop: 26, fontSize: 32, color: k.cream, opacity: 0.9, maxWidth: 1000, lineHeight: 1.35 }}>{sub}</div> : null}
      {bullets.length > 0 && (
        <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {bullets.map((b, i) => (
            <div key={i} style={{ ...rise(bulletsStart + i * 7, 24), display: 'flex', alignItems: 'center', gap: 20, fontSize: 32 }}>
              <span style={{ width: 16, height: 16, background: k.orange, flexShrink: 0 }} />{b}
            </div>
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <div style={{ marginTop: 38, display: 'flex', alignItems: 'center', gap: 15, flexWrap: 'wrap' }}>
          {chipsLabel ? <span style={{ ...rise(chipsStart, 16), fontFamily: k.fonts.mono, fontWeight: 700, fontSize: 22, letterSpacing: 2, color: k.muted }}>{chipsLabel}</span> : null}
          {chips.map((ch, i) => (
            <span key={i} style={{ ...pop(chipsStart + 6 + i * 5), fontFamily: k.fonts.mono, fontWeight: 600, fontSize: 24, color: k.cream, border: `1px solid ${k.orange}80`, borderRadius: 30, padding: '10px 22px', background: `${k.orange}14` }}>{ch}</span>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Полный слайд (карточка + панель), для still/превью одного слайда ──
export const LessonSlide = (props) => {
  const t = useTheme(); const k = tokens(t);
  return (
    <AbsoluteFill style={{ background: k.bg, fontFamily: k.fonts.body, color: k.cream, overflow: 'hidden' }}>
      <LessonBackground />
      <LessonTopBar num={props.num} total={props.total} />
      <div style={{ position: 'absolute', top: 190, left: 96, right: 96, bottom: 84, display: 'flex', gap: 64 }}>
        <SpeakerCard name={props.name} role={props.role} faceSrc={props.faceSrc} />
        <SlidePanel {...props} />
      </div>
    </AbsoluteFill>
  );
};
