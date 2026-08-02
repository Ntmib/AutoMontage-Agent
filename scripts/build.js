#!/usr/bin/env node
// Пайплайн монтажа: видео → транскрипт → субтитры → (черновой лист) → рендер.
// Использование:
//   node scripts/build.js <video> [--theme craft] [--scenario file.json]
//                                 [--id name] [--frames N] [--model base]
const fs = require('fs');
const path = require('path');
const { ROOT, tmp, python, remotionBin, execSync } = require('./env');

const args = process.argv.slice(2);
let video = args[0];
if (!video || !fs.existsSync(path.resolve(process.cwd(), video))) { console.error('❌ укажи существующий видеофайл'); process.exit(1); }
video = path.resolve(process.cwd(), video);   // абсолютный путь — работает из любой папки (глобальный запуск)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const theme = opt('theme', 'craft');
const id = opt('id', 'out');
const outDir = opt('outdir', null);           // куда положить финал (по умолчанию out/ внутри пакета)
const PY = python();                           // python3 / python — что есть в системе
const audioWav = tmp(`${id}_audio.wav`);
const model = opt('model', 'large-v3-turbo');
const framesOverride = opt('frames', null);
const scenarioFile = opt('scenario', null);

const sh = (c) => execSync(c, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
const log = (m) => console.log('· ' + m);

// 1. ffprobe
const probe = sh(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate:format=duration -of json "${video}"`);
const info = JSON.parse(probe);
const [fn, fd] = info.streams[0].r_frame_rate.split('/').map(Number);
const FPS = Math.round(fn / (fd || 1)) || 30;
const DUR = parseFloat(info.format.duration);
log(`видео ${info.streams[0].width}x${info.streams[0].height} @ ${FPS}fps, ${DUR.toFixed(1)}с (тема: ${theme})`);

// 1b. (опц.) reframe 16:9 → 9:16 по лицу (Фаза 3.1)
let video1 = video;
if (args.includes('--reframe')) {
  const rmode = opt('reframe', 'track');
  log(`reframe → вертикаль (${rmode})…`);
  const rOut = tmp(`${id}_reframe.mp4`);
  console.log('  ' + sh(`${PY} scripts/reframe.py "${video}" "${rOut}" --mode ${rmode}`).split('\n').filter(Boolean).slice(-1)[0]);
  video1 = rOut;
  const wh = sh(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "${rOut}"`).split('x');
  info.streams[0].width = +wh[0]; info.streams[0].height = +wh[1];
}
const W = info.streams[0].width, H = info.streams[0].height;

// 2. аудио
log('извлекаю аудио…');
sh(`ffmpeg -y -i "${video1}" -vn -ar 16000 -ac 1 "${audioWav}"`);

// 3. транскрипция
log('транскрибирую (faster-whisper)…');
sh(`${PY} scripts/transcribe.py "${audioWav}" src/data/transcript.json ${model}`);

// 3b. (опц.) tighten — рез пауз + слов-паразитов
let srcVideo = video1;
if (args.includes('--tighten')) {
  log('уплотняю (паузы + слова-паразиты)…');
  const tOut = tmp(`${id}_tight.mp4`);
  console.log('  ' + sh(`node scripts/tighten.js "${video1}" src/data/transcript.json "${tOut}" src/data/transcript.json`).split('\n').filter(Boolean).slice(-2).join(' | '));
  srcVideo = tOut;
  // пересчитать длительность/кадры по уплотнённому видео
  const dur2 = parseFloat(sh(`ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${tOut}"`));
  if (dur2 > 0) { info.format.duration = dur2; }
}
const DUR2 = parseFloat(info.format.duration);
const totalFrames2 = Math.ceil(DUR2 * FPS);
const durF = framesOverride ? Math.min(+framesOverride, totalFrames2) : totalFrames2;

// 4. субтитры
sh(`node scripts/build-captions.js`);
const { CAPTIONS } = requireFresh('../src/data/captions.js');
log(`субтитров: ${CAPTIONS.length} групп`);

