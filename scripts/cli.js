#!/usr/bin/env node
// Глобальная команда `automontage` – работает из любой папки на Windows/macOS/Linux.
// Движок сам находит свой корень (__dirname), результат кладёт в папку пользователя.
//
//   automontage <видео> [опции build.js]   – смонтировать ролик
//   automontage demo                        – собрать демо из примера в репозитории
//   automontage --help                      – помощь
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);

function help() {
  console.log(`AutoMontage-Agent – автомонтаж видео.

Использование:
  automontage <видео.mp4> [опции]     смонтировать (результат в текущей папке)
  automontage demo                    собрать демо-ролик из примера (без ключей и whisper)
  automontage doctor                  проверить окружение (что доустановить)
  automontage --help                  эта справка

Частые опции:
  --theme craft|cyber   стиль оформления (по умолчанию craft)
  --template lesson     создать черновик ТЗ из 7 готовых сцен и остановиться
  --aspect source       формат как у исходника (дефолт для lesson)
  --aspect vertical     вертикальный результат 1080x1920
  --aspect horizontal   горизонтальный результат 1920x1080
  --brief file.json     рендер утверждённого lesson-ТЗ через ReelScenes
  --title "ТЕМА"        заголовок для lesson
  --scenario file.json  готовый монтажный лист
  --no-transcribe       не транскрибировать (для монтажа по готовому --scenario)
  --model turbo|small   модель распознавания речи
  --tighten             срезать паузы и слова-паразиты (не вместе с lesson)
  --beat                ритмичный зум под музыку
  --autopos             плашки автоматически мимо лица
  --reframe             перекадрировать Dynamic в вертикаль по лицу
  --outdir <путь>       куда положить результат (по умолчанию текущая папка)

Сначала проверь окружение: automontage doctor
Требуется: Node.js (>=20), Python 3, ffmpeg (Chromium только для пересборки картинок).`);
}

if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { help(); process.exit(0); }

// проверка окружения: automontage doctor
if (argv[0] === 'doctor') {
  try { execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'doctor.js')], { stdio: 'inherit', cwd: ROOT }); }
  catch (e) { process.exit(e.status || 1); }
  process.exit(0);
}

const buildJs = path.join(ROOT, 'scripts', 'build.js');

let forward;
if (argv[0] === 'demo') {
  // демо из коробки: лёгкое тест-видео + готовый монтажный лист, без whisper и ключей
  const demoSrc = path.join(ROOT, 'examples', 'demo-source.mp4');
  const demoList = path.join(ROOT, 'examples', 'scenario-demo.json');
  if (!fs.existsSync(demoSrc) || !fs.existsSync(demoList)) {
    console.error('Демо-файлы не найдены (examples/demo-source.mp4 + examples/scenario-demo.json).');
    console.error('Смонтируй своё: automontage <видео.mp4>');
    process.exit(1);
  }
  forward = [demoSrc, '--scenario', demoList, '--no-transcribe', '--id', 'demo'];
} else {
  forward = argv.slice();
}

// результат – в текущую папку пользователя, если явно не задан --outdir
if (!forward.includes('--outdir')) forward.push('--outdir', process.cwd());

try {
  // build.js резолвит видео от своего process.cwd() → запускаем с cwd пользователя
  execFileSync(process.execPath, [buildJs, ...forward], { stdio: 'inherit', cwd: process.cwd() });
} catch (e) {
  process.exit(e.status || 1);
}
