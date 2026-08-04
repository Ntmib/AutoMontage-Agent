import { AbsoluteFill, useVideoConfig } from 'remotion';
import { useTheme } from '../theme';
import { tk, safeFor, safeWidth } from './safezone';
import { SceneBg, FaceLayer, Chip, FitHeading, useRise } from './parts';

const Bullets = ({ items = [], k, delay = 30, size = 38 }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
    {items.slice(0, 4).map((b, i) => {
      const r = useRise(delay + i * 7, 22);
      return <div key={i} style={{ ...r, display: 'flex', alignItems: 'center', gap: 18, fontSize: size, color: k.cream }}>
        <span style={{ width: 18, height: 18, background: k.orange, flexShrink: 0 }} />{b}</div>;
    })}
  </div>
);

// 1. FULLSCREEN: спикер на весь экран, чип сверху, караоке-строка снизу (в сейф-зоне)
export const SceneFullscreen = (p) => {
  const t = useTheme(); const k = tk(t); const { width, height } = useVideoConfig(); const s = safeFor(width, height);
  const r = useRise(4, 24);
  return (
    <AbsoluteFill style={{ background: k.bg }}>
      <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos} />
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(0,0,0,.35), transparent 26%, transparent 62%, rgba(0,0,0,.78))' }} />
      <Chip text={p.videoTitle || 'ВИДЕО'} />
      {p.caption ? <div style={{ position: 'absolute', left: s.left, right: s.right, bottom: s.bottom, textAlign: 'center', fontFamily: k.fonts.display, fontWeight: 700, textTransform: 'uppercase', fontSize: 72, lineHeight: 0.95, ...r }}>{p.caption}</div> : null}
    </AbsoluteFill>
  );
};

// 2. SPLIT-TOP: спикер в окне сверху, текст снизу в сейф-зоне
export const SceneSplit = (p) => {
  const t = useTheme(); const k = tk(t); const { width, height } = useVideoConfig(); const s = safeFor(width, height);
  const sw = safeWidth(width, height);
  const cardEnter = useRise(0, 30); const numR = useRise(4, 26); const subR = useRise(20, 22);
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      <SceneBg />
      <Chip text={p.videoTitle || 'ВИДЕО'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: s.top + 50, height: 660, borderRadius: 34, overflow: 'hidden', border: `1px solid ${k.orange}70`, boxShadow: k.cardShadow, ...cardEnter }}>
        <div style={{ position: 'absolute', top: 26, left: 26, zIndex: 2, background: k.orange, color: k.bg, fontFamily: k.fonts.mono, fontWeight: 700, fontSize: 22, letterSpacing: 2, padding: '8px 15px', borderRadius: 8 }}>{k.L.badge || 'ЭФИР'}</div>
        <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos} />
      </div>
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: s.top + 760, bottom: s.bottom, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', overflow: 'hidden' }}>
        {p.num ? <div style={{ ...numR, fontFamily: k.fonts.display, fontWeight: 700, fontSize: 84, lineHeight: 0.8, color: 'transparent', WebkitTextStroke: `3px ${k.orange}` }}>{p.num}</div> : null}
        <FitHeading cream={p.headCream} orange={p.headOrange} width={sw} maxSize={82} style={{ marginTop: 20 }} />
        {p.bullets ? <div style={{ marginTop: 22 }}><Bullets items={p.bullets.slice(0, 3)} k={k} delay={30} size={33} /></div> : null}
      </div>
    </AbsoluteFill>
  );
};

// 3. BOTTOM-DIAGRAM: спикер снизу, схема сверху (в сейф-зоне)
export const SceneBottomDiagram = (p) => {
  const t = useTheme(); const k = tk(t); const { width, height } = useVideoConfig(); const s = safeFor(width, height);
  const sw = safeWidth(width, height); const cardEnter = useRise(0, 30);
  const steps = (p.steps || []).slice(0, 4);
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      <SceneBg />
      <Chip text={p.videoTitle || 'ВИДЕО'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: s.top + 60 }}>
        <FitHeading cream={p.headCream} orange={p.headOrange} width={sw} maxSize={92} />
        <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {steps.map((st, i) => {
            const r = useRise(20 + i * 10, 20);
            return <div key={i}>
              <div style={{ ...r, border: `2px solid ${k.orange}88`, borderRadius: 18, padding: '24px 28px', fontSize: 38, background: `${k.orange}12` }}>{st}</div>
              {i < steps.length - 1 ? <div style={{ textAlign: 'center', color: k.orange, fontSize: 40, marginTop: 6 }}>↓</div> : null}
            </div>;
          })}
        </div>
      </div>
      <div style={{ position: 'absolute', left: s.left, right: s.right, bottom: 40, height: 520, borderRadius: 34, overflow: 'hidden', border: `1px solid ${k.orange}70`, boxShadow: k.cardShadow, ...cardEnter }}>
        <div style={{ position: 'absolute', top: 24, left: 24, zIndex: 2, background: k.orange, color: k.bg, fontFamily: k.fonts.mono, fontWeight: 700, fontSize: 22, letterSpacing: 2, padding: '8px 14px', borderRadius: 8 }}>{k.L.badge || 'ЭФИР'}</div>
        <FaceLayer faceSrc={p.faceSrc} facePos={{ x: 0.5, y: 0.32 }} />
      </div>
    </AbsoluteFill>
  );
};