// 5. монтажный лист (+ зум-ритм beatZoom)
// приоритет: флаг --beat → из scenario-файла → выкл по умолчанию
let blocks, beatZoom = false, beatSec = parseFloat(opt('beatSec', '3'));
if (scenarioFile) {
  const sc = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  blocks = sc.blocks;
  if (sc.beatZoom != null) beatZoom = !!sc.beatZoom;
  if (sc.beatSec != null) beatSec = sc.beatSec;
  log(`лист из файла: ${blocks.length} блоков`);
} else {
  blocks = draftScenario(CAPTIONS);
  const draftPath = `out/${id}.scenario.json`;
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, draftPath), JSON.stringify({ source: 'source.mp4', theme, beatZoom, beatSec, blocks }, null, 2));
  log(`черновой лист → ${draftPath} (${blocks.length} блоков, поправь и перезапусти с --scenario)`);
}
if (args.includes('--beat')) beatZoom = true;   // «ритмичный зум / режь динамику»
if (beatZoom) log(`зум-ритм ВКЛ (каждые ${beatSec}с)`);

// 5c. (опц.) autopos — адаптивные позиции акцентных плашек по кадру (Фаза 4.1)
if (args.includes('--autopos')) {
  const ACC = ['InfoCard', 'CounterCard', 'SubtitleCard', 'CTACard'];
  const acc = blocks.filter((b) => ACC.includes(b.type));
  const slots = acc.map((b) => b.start).join(',');
  if (slots) {
    try {
      const placeJson = tmp(`${id}_place.json`);
      sh(`${PY} scripts/analyze-frames.py "${srcVideo}" --slots "${slots}" --out "${placeJson}"`);
      const place = JSON.parse(fs.readFileSync(placeJson, 'utf8'));
      acc.forEach((b, i) => { if (place[i] && place[i].pos) b.pos = place[i].pos; });
      log(`autopos: позиции плашек расставлены по кадру (${acc.length})`);
    } catch (e) { log('⚠️ autopos не сработал: ' + e.message.split('\n')[0]); }
  }
}

// 5d. (опц.) autotheme — тема из палитры видео (Фаза 4.4-4.6)
let themeVal = theme;
if (args.includes('--autotheme')) {
  try {
    const bl = opt('brandLock', '1.0');
    const out = sh(`node scripts/palette.js "${srcVideo}" --brandLock ${bl}`);
    themeVal = JSON.parse(out.split('// ── diagnostics')[0].trim());
    log(`autotheme: тема сгенерирована из палитры видео (brandLock ${bl})`);
  } catch (e) { log('⚠️ autotheme не сработал: ' + e.message.split('\n')[0]); }
}

// 6. исходник в public (пропустить, если это уже он)
const destSrc = path.join(ROOT, 'public/source.mp4');
if (path.resolve(srcVideo) !== destSrc) fs.copyFileSync(path.resolve(srcVideo), destSrc);

// 7. props
const props = { source: 'source.mp4', theme: themeVal, blocks, width: W, height: H, fps: FPS, durationInFrames: durF, beatZoom, beatSec };

// 7b. валидация листа ДО рендера (Фаза 2.1)
const { validate } = require('./validate');
const vr = validate(props);
if (!vr.ok) {
  console.error('❌ монтажный лист невалиден — рендер отменён:');
  vr.errors.forEach((e) => console.error('  · ' + e));
  process.exit(1);
}
log('монтажный лист валиден ✓');

const propsPath = `out/${id}.props.json`;
fs.writeFileSync(path.join(ROOT, propsPath), JSON.stringify(props));

// 7c. гейт качества листа (Фаза 3.2) — предупреждение, не блокер
try {
  const g = execSync(`node scripts/quality-gate.js ${propsPath}`, { cwd: ROOT }).toString().trim();
  const warn = g.split('\n').filter((l) => l.includes('⚠'));
  if (warn.length) { log('гейт качества — замечания:'); warn.forEach((w) => console.log('  ' + w.trim())); }
  else log('гейт качества: чисто ✓');
} catch (e) { /* FAIL не блокирует, но покажем */ if (e.stdout) console.log(e.stdout.toString()); }

