#!/usr/bin/env node
// Фаза 2.3 — скоринг «цепляют ли первые секунды» + топ-моменты по транскрипту.
// RU-адаптация паттернов hyperion analyze_hook_quality_2026.
//   node hook-score.js <transcript.json> [--window 3]
const fs = require('fs');

const a = process.argv.slice(2);
const tr = a[0];
const WIN = parseFloat((a.indexOf('--window') >= 0 ? a[a.indexOf('--window') + 1] : '3'));

const PATTERNS = [
  { k: 'вопрос-крючок', w: 20, re: /\?|почему|как\b|что если|знаете ли|а вы/i },
  { k: 'число/факт', w: 18, re: /\d|перв\w+|топ|раз\b|процент|%|рубл|тысяч|миллион/i },
  { k: 'обещание-ценность', w: 16, re: /покажу|расскажу|научу|секрет|способ|лайфхак|бесплатн|за \d/i },
  { k: 'разрыв-шаблона', w: 22, re: /никогда|перестань|забудь|на самом деле|миф|ошибк|хватит|стоп/i },
  { k: 'срочность/интрига', w: 14, re: /сейчас|прямо сейчас|смотри|внимание|только что|впервые/i },
  { k: 'эмоция/личное', w: 12, re: /я \w+|честно|шок|невероятн|устал|бол\w+|мечт/i },
];
const WEAK = /^(ну|значит|в общем|короче|так вот|итак|привет|здравствуйте|меня зовут)\b/i;

const segs = JSON.parse(fs.readFileSync(tr, 'utf8'));
const words = [];
for (const s of segs) for (const w of (s.words || [])) if ((w.w || '').trim()) words.push({ w: w.w.trim(), s: w.s });
const textIn = (t0, t1) => words.filter((w) => w.s >= t0 && w.s < t1).map((w) => w.w).join(' ');

const hookText = textIn(0, WIN);
let score = 0; const hits = [];
for (const p of PATTERNS) if (p.re.test(hookText)) { score += p.w; hits.push(p.k); }
if (WEAK.test(hookText.trim())) { score -= 15; hits.push('⚠ слабый старт'); }
score = Math.max(0, Math.min(100, score));

const verdict = score >= 55 ? 'СИЛЬНЫЙ' : score >= 30 ? 'средний' : 'СЛАБЫЙ — переписать первые секунды';
console.log(`\nХук (первые ${WIN}с): "${hookText}"`);
console.log(`Скор: ${score}/100 — ${verdict}`);
console.log(`Паттерны: ${hits.length ? hits.join(', ') : 'не найдено'}`);

// топ-моменты: скользящее окно WIN сек по всей речи
const end = words.length ? words[words.length - 1].s : 0;
const spots = [];
for (let t = 0; t < end; t += 1) {
  const tx = textIn(t, t + WIN); let sc = 0;
  for (const p of PATTERNS) if (p.re.test(tx)) sc += p.w;
  if (sc > 0) spots.push({ t, sc, tx: tx.slice(0, 60) });
}
spots.sort((x, y) => y.sc - x.sc);
console.log('\nТоп-моменты (для нарезки/акцентов):');
spots.slice(0, 5).forEach((s) => console.log(`  ${s.t.toFixed(0)}с [${s.sc}] ${s.tx}`));
