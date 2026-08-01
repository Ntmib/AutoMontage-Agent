// Фаза 4.1 — позиция плашки как параметр (уход от «всегда слева»).
// pos: строка 'left'|'right'|'top'|'bottom'|'center' ИЛИ объект {h,v}.
// Возвращает CSS-позиционирование для контейнера плашки.

const MARGIN = 44;

// нормализуем pos → {h: 'left'|'center'|'right', v: 'top'|'bottom'}
export function normPos(pos, def = { h: 'left', v: 'bottom' }) {
  if (!pos) return def;
  if (typeof pos === 'object') return { h: pos.h || def.h, v: pos.v || def.v };
  switch (pos) {
    case 'left': return { h: 'left', v: 'bottom' };
    case 'right': return { h: 'right', v: 'bottom' };
    case 'top': return { h: 'center', v: 'top' };
    case 'bottom': return { h: 'center', v: 'bottom' };
    case 'center': return { h: 'center', v: 'bottom' };
    default: return def;
  }
}

// Стиль для КАРТОЧКИ фиксированной ширины (InfoCard/CounterCard).
export function cardPos(pos, { width = 560, topGap = 120, bottomGap = 150 } = {}) {
  const p = normPos(pos, { h: 'left', v: 'bottom' });
  const s = { position: 'absolute', width };
  if (p.h === 'left') s.left = MARGIN;
  else if (p.h === 'right') s.right = MARGIN;
  else { s.left = '50%'; s.marginLeft = -width / 2; }
  if (p.v === 'top') s.top = topGap; else s.bottom = bottomGap;
  return s;
}

// Масштаб UI под формат: на горизонте (низкий кадр) плашки крупные — уменьшаем,
// чтобы не лезли на лицо и влезали в бока.
export function uiScale(width, height) {
  if (!height) return 1;
  if (height < 900) return 0.6;   // горизонт 720p и мельче
  if (height < 1300) return 0.82; // квадрат/невысокое
  return 1;                       // вертикаль 1920 — как есть
}

// transformOrigin, чтобы scale ужимал плашку К её краю (не сдвигал позицию).
export function originFor(pos) {
  const p = normPos(pos, { h: 'left', v: 'bottom' });
  const hx = p.h === 'left' ? 'left' : p.h === 'right' ? 'right' : 'center';
  return `${hx} ${p.v === 'top' ? 'top' : 'bottom'}`;
}

// Стиль для ЦЕНТРИРОВАННОГО блока (SubtitleCard/CTACard) — двигаем по горизонтали/вертикали.
export function centerPos(pos, { topGap = 200, bottomGap = 210 } = {}) {
  const p = normPos(pos, { h: 'center', v: 'bottom' });
  // Для боковых плашек ширина УЖЕ (боковая колонка ~28% кадра), чтобы длинный
  // текст переносился на строки в колонке, а не тянулся в центр на лицо.
  const sideW = 480;
  const s = { position: 'absolute', width: p.h === 'center' ? 720 : sideW, textAlign: 'center' };
  if (p.h === 'left') { s.left = 0; s.textAlign = 'left'; s.paddingLeft = MARGIN; }
  else if (p.h === 'right') { s.right = 0; s.textAlign = 'right'; s.paddingRight = MARGIN; }
  else { s.left = 0; }
  if (p.v === 'top') s.top = topGap; else s.bottom = bottomGap;
  return s;
}