// 7d. гейт динамики: «динамика или слайд-шоу» (docs/editing-rules.md)
try {
  const g = execSync(`node scripts/dynamic-gate.js ${propsPath} src/data/transcript.json`, { cwd: ROOT }).toString().trim();
  const verdict = g.split('\n').find((l) => l.includes('Динамика листа')) || '';
  const warn = g.split('\n').filter((l) => l.includes('⚠'));
  if (verdict) log(verdict.trim());
  warn.forEach((w) => console.log('  ' + w.trim()));
} catch (e) { if (e.stdout) { log('⚠️ динамика: похоже на слайд-шоу — стоит добавить событий'); console.log(e.stdout.toString().split('\n').filter((l) => l.includes('⚠')).join('\n')); } }

// 8. рендер (порциями для длинных — Фаза 3.3)
const rawMp4 = `out/${id}.raw.mp4`;
log(`рендер → ${rawMp4} …`);
if (durF > 540) {
  log('длинный ролик — рендерю порциями (resume при сбое)');
  execSync(`node scripts/render-chunks.js Dynamic ${propsPath} ${rawMp4} ${durF} --chunk 300 --audio public/source.mp4`, { cwd: ROOT, stdio: 'inherit' });
} else {
  execSync(`${remotionBin()} render src/index.js Dynamic ${rawMp4} --props=./${propsPath} --codec=h264 --log=error`,
    { cwd: ROOT, stdio: 'inherit' });
}

// 9. финиш-проход: громкость -14 LUFS (+ авто HDR→SDR)
const outMp4 = `out/${id}.mp4`;
log('финиш (громкость + картинка)…');
console.log('  ' + sh(`node scripts/finish.js ${rawMp4} ${outMp4} --hdrfix auto`).split('\n').filter(Boolean).slice(-2).join(' | '));

// 10. (опц.) фоновая музыка с ducking (Фаза 2.2)
if (props.audio && props.audio.music && props.audio.music.file) {
  const m = props.audio.music;
  const d = m.ducking || {};
  const musPath = path.isAbsolute(m.file) ? m.file : path.join(ROOT, m.file);
  if (fs.existsSync(musPath)) {
    log('подмешиваю музыку (ducking)…');
    const flags = [
      m.gain_db != null ? `--gain ${m.gain_db}` : '',
      d.threshold_db != null ? `--threshold ${Math.pow(10, d.threshold_db / 20).toFixed(4)}` : '',
      d.reduction_db != null ? `--ratio ${Math.max(2, Math.min(20, Math.abs(d.reduction_db)))}` : '',
      d.attack_ms != null ? `--attack ${d.attack_ms}` : '',
      d.release_ms != null ? `--release ${d.release_ms}` : '',
    ].filter(Boolean).join(' ');
    const musTmp = tmp(`${id}_mus.mp4`);
    console.log('  ' + sh(`node scripts/mix-music.js ${outMp4} "${musPath}" "${musTmp}" ${flags}`).split('\n').filter(Boolean).slice(-1)[0]);
    fs.copyFileSync(musTmp, path.join(ROOT, outMp4)); fs.unlinkSync(musTmp);   // кросс-платформенно (без unix mv)
  } else {
    log(`⚠️ музыка не найдена: ${musPath} — пропускаю`);
  }
}

let finalPath = path.join(ROOT, outMp4);
if (outDir) {   // глобальный запуск: положить результат рядом с пользователем
  const dest = path.resolve(process.cwd(), outDir, `${id}.mp4`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(finalPath, dest);
  finalPath = dest;
}
console.log(`\n✅ готово: ${finalPath}  (${W}x${H}, аспект исходника сохранён)`);
console.log('   отправлять как ДОКУМЕНТ [ФАЙЛ:] — иначе Telegram сплющит вертикаль.');

// --- helpers ---
function requireFresh(p) { const abs = require.resolve(p); delete require.cache[abs]; return require(abs); }

function draftScenario(caps) {
  const b = [{ type: 'LabelTop', start: 0.3, text: '>_ ВИДЕО' }];
  b.push({ type: 'CaptionsAuto', start: 0, groups: caps, offset: 300 });
  // эвристика CTA: последняя группа со словами-триггерами
  const last = caps[caps.length - 1];
  const txt = (g) => g.words.map((w) => w.w).join(' ').toLowerCase();
  if (last && /ссылк|кнопк|жми|подпис|переход/.test(txt(last))) {
    b.push({ type: 'CTACard', start: Math.max(0, last.start - 0.2), head: 'ЖМИ', btn: 'ССЫЛКА НИЖЕ ↓' });
  }
  return b;
}
