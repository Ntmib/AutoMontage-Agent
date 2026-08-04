import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme } from '../theme';
import { tk, safeFor, safeWidth } from './safezone';
import { SceneBg, FaceLayer, Chip, FitHeading, useRise } from './parts';
import { clamp, countUp, fmt } from '../anim';

const Bullets = ({ items = [], k, delay = 30, stagger = 7, delayForIndex = null, size = 38 }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
    {items.slice(0, 4).map((b, i) => {
      const r = useRise(delayForIndex ? delayForIndex(i) : delay + i * stagger, 22);
      return <div key={i} style={{ ...r, display: 'flex', alignItems: 'center', gap: 18, fontSize: size, color: k.cream }}>
        <span style={{ width: 18, height: 18, background: k.orange, flexShrink: 0 }} />{b}</div>;
    })}
  </div>
);

const clip01 = (value) => Math.min(1, Math.max(0, value));

export const getFunnelPeople = (frame, fps) => Array.from({ length: 12 }, (_, index) => {
  const delay = index * fps * 0.06;
  const progress = clip01((frame - delay) / (fps * 2.45));
  const survives = index === 1 || index === 5 || index === 9;
  const startX = -310 + index * (620 / 11);
  const targetX = (index - 5) * 12;
  const opacity = survives ? 1 : 1 - clip01((progress - 0.54) / 0.22);
  return {
    index,
    survives,
    progress,
    opacity,
    x: startX + (targetX - startX) * progress,
    y: -20 + progress * 700,
  };
});

export const getLogoEntrance = (frame, index, fps) => {
  const delays = [0.12, 0.38, 1.28, 1.55];
  const progress = clip01((frame - (delays[index] || 0) * fps) / (fps * 0.42));
  const eased = 1 - ((1 - progress) ** 3);
  return {
    opacity: eased,
    scale: 0.78 + eased * 0.22,
    y: (1 - eased) * 42,
  };
};

export const getSplitGradient = (frame, fps) => {
  const progress = (frame % (fps * 8)) / (fps * 8);
  return {
    x: 20 + progress * 60,
    y: 72 - progress * 44,
    angle: 115 - progress * 30,
  };
};

export const getSplitBulletDelay = (index, fps, variant) => (
  variant === 'animated-gradient'
    ? Math.round((0.45 + index * 1.45) * fps)
    : 30 + index * 7
);

export const getStatFontSize = (text, width, land) => {
  const base = land ? 240 : 340;
  const fitted = Math.floor(width / (Math.max(1, text.length) * 0.48));
  return Math.max(96, Math.min(base, fitted));
};

export const getKeywordMotion = (frame, fps) => {
  const period = fps * 1.2;
  const cycle = (frame % period) / period;
  const wave = cycle <= 0.5 ? cycle * 2 : (1 - cycle) * 2;
  return {
    y: wave === 0 ? 0 : -10 * wave,
    scale: 1 + wave * 0.05,
    rotate: -1 + wave * 2,
  };
};

const AnimatedSplitGradient = ({ k, frame, fps }) => {
  const motion = getSplitGradient(frame, fps);
  return (
    <>
      <AbsoluteFill style={{ background: `linear-gradient(${motion.angle}deg, ${k.bg} 4%, #24140B 48%, #100C09 96%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(65% 50% at ${motion.x}% ${motion.y}%, ${k.orange}66, transparent 68%), radial-gradient(55% 45% at ${100 - motion.x}% ${100 - motion.y}%, ${k.orange}30, transparent 72%)`, opacity: 0.86 }} />
      <div style={{ position: 'absolute', left: `${motion.x}%`, top: `${motion.y}%`, width: 360, height: 360, borderRadius: '50%', border: `2px solid ${k.orange}45`, boxShadow: `0 0 100px ${k.orange}35`, transform: `translate(-50%, -50%) rotate(${frame * 0.45}deg)` }} />
    </>
  );
};

const SOCIAL_LOGOS = {
  telegram: { label: 'TELEGRAM', file: 'brand-logos/telegram.svg', width: 128, height: 128 },
  instagram: { label: 'INSTAGRAM', file: 'brand-logos/instagram.png', width: 128, height: 128 },
  youtube: { label: 'YOUTUBE', file: 'brand-logos/youtube.png', width: 150, height: 106 },
  zoom: { label: 'ZOOM', file: 'brand-logos/zoom.png', width: 220, height: 72 },
};

