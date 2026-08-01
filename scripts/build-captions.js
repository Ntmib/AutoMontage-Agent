// Конвертер: transcript.json (faster-whisper words) → src/data/captions.js
// Группировка: до 4 слов, до 1.6с, разрыв при паузе > 0.45с.
const fs = require('fs');
const path = require('path');

const IN = path.join(__dirname, '../src/data/transcript.json');
const OUT = path.join(__dirname, '../src/data/captions.js');

const MAX_WORDS = 4;
const MAX_DUR = 1.6;
const GAP = 0.45;

const segs = JSON.parse(fs.readFileSync(IN, 'utf8'));
const words = [];
for (const s of segs) {
  for (const w of (s.words || [])) {
    const text = (w.w || '').trim();
    if (text) words.push({ w: text, s: w.s, e: w.e });
  }
}

const groups = [];
let cur = [];
const flush = () => {
  if (!cur.length) return;
  groups.push({
    start: +cur[0].s.toFixed(2),
    end: +cur[cur.length - 1].e.toFixed(2),
    words: cur.map((x) => ({ w: x.w, s: +x.s.toFixed(2), e: +x.e.toFixed(2) })),
  });
  cur = [];
};

for (let i = 0; i < words.length; i++) {
  const w = words[i];
  if (cur.length) {
    const dur = w.e - cur[0].s;
    const gap = w.s - cur[cur.length - 1].e;
    if (cur.length >= MAX_WORDS || dur > MAX_DUR || gap > GAP) flush();
  }
  cur.push(w);
}
flush();

const js =
  '// АВТОГЕНЕРАЦИЯ (scripts/build-captions.js). Субтитры-группы со словными таймкодами.\n' +
  'export const CAPTIONS = ' + JSON.stringify(groups, null, 1) + ';\n';
fs.writeFileSync(OUT, js);
console.log(`групп: ${groups.length}, слов: ${words.length}`);
console.log('пример:', JSON.stringify(groups[0]));
