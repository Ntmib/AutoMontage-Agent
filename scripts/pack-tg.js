#!/usr/bin/env node
// Финальная упаковка под Telegram: сжатие + ЖЁСТКИЙ A/V-синхрон.
// Чинит «звук убегает»: -vsync cfr фиксирует число кадров (видео не растёт),
// apad+shortest выравнивают аудио точно по длине видео.
//   node pack-tg.js <in.mp4> <out.mp4> [--fps 25] [--maxrate 2200k] [--h 720]
const { execSync } = require('child_process');
const a = process.argv.slice(2);
const [inp, out] = a;
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const fps = opt('fps', '25');
const maxrate = opt('maxrate', '2200k');

execSync(
  `ffmpeg -y -i "${inp}" ` +
  `-r ${fps} -vsync cfr ` +                         // фикс кадров: видео не растянется
  `-c:v libx264 -preset veryfast -crf 25 -maxrate ${maxrate} -bufsize ${parseInt(maxrate) * 2}k -pix_fmt yuv420p ` +
  `-af apad -c:a aac -b:a 128k -shortest ` +          // аудио доложить/обрезать точно по видео
  `-movflags +faststart "${out}"`,
  { stdio: 'pipe' }
);

// проверка синхрона
const dv = parseFloat(execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=duration -of default=nk=1:nw=1 "${out}"`).toString());
const da = parseFloat(execSync(`ffprobe -v error -select_streams a:0 -show_entries stream=duration -of default=nk=1:nw=1 "${out}"`).toString());
const diff = Math.abs(dv - da);
console.log(`✅ ${out}  video=${dv.toFixed(2)}с audio=${da.toFixed(2)}с  Δ=${(diff * 1000).toFixed(0)}мс ${diff < 0.08 ? 'СИНХРОН OK' : '⚠ рассинхрон'}`);
