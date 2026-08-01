#!/usr/bin/env node
// Фаза 3.3 — рендер длинного ролика порциями с resume + склейка.
//   node render-chunks.js <comp> <props.json> <out.mp4> <totalFrames> [--chunk 300]
// Готовые порции (out/.chunks/<id>_N.mp4) не перерендериваются — resume после сбоя.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const a = process.argv.slice(2);
const [comp, propsPath, outMp4, totalStr] = a;
const total = parseInt(totalStr, 10);
const chunk = parseInt((a.indexOf('--chunk') >= 0 ? a[a.indexOf('--chunk') + 1] : '300'), 10);
const id = path.basename(outMp4).replace(/\.mp4$/, '');
const dir = path.join(ROOT, 'out/.chunks');
fs.mkdirSync(dir, { recursive: true });

const parts = [];
let done = 0;
for (let from = 0; from < total; from += chunk) {
  const to = Math.min(from + chunk - 1, total - 1);
  const part = path.join(dir, `${id}_${from}-${to}.mp4`);
  parts.push(part);
  if (fs.existsSync(part) && fs.statSync(part).size > 1000) {
    console.log(`· порция ${from}-${to}: уже есть, пропускаю (resume)`);
    done++;
    continue;
  }
  console.log(`· рендер порции ${from}-${to} …`);
  execSync(
    `npx remotion render src/index.js ${comp} "${part}" --props=./${path.relative(ROOT, propsPath)} --frames=${from}-${to} --codec=h264 --log=error`,
    { cwd: ROOT, stdio: 'inherit' }
  );
}
console.log(`порций: ${parts.length} (переиспользовано ${done})`);

// склейка порций concat. Аудио на стыках порций щёлкает → берём аудио
// ЦЕЛЬНЫМ из исходника (--audio), а из порций только видео.
const audioSrc = a.indexOf('--audio') >= 0 ? a[a.indexOf('--audio') + 1] : null;
const listFile = path.join(dir, `${id}_list.txt`);
fs.writeFileSync(listFile, parts.map((p) => `file '${p}'`).join('\n'));
if (audioSrc && fs.existsSync(path.resolve(ROOT, audioSrc))) {
  const glued = path.join(dir, `${id}_v.mp4`);
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${glued}"`, { cwd: ROOT, stdio: 'pipe' });
  // видео из склейки + цельное аудио из исходника (без стыков)
  execSync(`ffmpeg -y -i "${glued}" -i "${path.resolve(ROOT, audioSrc)}" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "${outMp4}"`, { cwd: ROOT, stdio: 'pipe' });
  console.log(`✅ склеено (аудио цельное из ${audioSrc}) → ${outMp4}`);
} else {
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy -movflags +faststart "${outMp4}"`, { cwd: ROOT, stdio: 'pipe' });
  console.log(`✅ склеено → ${outMp4}`);
}