const PersonGlyph = ({ color, size = 34 }) => (
  <div style={{ position: 'relative', width: size, height: size * 1.55 }}>
    <div style={{ position: 'absolute', left: size * 0.25, top: 0, width: size * 0.5, height: size * 0.5, borderRadius: '50%', background: color }} />
    <div style={{ position: 'absolute', left: size * 0.13, top: size * 0.52, width: size * 0.74, height: size * 0.86, borderRadius: `${size * 0.36}px ${size * 0.36}px ${size * 0.12}px ${size * 0.12}px`, background: color }} />
  </div>
);

const SpeakerCircleDiagram = ({ p, k, s, width, height, frame, fps }) => {
  const land = width > height;
  const size = land ? 360 : 520;
  const top = land ? s.top + 150 : s.top + 370;
  const enter = clip01(frame / (fps * 0.55));
  const ring = clip01((frame - fps * 0.45) / (fps * 0.65));
  const handle = p.handle || '@MCDENIL';
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      <SceneBg />
      <Chip text={p.videoTitle || 'ВИДЕО'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: s.top + 70, textAlign: 'center' }}>
        <FitHeading cream={p.headCream} orange={p.headOrange} width={width - s.left - s.right} maxSize={land ? 86 : 94} />
      </div>
      <div style={{ position: 'absolute', left: '50%', top, width: size, height: size, transform: `translateX(-50%) scale(${0.82 + enter * 0.18})`, opacity: enter }}>
        <div style={{ position: 'absolute', inset: -24, borderRadius: '50%', border: `3px dashed ${k.orange}`, opacity: ring, transform: `rotate(${frame * 1.6}deg)` }} />
        <div style={{ position: 'absolute', inset: -9, borderRadius: '50%', border: `5px solid ${k.orange}`, boxShadow: `0 0 60px ${k.orange}55` }} />
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', overflow: 'hidden', background: k.panel }}>
          <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos} faceZoom={p.faceZoom} sourceStartFrame={p.sourceStartFrame} />
        </div>
        <div style={{ position: 'absolute', left: '50%', bottom: -78, transform: `translateX(-50%) translateY(${(1 - ring) * 30}px)`, opacity: ring, background: k.orange, color: k.bg, borderRadius: 12, padding: '14px 30px', fontFamily: k.fonts.mono, fontSize: land ? 26 : 32, fontWeight: 700, letterSpacing: 3, whiteSpace: 'nowrap' }}>{handle}</div>
      </div>
    </AbsoluteFill>
  );
};

const SalesFunnelDiagram = ({ p, k, s, width, height, frame, fps }) => {
  const land = width > height;
  const funnelWidth = land ? 800 : 760;
  const funnelHeight = land ? 620 : 780;
  const top = land ? s.top + 170 : s.top + 300;
  const people = getFunnelPeople(frame, fps);
  const tiers = [
    { top: 120, width: funnelWidth, height: 190, color: `${k.orange}DD` },
    { top: 300, width: funnelWidth * 0.72, height: 180, color: `${k.orange}A8` },
    { top: 470, width: funnelWidth * 0.44, height: 165, color: `${k.orange}72` },
  ];
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      <SceneBg />
      <Chip text={p.videoTitle || 'ВИДЕО'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: s.top + 60, textAlign: 'center' }}>
        <FitHeading cream={p.headCream} orange={p.headOrange} width={width - s.left - s.right} maxSize={land ? 86 : 94} />
      </div>
      <div style={{ position: 'absolute', left: '50%', top, width: funnelWidth, height: funnelHeight, transform: 'translateX(-50%)' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 72, height: 2, background: k.line }} />
        <div style={{ position: 'absolute', top: 12, left: 0, color: k.muted, fontFamily: k.fonts.mono, fontSize: 24, fontWeight: 700, letterSpacing: 2 }}>МНОГО ЛЮДЕЙ</div>
        {tiers.map((tier, index) => {
          const reveal = clip01((frame - index * fps * 0.16) / (fps * 0.55));
          return <div key={index} style={{ position: 'absolute', left: '50%', top: tier.top, width: tier.width, height: tier.height, transform: `translateX(-50%) scaleY(${reveal})`, transformOrigin: 'top center', opacity: reveal, background: tier.color, clipPath: 'polygon(0 0, 100% 0, 76% 100%, 24% 100%)', borderTop: `2px solid ${k.cream}70`, boxShadow: `0 18px 50px ${k.orange}1F` }} />;
        })}
        {people.map((person) => (
          <div key={person.index} style={{ position: 'absolute', zIndex: 3, left: '50%', top: 82, opacity: person.opacity, transform: `translate(${person.x - 17}px, ${person.y}px) scale(${0.82 + person.progress * 0.18})` }}>
            <PersonGlyph color={person.survives ? k.cream : k.bg} />
          </div>
        ))}
        <div style={{ position: 'absolute', left: '50%', bottom: 0, transform: 'translateX(-50%)', color: k.cream, fontFamily: k.fonts.mono, fontSize: land ? 24 : 28, fontWeight: 700, letterSpacing: 3, whiteSpace: 'nowrap' }}>НЕСКОЛЬКО ЛИДОВ</div>
      </div>
    </AbsoluteFill>
  );
};

