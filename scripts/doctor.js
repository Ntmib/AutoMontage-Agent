#!/usr/bin/env node
// doctor.js: проверка окружения перед первым монтажом.
// Говорит новичку заранее, чего не хватает, вместо падения в середине пайплайна.
//
//   node scripts/doctor.js        (или: automontage doctor)
//
// Проверяет: Node, Python 3, ffmpeg/ffprobe, faster-whisper, шрифты, node_modules,
// Chromium (нужен только для пересборки картинок-плашек, поэтому WARN, не FAIL).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, python } = require('./env');

let fails = 0, warns = 0;
const ok   = (m) => console.log(`  \x1b[32mOK\x1b[0m   ${m}`);
const fail = (m) => { console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); fails++; };
const warn = (m) => { console.log(`  \x1b[33mWARN\x1b[0m ${m}`); warns++; };

// пробуем запустить команду и вернуть первую строку вывода (или null)
function tryRun(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status !== 0 && !r.stdout && !r.stderr) return null;
    return `${r.stdout || ''}${r.stderr || ''}`.split('\n')[0].trim();
  } catch (_) { return null; }
}

console.log('\nAutoMontage-Agent :: проверка окружения\n');

// 1. Node
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 20) ok(`Node.js ${process.version}`);
else if (nodeMajor >= 18) warn(`Node.js ${process.version} (рекомендуется >=20 для связки Remotion 4 + React 19)`);
else fail(`Node.js ${process.version} слишком старый, нужен >=20`);

// 2. Python 3
try {
  const py = python();
  const v = tryRun(py, ['--version']) || py;
  ok(`Python 3 (${v}), интерпретатор: ${py}`);
} catch (e) {
  fail('Python 3 не найден. Установи Python 3 и добавь в PATH (нужен для транскрипции и перекадрирования)');
}

// 3. ffmpeg + ffprobe
const ff = tryRun('ffmpeg', ['-version']);
if (ff) ok(ff); else fail('ffmpeg не найден. Установи ffmpeg (обязателен: извлечение аудио, финальная сборка)');
const fp = tryRun('ffprobe', ['-version']);
if (fp) ok(fp); else fail('ffprobe не найден (обычно ставится вместе с ffmpeg)');

// 4. faster-whisper (только если Python есть)
try {
  const py = python();
  const r = spawnSync(py, ['-c', 'import faster_whisper; print(faster_whisper.__version__)'], { encoding: 'utf8' });
  if (r.status === 0) ok(`faster-whisper ${(r.stdout || '').trim()} (транскрипция речи)`);
  else warn('faster-whisper не установлен: `pip install -r requirements.txt`. Нужен для распознавания речи (для монтажа по готовому --scenario с --no-transcribe не требуется)');
} catch (_) { /* python уже отмечен как FAIL выше */ }

// 5. node_modules (Remotion)
if (fs.existsSync(path.join(ROOT, 'node_modules', 'remotion'))) ok('node_modules установлены (Remotion на месте)');
else fail('node_modules нет. Запусти `npm install` в папке движка');

// 6. Шрифты (инлайн base64, рендер работает из коробки)
if (fs.existsSync(path.join(ROOT, 'src', 'fonts-data.js'))) ok('шрифты встроены (src/fonts-data.js), качать вручную не нужно');
else warn('src/fonts-data.js отсутствует: рендер может использовать системные шрифты');

// 7. Chromium (нужен только для пересборки картинок-плашек через Playwright)
const hasChromium = tryRun('chromium', ['--version']) || tryRun('chromium-browser', ['--version'])
  || tryRun('google-chrome', ['--version']);
if (hasChromium) ok(`Chromium (${hasChromium}), для пересборки картинок-плашек`);
else warn('Chromium не найден. Нужен только если пересобираешь картинки-плашки (shot-*.js). Для базового монтажа не требуется');

// итог
console.log('');
if (fails) { console.log(`\x1b[31m${fails} критичн. проблем(ы)\x1b[0m${warns ? `, ${warns} предупрежд.` : ''}. Монтаж не запустится, пока не устранишь FAIL.\n`); process.exit(1); }
if (warns) { console.log(`\x1b[33mВсё основное на месте, ${warns} предупрежд.\x1b[0m Базовый монтаж заработает.\n`); process.exit(0); }
console.log('\x1b[32mВсё готово. Можно монтировать.\x1b[0m\n');
