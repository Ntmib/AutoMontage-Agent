#!/usr/bin/env node
// Вырезает длинные паузы из видео по словным таймкодам транскрипта.
// node cut-pauses.js <video> <transcript.json> <out.mp4> [maxGap] [pad]
const { execSync } = require('child_process');
const fs = require('fs');

const [video, tr, out] = process.argv.slice(2);
const MAX_GAP = parseFloat(process.argv[6] || '0.55'); // паузы длиннее — режем
const PAD = parseFloat(process.argv[7] || '0.10');      // дыхание вокруг реплик

const segs = JSON.parse(fs.readFileSync(tr, 'utf8'));
const words = [];
for (const s of segs) for (const w of (s.words || [])) if ((w.w || '').trim()) words.push(w);
if (!words.length) { console.error('нет слов'); process.exit(1); }

// строим keep-интервалы, схлопывая большие gap
const keep = [];
let cs = Math.max(0, words[0].s - PAD);
let ce = words[0].e;
for (let i = 1; i < words.length; i++) {
  const gap = words[i].s - ce;
  if (gap > MAX_GAP) { keep.push([cs, ce + PAD]); cs = words[i].s - PAD; }
  ce = words[i].e;
}
keep.push([cs, ce + PAD]);

const kept = keep.reduce((a, [s, e]) => a + (e - s), 0);
console.log(`keep-сегментов: ${keep.length}, длительность после: ${kept.toFixed(1)}с`);

// filter_complex: trim каждого сегмента + concat
let f = '', v = '', a = '';
keep.forEach(([s, e], i) => {
  f += `[0:v]trim=${s}:${e},setpts=PTS-STARTPTS[v${i}];`;
  f += `[0:a]atrim=${s}:${e},asetpts=PTS-STARTPTS[a${i}];`;
  v += `[v${i}]`; a += `[a${i}]`;
});
f += `${v}concat=n=${keep.length}:v=1:a=0[vout];${a}concat=n=${keep.length}:v=0:a=1[aout]`;

const cutFilter = require('path').join(require('os').tmpdir(), `cutfilter_${process.pid}.txt`);
fs.writeFileSync(cutFilter, f);
execSync(
  `ffmpeg -y -i "${video}" -filter_complex_script "${cutFilter}" -map "[vout]" -map "[aout]" ` +
  `-c:v libx264 -preset veryfast -crf 20 -c:a aac "${out}"`,
  { stdio: 'pipe' }
);
fs.unlinkSync(cutFilter);
console.log(`✅ ${out}`);
