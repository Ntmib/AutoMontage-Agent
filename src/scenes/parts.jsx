import { AbsoluteFill, OffthreadVideo, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { fitText } from '@remotion/layout-utils';
import { useTheme } from '../theme';
import { springIn, clamp } from '../anim';
import { tk, safeFor } from './safezone';

const src = (s) => (s && s.startsWith('http') ? s : staticFile(s));

// Фон: виньетка + грунж-текстура + декор (орбита/звёзды/плюсы/рамка) внутри сейф-зоны
export const SceneBg = ({ chrome = true }) => {
  const t = useTheme(); const k = tk(t);
  const { width, height } = useVideoConfig(); const s = safeFor(width, height);
  const land = width > height;
  const star = (st) => <div style={{ position: 'absolute', color: k.orange, fontFamily: k.fonts.mono, ...st }}>✳</div>;
  const plus = (st) => <div style={{ position: 'absolute', color: k.muted, fontFamily: k.fonts.mono, opacity: 0.6, ...st }}>+</div>;
  const orbitStyle = land
    ? { left: -260, bottom: -420, width: 760, height: 760 }
    : { right: -140, top: 200, width: 900, height: 900 };
  const stars = land
    ? <>{star({ right: s.right + 24, top: s.top + 110, fontSize: 34 })}{star({ left: s.left + 20, bottom: s.bottom + 80, fontSize: 28 })}</>
    : <>{star({ right: s.right + 20, top: 360, fontSize: 54 })}{star({ left: s.left + 20, bottom: s.bottom + 120, fontSize: 36 })}</>;
  const pluses = land
    ? <>{plus({ right: s.right + 36, bottom: s.bottom + 90, fontSize: 30 })}{plus({ left: s.left + 10, top: s.top + 240, fontSize: 28 })}</>
    : <>{plus({ right: s.right + 40, top: 720, fontSize: 46 })}{plus({ left: s.left, top: 980, fontSize: 40 })}</>;
  return (
    <>
      <AbsoluteFill style={{ background: `radial-gradient(120% 80% at 75% 28%, ${k.orange}16, transparent 55%), radial-gradient(90% 60% at 12% 100%, rgba(0,0,0,.55), transparent 60%), radial-gradient(140% 120% at 50% 30%, transparent 55%, rgba(0,0,0,.5))` }} />
      {k.L.grungeTexture && <AbsoluteFill style={{ backgroundImage: `url(${k.L.grungeTexture})`, backgroundSize: 'cover', opacity: 0.14, mixBlendMode: 'overlay' }} />}
      {chrome && k.D.orbit && <div style={{ position: 'absolute', ...orbitStyle, borderRadius: '50%', border: `2px dotted ${k.orange}55` }} />}
      {chrome && k.D.stars && stars}
      {chrome && k.D.plus && pluses}
      {chrome && k.D.frame && <div style={{ position: 'absolute', inset: 34, border: `1px dashed ${k.line}`, borderRadius: 12, opacity: 0.5 }} />}
    </>
  );
};

// Полноэкранное медиа (спикер/картинка), можно за сейф-зону. blur/dark для оверлея.
export const FaceLayer = ({ faceSrc, facePos, faceZoom = 1, sourceStartFrame = 0, blur = 0, dark = 1, image = false }) => {
  if (!faceSrc) return <AbsoluteFill style={{ background: '#0d0a07' }} />;
  const pos = facePos ? `${Math.round((facePos.x ?? 0.5) * 100)}% ${Math.round((facePos.y ?? 0.5) * 100)}%` : '50% 50%';
  const style = { width: '100%', height: '100%', objectFit: 'cover', objectPosition: pos, filter: `blur(${blur}px) brightness(${dark})`, transform: `scale(${faceZoom})` };
  return <AbsoluteFill>{image ? <Img src={src(faceSrc)} style={style} /> : <OffthreadVideo src={src(faceSrc)} style={style} muted trimBefore={sourceStartFrame} />}</AbsoluteFill>;
};

// Чип-лейбл (статичный заголовок видео / метка сцены), в сейф-зоне сверху
export const Chip = ({ text }) => {
  const t = useTheme(); const k = tk(t);
  const { width, height } = useVideoConfig(); const s = safeFor(width, height);
  return (
    <div style={{ position: 'absolute', top: s.top - 8, left: s.left, background: k.orange, color: k.bg, fontFamily: k.fonts.mono, fontWeight: 700, fontSize: 30, letterSpacing: 3, padding: '14px 26px', borderRadius: 10, maxWidth: width - s.left - s.right, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{'▸_ ' + text}</div>
  );
};

// Двухцветный заголовок с АВТО-подгонкой под ширину сейф-зоны (не вылезает)
export const FitHeading = ({ cream = '', orange = '', maxSize = 118, width, style = {} }) => {
  const t = useTheme(); const k = tk(t);
  const words = (cream + ' ' + orange).trim().split(/\s+/);
  const longest = words.sort((a, b) => b.length - a.length)[0] || '';
  let size = maxSize;
  try { size = Math.min(maxSize, fitText({ text: longest, withinWidth: width, fontFamily: k.fonts.display, fontWeight: 700 }).fontSize); } catch (e) { /* noop */ }
  return (
    <div style={{ fontFamily: k.fonts.display, fontWeight: 700, textTransform: 'uppercase', lineHeight: 0.92, fontSize: size, ...style }}>
      {cream ? <div style={{ color: k.cream }}>{cream}</div> : null}
      {orange ? <div style={{ color: k.orange }}>{orange}</div> : null}
    </div>
  );
};

// helper анимаций
export const useRise = (delay = 0, px = 40) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const s = springIn(frame, fps, delay, { damping: 15, mass: 0.9 });
  return { opacity: clamp(s, 0, 1, 0, 1), transform: `translateY(${clamp(s, 0, 1, px, 0)}px)` };
};
