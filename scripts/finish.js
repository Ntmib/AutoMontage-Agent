#!/usr/bin/env node
// Фаза 1.2 – финиш-проход: громкость под соцсети + (опц.) HDR→SDR + резкость.
//   node finish.js <in.mp4> <out.mp4> [--hdrfix auto|on|off] [--sharpen] [--lanczos WxH]
const { execSync } = require('child_process');
const { buildFinishAudioFilter } = require('./finish-audio');

const a = process.argv.slice(2);
const [inp, out] = a;
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const hdrMode = opt('hdrfix', 'auto');
const sharpen = a.includes('--sharpen');
const lanczos = opt('lanczos', null);
const audioAdvanceMs = Number(opt('audio-advance-ms', '0'));

// автодетект HDR по color_transfer
let isHDR = false;
try {
  const ct = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=color_transfer -of default=nk=1:nw=1 "${inp}"`).toString().trim();
  isHDR = /smpte2084|arib-std-b67/.test(ct);
} catch {}
const doHDR = hdrMode === 'on' || (hdrMode === 'auto' && isHDR);

const vf = [];
if (doHDR) vf.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p');
if (lanczos) vf.push(`scale=${lanczos.replace('x', ':')}:flags=lanczos`);
if (sharpen) vf.push('unsharp=5:5:0.8:5:5:0.0');

const audioFilter = buildFinishAudioFilter(audioAdvanceMs);
const AUDIO = `-af "${audioFilter}" -c:a aac -b:a 160k`;
const video = vf.length ? `-vf "${vf.join(',')}" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p` : '-c:v copy';

console.log(`финиш: loudnorm=-14LUFS${audioAdvanceMs ? ` + звук вперёд ${audioAdvanceMs}мс` : ''}${doHDR ? ' + HDR→SDR' : ''}${sharpen ? ' + sharpen' : ''}${lanczos ? ' + lanczos' : ''}`);
execSync(`ffmpeg -y -i "${inp}" ${video} ${AUDIO} -movflags +faststart "${out}"`, { stdio: 'pipe' });

// печать реальной громкости после нормализации (для проверки)
try {
  const m = execSync(`ffmpeg -i "${out}" -af loudnorm=print_format=summary -f null - 2>&1 | grep -i "Input Integrated" || true`).toString().trim();
  if (m) console.log('  факт: ' + m.replace('Input', 'громкость'));
} catch {}
console.log(`✅ ${out}`);
