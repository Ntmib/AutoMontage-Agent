#!/usr/bin/env node
// Фаза 3.2 — гейт качества монтажного листа: перекрытия, повторы, штампы, перегруз.
//   node quality-gate.js <лист.json>
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('укажи файл листа'); process.exit(1); }
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const blocks = s.blocks || [];

const BOTTOM = new Set(['InfoCard', 'CounterCard', 'CTACard', 'SubtitleCard']); // борются за низ кадра
const CLICHE = /\b(модно|современн\w+|уникальн\w+|лучш\w+|потрясающ\w+|невероятн\w+|крутой|мощн\w+|топов\w+|инновацион\w+)\b/i;

const issues = [];
const dur = s.durationInFrames && s.fps ? s.durationInFrames / s.fps : null;
const endOf = (b) => b.end != null ? b.end : (dur || b.start + 4);

// 1) перекрытия нижних блоков во времени
const bottoms = blocks.map((b, i) => ({ b, i })).filter((x) => BOTTOM.has(x.b.type));
for (let a = 0; a < bottoms.length; a++) for (let c = a + 1; c < bottoms.length; c++) {
  const A = bottoms[a].b, B = bottoms[c].b;
  if (A.start < endOf(B) && B.start < endOf(A))
    issues.push(`перекрытие: ${A.type}@${A.start} и ${B.type}@${B.start} борются за низ кадра`);
}

// 2) повторы: одинаковый type подряд или одинаковый текст
for (let i = 1; i < blocks.length; i++) {
  if (blocks[i].type === blocks[i - 1].type && BOTTOM.has(blocks[i].type))
    issues.push(`повтор подряд: два ${blocks[i].type} (#${i - 1},#${i}) — добавь разнообразия`);
}
const texts = blocks.map((b) => (b.text || b.title || b.head || '')).filter(Boolean);
const seen = {};
for (const t of texts) { const k = t.toLowerCase().trim(); if (seen[k]) issues.push(`дубль текста: «${t}»`); seen[k] = 1; }

// 3) штампы
for (const b of blocks) for (const f of ['text', 'title', 'head', 'sub', 'caption'])
  if (b[f] && CLICHE.test(b[f])) issues.push(`штамп в ${b.type}.${f}: «${b[f]}»`);

// 4) перегруз: >3 акцентных плашек на 10с
if (dur) {
  const accents = blocks.filter((b) => BOTTOM.has(b.type)).map((b) => b.start).sort((a, z) => a - z);
  for (let i = 0; i + 3 < accents.length; i++)
    if (accents[i + 3] - accents[i] < 10)
      issues.push(`перегруз плашками: 4 шт за ${(accents[i + 3] - accents[i]).toFixed(0)}с около ${accents[i]}с`);
}

const score = Math.max(0, 100 - issues.length * 18);
const verdict = score >= 80 ? 'STRONG' : score >= 55 ? 'OK' : score >= 30 ? 'REVISE' : 'FAIL';
console.log(`\nКачество листа: ${score}/100 — ${verdict}`);
if (issues.length) { console.log('Замечания:'); [...new Set(issues)].forEach((x) => console.log('  ⚠ ' + x)); }
else console.log('  замечаний нет ✓');
process.exit(verdict === 'FAIL' ? 2 : 0);
