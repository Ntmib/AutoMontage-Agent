#!/usr/bin/env node
// Фаза 1.1 — «уплотнение»: вырезает паузы И слова-паразиты (явными интервалами),
// пересчитывает таймкоды слов (без второго whisper). Гварды: хук, мин-длина, дыхание.
//   node tighten.js <video> <transcript.json> <out.mp4> <out.transcript.json>
//        [--maxGap 0.6] [--pad 0.1] [--hookGuard 1.5] [--minDur 3] [--no-fillers]
const { execSync } = require('child_process');
const fs = require('fs');

const a = process.argv.slice(2);
const [video, trIn, outMp4, trOut] = a;
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const MAX_GAP = parseFloat(opt('maxGap', '0.6'));
const PAD = parseFloat(opt('pad', '0.1'));
const HOOK = parseFloat(opt('hookGuard', '1.5'));
const MIN_DUR = parseFloat(opt('minDur', '3'));
const USE_FILLERS = !a.includes('--no-fillers');

const FILLER = /^(э+|эм+|ээ+|мм+|ну|типа|короче|значит|как-то|вот|это самое|как бы|в общем|собственно)[.,!?]*$/i;

const segs = JSON.parse(fs.readFileSync(trIn, 'utf8'));
const words = [];
for (const s of segs) for (const w of (s.words || [])) if ((w.w || '').trim()) words.push({ w: w.w.trim(), s: w.s, e: w.e });
if (!words.length) { console.error('нет слов'); process.exit(1); }

const isFiller = (w) => USE_FILLERS && FILLER.test(w.w);
const start0 = words[0].s, endN = words[words.length - 1].e;

// 1) собираем cut-интервалы: филлеры + тихие паузы
let cuts = [];
for (const w of words) if (isFiller(w)) cuts.push([w.s, w.e]);
for (let i = 1; i < words.length; i++) {
  const gap = words[i].s - words[i - 1].e;
  if (gap > MAX_GAP) cuts.push([words[i - 1].e + PAD, words[i].s - PAD]);
}
// hook-guard: не режем в первые HOOK сек
cuts = cuts.map(([s, e]) => [Math.max(s, s < HOOK ? HOOK : s), e]).filter(([s, e]) => e - s > 0.05);
// merge пересечений
cuts.sort((x, y) => x[0] - y[0]);
const merged = [];
for (const c of cuts) {
  if (merged.length && c[0] <= merged[merged.length - 1][1] + 0.02) {
    merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], c[1]);
  } else merged.push([...c]);
}
const fillersCut = words.filter(isFiller).length;
const totalCut = merged.reduce((s, [x, y]) => s + (y - x), 0);
const newDur = (endN - start0) - totalCut;

if (!merged.length || newDur < MIN_DUR) {
  console.log(`ℹ нечего резать. Копирую исходник.`);
  fs.copyFileSync(video, outMp4); fs.copyFileSync(trIn, trOut);
  process.exit(0);
}

// 2) keep = дополнение cuts в [start0, endN]
const keep = [];
let cur = start0;
for (const [cs, ce] of merged) { if (cs > cur) keep.push([cur, cs]); cur = ce; }
if (cur < endN) keep.push([cur, endN]);

console.log(`вырезано: интервалов ${merged.length} (филлеров ${fillersCut}) | было ${(endN - start0).toFixed(1)}с → стало ${newDur.toFixed(1)}с`);

// 3) ffmpeg trim+concat keep-сегментов
let f = '', v = '', au = '';
const XF = 0.008; // 8мс микро-фейд на стыках — убирает щелчки
keep.forEach(([s, e], i) => {
  const len = e - s;
  const fo = Math.max(0, len - XF).toFixed(3);
  f += `[0:v]trim=${s.toFixed(3)}:${e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
  f += `[0:a]atrim=${s.toFixed(3)}:${e.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${XF},afade=t=out:st=${fo}:d=${XF}[a${i}];`;
  v += `[v${i}]`; au += `[a${i}]`;
});
f += `${v}concat=n=${keep.length}:v=1:a=0[vout];${au}concat=n=${keep.length}:v=0:a=1[aout]`;
const filterFile = require('path').join(require('os').tmpdir(), `tighten_filter_${process.pid}.txt`);
fs.writeFileSync(filterFile, f);
execSync(`ffmpeg -y -i "${video}" -filter_complex_script "${filterFile}" -map "[vout]" -map "[aout]" -c:v libx264 -preset veryfast -crf 20 -c:a aac "${outMp4}"`, { stdio: 'pipe' });
fs.unlinkSync(filterFile);

// 4) пересчёт таймкодов: removedBefore(t) = сумма перекрытий cuts с [0,t]
const removedBefore = (t) => merged.reduce((acc, [cs, ce]) => acc + (ce <= t ? ce - cs : (cs < t ? t - cs : 0)), 0);
const inCut = (t) => merged.some(([cs, ce]) => t >= cs && t <= ce);
const rm = (t) => +(t - removedBefore(t)).toFixed(2);

const kw = words.filter((w) => !isFiller(w) && !inCut(w.s));
const newSegs = [{
  start: 0, end: +newDur.toFixed(2), text: kw.map((w) => w.w).join(' '),
  words: kw.map((w) => ({ w: w.w, s: rm(w.s), e: rm(w.e) })),
}];
fs.writeFileSync(trOut, JSON.stringify(newSegs, null, 1));
console.log(`✅ ${outMp4} + транскрипт (${kw.length} слов)`);