// 1. FULLSCREEN: спикер на весь экран, чип сверху, караоке-строка снизу (в сейф-зоне)
export const SceneFullscreen = (p) => {
  const t = useTheme(); const k = tk(t); const { width, height } = useVideoConfig(); const s = safeFor(width, height);
  const land = width > height;
  const r = useRise(4, 24);
  return (
    <AbsoluteFill style={{ background: k.bg }}>
      <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos} faceZoom={p.faceZoom} sourceStartFrame={p.sourceStartFrame} />
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(0,0,0,.35), transparent 26%, transparent 62%, rgba(0,0,0,.78))' }} />
      <Chip text={p.videoTitle || 'ВИДЕО'} />
      {p.caption ? <div style={{ position: 'absolute', left: s.left, right: s.right, bottom: s.bottom, textAlign: 'center', color: k.cream, fontFamily: k.fonts.display, fontWeight: 700, textTransform: 'uppercase', fontSize: land ? 60 : 72, lineHeight: 0.95, ...r }}>{p.caption}</div> : null}
    </AbsoluteFill>
  );
};

// 2. SPLIT-TOP: спикер в окне сверху, текст снизу в сейф-зоне
export const SceneSplit = (p) => {
  const t = useTheme(); const k = tk(t); const frame = useCurrentFrame(); const { width, height, fps } = useVideoConfig(); const s = safeFor(width, height);
  const land = width > height;
  const cardEnter = useRise(0, 30); const numR = useRise(4, 26);
  const badge = <div style={{ position: 'absolute', top: 26, left: 26, zIndex: 2, background: k.orange, color: k.bg, fontFamily: k.fonts.mono, fontWeight: 700, fontSize: 22, letterSpacing: 2, padding: '8px 15px', borderRadius: 8 }}>{k.L.badge || 'ЭФИР'}</div>;

  if (land) {
    // ГОРИЗОНТ: спикер-карточка слева, номер+заголовок+буллеты справа
    const gap = 70;
    const cardW = Math.round((width - s.left - s.right - gap) * 0.44);
    const textLeft = s.left + cardW + gap;
    const textW = width - textLeft - s.right;
    const facePos = { x: p.facePos?.x ?? 0.34, y: p.facePos?.y ?? 0.5 };
    return (
      <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
        {p.variant === 'animated-gradient' ? <AnimatedSplitGradient k={k} frame={frame} fps={fps} /> : null}
        <SceneBg />
        <Chip text={p.videoTitle || 'ВИДЕО'} />
        <div style={{ position: 'absolute', left: s.left, top: s.top + 40, bottom: s.bottom + 40, width: cardW, borderRadius: 30, overflow: 'hidden', border: `1px solid ${k.orange}70`, boxShadow: k.cardShadow, ...cardEnter }}>
          {badge}
          <FaceLayer faceSrc={p.faceSrc} facePos={facePos} faceZoom={p.faceZoom} sourceStartFrame={p.sourceStartFrame} />
        </div>
        <div style={{ position: 'absolute', left: textLeft, width: textW, top: s.top, bottom: s.bottom, display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden' }}>
          {p.num ? <div style={{ ...numR, fontFamily: k.fonts.display, fontWeight: 700, fontSize: 96, lineHeight: 0.8, color: 'transparent', WebkitTextStroke: `3px ${k.orange}` }}>{p.num}</div> : null}
          <FitHeading cream={p.headCream} orange={p.headOrange} width={textW} maxSize={96} style={{ marginTop: 18 }} />
          {p.bullets ? <div style={{ marginTop: 26 }}><Bullets items={p.bullets.slice(0, 4)} k={k} delayForIndex={(index) => getSplitBulletDelay(index, fps, p.variant)} size={p.variant === 'animated-gradient' ? 32 : 36} /></div> : null}
        </div>
      </AbsoluteFill>
    );
  }

  const sw = safeWidth(width, height);
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      {p.variant === 'animated-gradient' ? <AnimatedSplitGradient k={k} frame={frame} fps={fps} /> : null}
      <SceneBg />
      <Chip text={p.videoTitle || 'ВИДЕО'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: s.top + 50, height: 660, borderRadius: 34, overflow: 'hidden', border: `1px solid ${k.orange}70`, boxShadow: k.cardShadow, ...cardEnter }}>
        {badge}
        <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos} faceZoom={p.faceZoom} sourceStartFrame={p.sourceStartFrame} />
      </div>
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: s.top + 760, bottom: s.bottom, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', overflow: 'hidden' }}>
        {p.num ? <div style={{ ...numR, fontFamily: k.fonts.display, fontWeight: 700, fontSize: 84, lineHeight: 0.8, color: 'transparent', WebkitTextStroke: `3px ${k.orange}` }}>{p.num}</div> : null}
        <FitHeading cream={p.headCream} orange={p.headOrange} width={sw} maxSize={82} style={{ marginTop: 20 }} />
        {p.bullets ? <div style={{ marginTop: 22 }}><Bullets items={p.bullets.slice(0, p.variant === 'animated-gradient' ? 4 : 3)} k={k} delayForIndex={(index) => getSplitBulletDelay(index, fps, p.variant)} size={p.variant === 'animated-gradient' ? 27 : 33} /></div> : null}
      </div>
    </AbsoluteFill>
  );
};

