// Сейф-зоны Instagram Reels / Shorts (1080x1920). Текст держим ВНУТРИ,
// медиа (спикер/картинка) может уходить за неё на весь экран.
export const SAFE_9x16 = { top: 250, bottom: 420, left: 70, right: 130 };
export const SAFE_16x9 = { top: 60, bottom: 60, left: 80, right: 80 };

export const safeFor = (w, h) => (h > w ? SAFE_9x16 : SAFE_16x9);

// Ширина, доступная тексту внутри сейф-зоны
export const safeWidth = (w, h) => { const s = safeFor(w, h); return w - s.left - s.right; };

// Стиль-контейнер сейф-зоны (для текстовых блоков)
export const safeBox = (w, h, extra = {}) => {
  const s = safeFor(w, h);
  return { position: 'absolute', left: s.left, right: s.right, top: s.top, bottom: s.bottom, ...extra };
};

// Токены темы с fallback'ами (дублирует логику из blocks/LessonSlide, чтобы сцены были самодостаточны)
export const tk = (t) => {
  const c = t.colors;
  return {
    bg: c.bg, orange: c.orange || c.accent, cream: c.cream || c.text,
    muted: c.textSoft || '#9A8C78', line: c.line || 'rgba(255,255,255,.12)',
    panel: c.panel || c.cardBg, fonts: t.fonts, radius: t.radius,
    cardShadow: t.cardShadow, L: t.lesson || {}, D: (t.lesson || {}).decor || {},
  };
};
