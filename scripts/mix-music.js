#!/usr/bin/env node
// Фаза 2.2 — подмешивает фоновую музыку с ducking (приглушение под голос).
//   node mix-music.js <video_с_голосом> <music> <out.mp4>
//        [--gain -14] [--threshold 0.04] [--ratio 8] [--attack 5] [--release 300]
const { execSync } = require('child_process');

const a = process.argv.slice(2);
const [video, music, out] = a;
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const gain = parseFloat(opt('gain', '-14'));      // dB, громкость музыки до дакинга
const thr = parseFloat(opt('threshold', '0.04')); // порог сайдчейна (линейный 0..1)
const ratio = parseFloat(opt('ratio', '8'));      // сила приглушения
const attack = parseFloat(opt('attack', '5'));
const release = parseFloat(opt('release', '300'));

// [voice] управляет компрессией [music]. amix обратно голос + приглушённую музыку.
const AF = 'aformat=sample_rates=44100:channel_layouts=stereo';
// duration=first → длина по ГОЛОСУ (видео-мастер), музыка не режет ролик.
// apad в конце — если аудио чуть короче видео, дополнить тишиной (не рассинхрон).
const fc = [
  `[1:a]volume=${gain}dB,${AF}[m]`,
  `[0:a]${AF},asplit=2[v][sc]`,
  `[m][sc]sidechaincompress=threshold=${thr}:ratio=${ratio}:attack=${attack}:release=${release}:level_sc=1[duck]`,
  `[v][duck]amix=inputs=2:duration=first:normalize=0,apad[aout]`,
].join(';');

console.log(`музыка ${gain}dB + ducking (thr=${thr} ratio=${ratio}); длина по видео`);
execSync(
  `ffmpeg -y -i "${video}" -stream_loop -1 -i "${music}" ` +
  `-filter_complex "${fc}" -map 0:v -map "[aout]" ` +
  `-c:v copy -c:a aac -b:a 160k -shortest -movflags +faststart "${out}"`,
  { stdio: 'pipe' }
);
console.log(`✅ ${out}`);