// 3. BOTTOM-DIAGRAM: спикер снизу, схема сверху (в сейф-зоне)
export const SceneBottomDiagram = (p) => {
  const t = useTheme(); const k = tk(t); const frame = useCurrentFrame(); const { width, height, fps } = useVideoConfig(); const s = safeFor(width, height);
  const land = width > height; const cardEnter = useRise(0, 30);
  const steps = (p.steps || []).slice(0, 4);
  const badge = <div style={{ position: 'absolute', top: 24, left: 24, zIndex: 2, background: k.orange, color: k.bg, fontFamily: k.fonts.mono, fontWeight: 700, fontSize: 22, letterSpacing: 2, padding: '8px 14px', borderRadius: 8 }}>{k.L.badge || 'ЭФИР'}</div>;
  const stepBox = (st, i, boxSize) => {
    const r = useRise(20 + i * 10, 20);
    return <div key={i}>
      <div style={{ ...r, border: `2px solid ${k.orange}88`, borderRadius: 18, padding: '20px 26px', fontSize: boxSize, background: `${k.orange}12`, overflowWrap: 'anywhere' }}>{st}</div>
      {i < steps.length - 1 ? <div style={{ textAlign: 'center', color: k.orange, fontSize: 36, marginTop: 4, lineHeight: 1 }}>↓</div> : null}
    </div>;
  };

  if (p.variant === 'speaker-circle') {
    return <SpeakerCircleDiagram p={p} k={k} s={s} width={width} height={height} frame={frame} fps={fps} />;
  }
  if (p.variant === 'funnel') {
    return <SalesFunnelDiagram p={p} k={k} s={s} width={width} height={height} frame={frame} fps={fps} />;
  }

  if (land) {
    // ГОРИЗОНТ: спикер-карточка слева, заголовок + схема справа
    const gap = 70;
    const cardW = Math.round((width - s.left - s.right - gap) * 0.42);
    const textLeft = s.left + cardW + gap;
    const textW = width - textLeft - s.right;
    const facePos = { x: p.facePos?.x ?? 0.34, y: p.facePos?.y ?? 0.32 };
    return (
      <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
        <SceneBg />
        <Chip text={p.videoTitle || 'ВИДЕО'} />
        <div style={{ position: 'absolute', left: s.left, top: s.top + 40, bottom: s.bottom + 40, width: cardW, borderRadius: 30, overflow: 'hidden', border: `1px solid ${k.orange}70`, boxShadow: k.cardShadow, ...cardEnter }}>
          {badge}
          <FaceLayer faceSrc={p.faceSrc} facePos={facePos} faceZoom={p.faceZoom} sourceStartFrame={p.sourceStartFrame} />
        </div>
        <div style={{ position: 'absolute', left: textLeft, width: textW, top: s.top, bottom: s.bottom, display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden' }}>
          <FitHeading cream={p.headCream} orange={p.headOrange} width={textW} maxSize={80} />
          <div style={{ marginTop: 30, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {steps.map((st, i) => stepBox(st, i, 32))}
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  const sw = safeWidth(width, height);
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      <SceneBg />
      <Chip text={p.videoTitle || 'ВИДЕО'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: s.top + 60 }}>
        <FitHeading cream={p.headCream} orange={p.headOrange} width={sw} maxSize={92} />
        <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {steps.map((st, i) => stepBox(st, i, 38))}
        </div>
      </div>
      <div style={{ position: 'absolute', left: s.left, right: s.right, bottom: 40, height: 520, borderRadius: 34, overflow: 'hidden', border: `1px solid ${k.orange}70`, boxShadow: k.cardShadow, ...cardEnter }}>
        {badge}
        <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos || { x: 0.5, y: 0.32 }} faceZoom={p.faceZoom} sourceStartFrame={p.sourceStartFrame} />
      </div>
    </AbsoluteFill>
  );
};

// 4. BLUR-OVERLAY: спикер весь экран блюр+затемн, поверх крупная графика
export const SceneBlurOverlay = (p) => {
  const t = useTheme(); const k = tk(t); const frame = useCurrentFrame(); const { width, height, fps } = useVideoConfig(); const s = safeFor(width, height);
  const land = width > height; const sw = safeWidth(width, height); const bigR = useRise(2, 30);

  if (p.variant === 'blur-only') {
    const blurProgress = clip01(frame / (fps * 1.35));
    return (
      <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
        <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos} faceZoom={p.faceZoom} sourceStartFrame={p.sourceStartFrame} blur={16 * blurProgress} dark={1 - blurProgress * 0.66} />
        <SceneBg chrome={false} />
        <Chip text={p.label || 'ВИЗУАЛ'} />
      </AbsoluteFill>
    );
  }

  if (p.variant === 'social-logos') {
    const logos = (p.logos || ['telegram', 'instagram', 'youtube', 'zoom'])
      .map((id) => ({ id, ...SOCIAL_LOGOS[id] }))
      .filter((logo) => logo.file);
    const cardWidth = land ? 320 : 390;
    const cardHeight = land ? 210 : 280;
    const gap = land ? 28 : 30;
    return (
      <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
        <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos} faceZoom={p.faceZoom} sourceStartFrame={p.sourceStartFrame} blur={16} dark={0.3} />
        <SceneBg />
        <Chip text={p.label || 'ВИЗУАЛ'} />
        <div style={{ position: 'absolute', left: s.left, right: s.right, top: s.top + 70, textAlign: 'center' }}>
          <FitHeading cream={p.headCream} orange={p.headOrange} width={sw} maxSize={land ? 76 : 88} />
        </div>
        <div style={{ position: 'absolute', left: '50%', top: land ? s.top + 190 : s.top + 300, width: cardWidth * 2 + gap, display: 'grid', gridTemplateColumns: `repeat(2, ${cardWidth}px)`, gap, transform: 'translateX(-50%)' }}>
          {logos.map((logo, index) => {
            const enter = getLogoEntrance(frame, index, fps);
            return <div key={logo.id} style={{ height: cardHeight, borderRadius: 28, border: `1px solid ${k.cream}30`, background: 'rgba(18,14,11,.78)', boxShadow: k.cardShadow, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, opacity: enter.opacity, transform: `translateY(${enter.y}px) scale(${enter.scale})` }}>
              <Img src={staticFile(logo.file)} style={{ width: logo.width, height: logo.height, objectFit: 'contain' }} />
              <div style={{ fontFamily: k.fonts.mono, fontSize: land ? 22 : 26, fontWeight: 700, letterSpacing: 3, color: k.cream }}>{logo.label}</div>
            </div>;
          })}
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos} faceZoom={p.faceZoom} sourceStartFrame={p.sourceStartFrame} blur={16} dark={0.34} />
      <SceneBg />
      <Chip text={p.label || 'ФАКТ'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: '50%', transform: 'translateY(-50%)', textAlign: 'center' }}>
        {p.big ? <div style={{ ...bigR, fontFamily: k.fonts.display, fontWeight: 700, fontSize: land ? 240 : 360, lineHeight: 0.8, color: k.orange }}>{p.big}</div> : null}
        <FitHeading cream={p.headCream} orange={p.headOrange} width={sw} maxSize={land ? 80 : 92} style={{ marginTop: 6 }} />
        {p.sub ? <div style={{ marginTop: 22, fontSize: 36, opacity: 0.9 }}>{p.sub}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

// 5. TEXT-ONLY: крупная дословная цитата, без спикера
export const SceneTextOnly = (p) => {
  const t = useTheme(); const k = tk(t); const frame = useCurrentFrame(); const { width, height, fps } = useVideoConfig(); const s = safeFor(width, height);
  const land = width > height; const sw = safeWidth(width, height);

  if (p.variant === 'keyword-bounce') {
    const motion = getKeywordMotion(frame, fps);
    return (
      <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
        <SceneBg />
        <Chip text={p.label || 'ХОЧЕШЬ ТАК ЖЕ?'} />
        <div style={{ position: 'absolute', left: s.left, right: s.right, top: '50%', transform: 'translateY(-50%)', textAlign: 'center' }}>
          <FitHeading cream={p.quoteCream} width={sw} maxSize={land ? 112 : 98} />
          <div style={{ margin: '34px auto 38px', display: 'inline-block', background: k.orange, color: k.bg, borderRadius: 18, padding: land ? '16px 38px' : '22px 42px', fontFamily: k.fonts.display, fontWeight: 700, fontSize: land ? 108 : 124, lineHeight: 0.9, boxShadow: `0 18px 55px ${k.orange}45`, transform: `translateY(${motion.y}px) scale(${motion.scale}) rotate(${motion.rotate}deg)` }}>«{p.animateKeyword || 'МОНТАЖ'}»</div>
          <FitHeading orange={p.quoteOrange} width={sw} maxSize={land ? 96 : 82} />
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      <SceneBg />
      <Chip text={p.label || 'ГЛАВНОЕ'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: '50%', transform: 'translateY(-50%)', textAlign: land ? 'center' : 'left' }}>
        <div style={{ fontFamily: k.fonts.display, fontWeight: 700, fontSize: 120, lineHeight: 0.4, color: k.orange }}>“</div>
        <FitHeading cream={p.quoteCream} orange={p.quoteOrange} width={sw} maxSize={land ? 132 : 104} style={{ marginTop: 10 }} />
        {p.author ? <div style={{ marginTop: 46, fontFamily: k.fonts.mono, fontWeight: 700, fontSize: 28, letterSpacing: 3, color: k.muted }}>{p.author}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

// 6. STAT: огромная цифра на фоне блюр-спикера
export const SceneStat = (p) => {
  const t = useTheme(); const k = tk(t); const { width, height } = useVideoConfig(); const s = safeFor(width, height);
  const land = width > height; const sw = safeWidth(width, height); const bigR = useRise(2, 34);
  const statText = `${p.statCream || ''}${p.statOrange || ''}`;
  const statSize = getStatFontSize(statText, sw, land);
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos} faceZoom={p.faceZoom} sourceStartFrame={p.sourceStartFrame} blur={22} dark={0.22} />
      <SceneBg />
      <Chip text={p.label || 'РЕЗУЛЬТАТ'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: '50%', transform: 'translateY(-50%)', textAlign: 'center' }}>
        <div style={{ ...bigR, fontFamily: k.fonts.display, fontWeight: 700, fontSize: statSize, lineHeight: 0.85, whiteSpace: 'nowrap', letterSpacing: -2 }}>
          <span style={{ color: k.cream }}>{p.statCream}</span><span style={{ color: k.orange, marginLeft: 12 }}>{p.statOrange}</span>
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
  const land = width > height; const cardEnter = useRise(0, 20);
  const circle = land ? 200 : 220;
  // кружок спикера в правом верхнем углу сейф-зоны (адаптивно, не вылезает)
  const circleTop = land ? s.top + 10 : 940;
  const textW = land ? Math.round((width - s.left - s.right) * 0.62) : safeWidth(width, height);
  const speakerPos = land
    ? { x: p.facePos?.x ?? 0.34, y: p.facePos?.y ?? 0.32 }
    : { x: p.facePos?.x ?? 0.5, y: p.facePos?.y ?? 0.32 };
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      {p.brollSrc ? <FaceLayer faceSrc={p.brollSrc} image facePos={{ x: 0.5, y: 0.4 }} sourceStartFrame={p.sourceStartFrame} dark={0.85} />
        : <AbsoluteFill style={{ background: 'repeating-linear-gradient(135deg,#241a12,#241a12 40px,#1d1610 40px,#1d1610 80px)' }}><AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6f5e49', fontFamily: k.fonts.mono, fontSize: 38 }}>[ B-ROLL ]</AbsoluteFill></AbsoluteFill>}
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, transparent 45%, rgba(0,0,0,.8))' }} />
      <Chip text={p.videoTitle || 'ВИДЕО'} />
      {p.faceSrc ? <div style={{ position: 'absolute', right: s.right, top: circleTop, width: circle, height: circle, borderRadius: 26, overflow: 'hidden', border: `1px solid ${k.orange}70`, ...cardEnter }}><FaceLayer faceSrc={p.faceSrc} facePos={speakerPos} faceZoom={p.faceZoom} sourceStartFrame={p.sourceStartFrame} /></div> : null}
      <div style={{ position: 'absolute', left: s.left, width: textW, bottom: s.bottom }}>
        <FitHeading cream={p.headCream} orange={p.headOrange} width={textW} maxSize={92} />
        {p.sub ? <div style={{ marginTop: 20, fontSize: 34, opacity: 0.92 }}>{p.sub}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

// 8. CHART: анимированная инфографика экономии (столбцы растут + счётчик ₽)
export const SceneChart = (p) => {
  const t = useTheme(); const k = tk(t); const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig(); const s = safeFor(width, height);
  const sw = safeWidth(width, height);
  const months = p.months || 12;
  const perMonth = p.perMonth || 20000;
  const total = perMonth * months;
  const barMax = 620; // высота области столбцов
  const gap = 12;
  const barW = (sw - gap * (months - 1)) / months;
  const counter = countUp(frame, 10, 10 + fps * 1.6, total); // счётчик 0 -> 240000
  return (
    <AbsoluteFill style={{ background: k.bg, color: k.cream }}>
      <FaceLayer faceSrc={p.faceSrc} facePos={p.facePos} faceZoom={p.faceZoom} sourceStartFrame={p.sourceStartFrame} blur={22} dark={0.2} />
      <SceneBg chrome={false} />
      <Chip text={p.label || 'ЭКОНОМИЯ ЗА ГОД'} />
      <div style={{ position: 'absolute', left: s.left, right: s.right, top: s.top + 40, textAlign: 'center' }}>
        <div style={{ fontFamily: k.fonts.display, fontWeight: 700, fontSize: 150, lineHeight: 0.9 }}>
          <span style={{ color: k.orange }}>{fmt(counter)}</span><span style={{ color: k.cream }}> ₽</span>
        </div>
        <div style={{ fontFamily: k.fonts.mono, fontWeight: 700, fontSize: 30, letterSpacing: 2, color: k.muted, marginTop: 6 }}>
          {fmt(perMonth)} ₽/мес × {months} мес
        </div>
      </div>
      {/* столбцы по месяцам, растут снизу вверх со сдвигом */}
      <div style={{ position: 'absolute', left: s.left, right: s.right, bottom: s.bottom, height: barMax, display: 'flex', alignItems: 'flex-end', gap }}>
        {Array.from({ length: months }).map((_, i) => {
          const targetH = barMax * ((i + 1) / months);
          const g = clamp(frame, 12 + i * 3, 12 + i * 3 + 16, 0, 1);
          const h = targetH * g;
          const last = i === months - 1;
          return <div key={i} style={{ width: barW, height: h, borderRadius: '8px 8px 0 0', background: last ? k.orange : `${k.orange}66`, boxShadow: last ? `inset 0 2px 0 ${k.orange}` : 'none' }} />;
        })}
      </div>
      {/* базовая линия */}
      <div style={{ position: 'absolute', left: s.left, right: s.right, bottom: s.bottom, height: 2, background: k.line }} />
    </AbsoluteFill>
  );
};

export const SCENES = {
  fullscreen: SceneFullscreen,
  chart: SceneChart,
  split: SceneSplit,
  'bottom-diagram': SceneBottomDiagram,
  'blur-overlay': SceneBlurOverlay,
  'text-only': SceneTextOnly,
  stat: SceneStat,
  broll: SceneBroll,
};