// 4. BLUR-OVERLAY: спикер весь экран блюр+затемн, поверх крупная графика
export const SceneBlurOverlay = (p) => {
  const t = useTheme(); const k = tk(t); const { width, height } = useVideoConfig(); const s = safeFor(width, height);
  const sw = safeWidth(width, height); const bigR = useRise(2, 30);
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos} blur={16} dark={0.34} />
      <SceneBg />
      <Chip text={p.label || 'ФАКТ'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: '50%', transform: 'translateY(-50%)', textAlign: 'center' }}>
        {p.big ? <div style={{ ...bigR, fontFamily: k.fonts.display, fontWeight: 700, fontSize: 360, lineHeight: 0.8, color: k.orange }}>{p.big}</div> : null}
        <FitHeading cream={p.headCream} orange={p.headOrange} width={sw} maxSize={92} style={{ marginTop: 6 }} />
        {p.sub ? <div style={{ marginTop: 22, fontSize: 36, opacity: 0.9 }}>{p.sub}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

// 5. TEXT-ONLY: крупная дословная цитата, без спикера
export const SceneTextOnly = (p) => {
  const t = useTheme(); const k = tk(t); const { width, height } = useVideoConfig(); const s = safeFor(width, height);
  const sw = safeWidth(width, height);
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      <SceneBg />
      <Chip text={p.label || 'ГЛАВНОЕ'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: '50%', transform: 'translateY(-50%)' }}>
        <div style={{ fontFamily: k.fonts.display, fontWeight: 700, fontSize: 120, lineHeight: 0.4, color: k.orange }}>“</div>
        <FitHeading cream={p.quoteCream} orange={p.quoteOrange} width={sw} maxSize={104} style={{ marginTop: 10 }} />
        {p.author ? <div style={{ marginTop: 46, fontFamily: k.fonts.mono, fontWeight: 700, fontSize: 28, letterSpacing: 3, color: k.muted }}>{p.author}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

// 6. STAT: огромная цифра на фоне блюр-спикера
export const SceneStat = (p) => {
  const t = useTheme(); const k = tk(t); const { width, height } = useVideoConfig(); const s = safeFor(width, height);
  const sw = safeWidth(width, height); const bigR = useRise(2, 34);
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos} blur={22} dark={0.22} />
      <SceneBg />
      <Chip text={p.label || 'РЕЗУЛЬТАТ'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: '50%', transform: 'translateY(-50%)', textAlign: 'center' }}>
        <div style={{ ...bigR, fontFamily: k.fonts.display, fontWeight: 700, fontSize: 340, lineHeight: 0.85 }}>
          <span style={{ color: k.cream }}>{p.statCream}</span><span style={{ color: k.orange }}>{p.statOrange}</span>
        </div>
        <FitHeading cream={p.headCream} orange={p.headOrange} width={sw} maxSize={84} style={{ marginTop: 12 }} />
        {p.sub ? <div style={{ marginTop: 20, fontSize: 34, opacity: 0.9 }}>{p.sub}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

// 7. BROLL: картинка на весь экран, спикер кружком в углу, текст снизу
export const SceneBroll = (p) => {
  const t = useTheme(); const k = tk(t); const { width, height } = useVideoConfig(); const s = safeFor(width, height);
  const sw = safeWidth(width, height); const cardEnter = useRise(0, 20);
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      {p.brollSrc ? <FaceLayer faceSrc={p.brollSrc} image facePos={{ x: 0.5, y: 0.4 }} dark={0.85} />
        : <AbsoluteFill style={{ background: 'repeating-linear-gradient(135deg,#241a12,#241a12 40px,#1d1610 40px,#1d1610 80px)' }}><AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6f5e49', fontFamily: k.fonts.mono, fontSize: 38 }}>[ B-ROLL ]</AbsoluteFill></AbsoluteFill>}
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, transparent 45%, rgba(0,0,0,.8))' }} />
      <Chip text={p.videoTitle || 'ВИДЕО'} />
      {p.faceSrc ? <div style={{ position: 'absolute', right: s.right, top: 940, width: 220, height: 220, borderRadius: 26, overflow: 'hidden', border: `1px solid ${k.orange}70`, ...cardEnter }}><FaceLayer faceSrc={p.faceSrc} facePos={{ x: 0.5, y: 0.32 }} /></div> : null}
      <div style={{ position: 'absolute', left: s.left, right: s.right, bottom: s.bottom }}>
        <FitHeading cream={p.headCream} orange={p.headOrange} width={sw} maxSize={92} />
        {p.sub ? <div style={{ marginTop: 20, fontSize: 34, opacity: 0.92 }}>{p.sub}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

export const SCENES = {
  fullscreen: SceneFullscreen,
  split: SceneSplit,
  'bottom-diagram': SceneBottomDiagram,
  'blur-overlay': SceneBlurOverlay,
  'text-only': SceneTextOnly,
  stat: SceneStat,
  broll: SceneBroll,
};
