#!/usr/bin/env node
// Гейт «динамика или слайд-шоу»: численно оценивает монтажный лист по методике
// docs/editing-rules.md. Логика написана с нуля под наш формат листа (blocks по
// таймкодам). Метрики 0..5 (ниже — лучше), среднее → вердикт.
//   node dynamic-gate.js <лист.json> [transcript.json]
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('укажи файл листа'); process.exit(1); }
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const blocks = s.blocks || [];
const fps = s.fps || 25;
const dur = (s.durationInFrames ? s.durationInFrames / fps : Math.max(...blocks.map((b) => b.end || b.start + 4), 1));
const minutes = dur / 60;

const ACCENT = new Set(['InfoCard', 'CounterCard', 'SubtitleCard', 'CTACard']);
const TEXT = new Set(['InfoCard', 'CounterCard', 'SubtitleCard', 'CTACard']);
const endOf = (b) => (b.end != null ? b.end : b.start + 4);

// «События» (смены визуала): акцентные плашки + врезки + beat-точки зум-ритма
const eventTimes = [];
for (const b of blocks) {
  if (ACCENT.has(b.type) || b.type === 'BrollFullscreen') eventTimes.push(b.start);
}
if (s.beatZoom) { const bs = s.beatSec || 3; for (let t = 0; t < dur; t += bs) eventTimes.push(t); }
eventTimes.sort((a, b) => a - b);

const dims = {};

// 1. Частота событий (норма 20–40/мин)
const perMin = eventTimes.length / (minutes || 1);
dims.pacing = {
  score: perMin >= 18 ? 0 : perMin >= 12 ? 2 : perMin >= 7 ? 3.5 : 5,
  reason: `${perMin.toFixed(0)} событий/мин (норма 20–40)`,
};

// 2. Длинные статичные секции (нет события > 8с)
let maxGap = eventTimes.length ? eventTimes[0] : dur;
for (let i = 1; i < eventTimes.length; i++) maxGap = Math.max(maxGap, eventTimes[i] - eventTimes[i - 1]);
maxGap = Math.max(maxGap, dur - (eventTimes[eventTimes.length - 1] || 0));
dims.static_holds = {
  score: maxGap <= 6 ? 0 : maxGap <= 10 ? 2.5 : maxGap <= 16 ? 4 : 5,
  reason: `макс. пауза без события ${maxGap.toFixed(0)}с (порог ~8с)`,
};

// 3. Хук в первые 3 сек (плашка/лейбл/врезка)
const hasHook = blocks.some((b) => b.start < 3 && (ACCENT.has(b.type) || b.type === 'LabelTop' || b.type === 'BrollFullscreen'));
dims.hook = { score: hasHook ? 0 : 4, reason: hasHook ? 'хук в первые 3с есть' : 'нет визуального события в первые 3с' };

// 4. Перегруз текстом (доля времени, когда на экране текстовая плашка)
let textTime = 0;
for (const b of blocks) if (TEXT.has(b.type)) textTime += (endOf(b) - b.start);
const textRatio = Math.min(1, textTime / dur);
dims.text_overload = {
  score: textRatio > 0.7 ? 4 : textRatio > 0.5 ? 2.5 : textRatio > 0.3 ? 1 : 0,
  reason: `текст на экране ~${(textRatio * 100).toFixed(0)}% времени`,
};

// 5. Повтор макетов (одинаковый pos подряд у акцентных)
const acc = blocks.filter((b) => ACCENT.has(b.type));
const sideOf = (b) => (typeof b.pos === 'object' && b.pos ? `${b.pos.h}-${b.pos.v}` : (b.pos || 'default'));
let repeats = 0;
for (let i = 1; i < acc.length; i++) if (sideOf(acc[i]) === sideOf(acc[i - 1])) repeats++;
const repRatio = acc.length > 1 ? repeats / (acc.length - 1) : 0;
dims.layout_repetition = {
  score: repRatio > 0.6 ? 4 : repRatio > 0.35 ? 2 : 0,
  reason: `${repeats} одинаковых позиций подряд из ${acc.length - 1}`,
};

// 6. Синхрон: события под речью (если дан транскрипт)
if (process.argv[3] && fs.existsSync(process.argv[3])) {
  const segs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const speech = segs.map((x) => [x.start, x.end]);
  const inSpeech = (t) => speech.some(([a, b]) => t >= a - 0.5 && t <= b + 0.5);
  const misses = acc.filter((b) => !inSpeech(b.start)).length;
  dims.sync = {
    score: acc.length ? Math.min(5, (misses / acc.length) * 6) : 0,
    reason: `${misses}/${acc.length} плашек не под речью (в паузе/тишине)`,
  };
}

// 7. Повтор картинок (одна картинка = один показ)
const imgs = blocks.filter((b) => b.type === 'BrollFullscreen' && b.image).map((b) => b.image);
const dup = imgs.filter((x, i) => imgs.indexOf(x) !== i);
dims.image_repeat = {
  score: dup.length >= 2 ? 5 : dup.length === 1 ? 3 : 0,
  reason: dup.length ? `картинка повторяется: ${[...new Set(dup)].join(', ')} — нужны РАЗНЫЕ` : 'все картинки уникальны',
};

const scores = Object.values(dims).map((d) => d.score);
const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
const verdict = avg < 1.5 ? 'STRONG' : avg < 2.5 ? 'OK' : avg < 3.5 ? 'REVISE' : 'FAIL (похоже на слайд-шоу)';

console.log(`\nДинамика листа: ${avg.toFixed(2)}/5 (ниже — лучше) — ${verdict}`);
for (const [k, d] of Object.entries(dims)) {
  const mark = d.score >= 3.5 ? '⚠' : d.score >= 2 ? '·' : '✓';
  console.log(`  ${mark} ${k}: ${d.score} — ${d.reason}`);
}
process.exit(avg >= 3.5 ? 2 : 0);
