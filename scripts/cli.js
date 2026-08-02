#!/usr/bin/env node
// Глобальная команда `automontage` — работает из любой папки на Windows/macOS/Linux.
// Движок сам находит свой корень (__dirname), результат кладёт в папку пользователя.
//
//   automontage <видео> [опции build.js]   — смонтировать ролик
//   automontage demo                        — собрать демо из примера в репозитории
//   automontage --help                      — помощь
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);

function help() {
  console.log(`AutoMontage-Agent — автомонтаж видео.

Использование:
  automontage <видео.mp4> [опции]     смонтировать (результат — в текущей папке)
  automontage demo                    собрать демо-ролик из примера
  automontage --help                  эта справка

Частые опции:
  --theme craft|cyber   стиль оформления (по умолчанию craft)
  --scenario file.json  готовый монтажный лист
  --model turbo|small   модель распознавания речи
  --tighten             срезать паузы и слова-паразиты
  --beat                ритмичный зум под музыку
  --autopos             плашки автоматически мимо лица
  --reframe             перекадрировать в вертикаль по лицу
  --outdir <путь>       куда положить результат (по умолчанию текущая папка)

Требуется: Node.js, Python 3, ffmpeg (и Chromium для картинок-плашек).`);
}

if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { help(); process.exit(0); }

const buildJs = path.join(ROOT, 'scripts', 'build.js');

let forward;
if (argv[0] === 'demo') {
  const demoSrc = path.join(ROOT, 'public', 'source_h.mp4');
  if (!fs.existsSync(demoSrc)) {
    console.error('Демо-исходник не входит в репозиторий (личное видео не публикуется).');
    console.error('Запусти на своём видео: automontage <видео.mp4> --scenario src/scenario-preview-h.js');
    process.exit(1);
  }
  forward = [demoSrc, '--id', 'demo'];
} else {
  forward = argv.slice();
}

// результат — в текущую папку пользователя, если явно не задан --outdir
if (!forward.includes('--outdir')) forward.push('--outdir', process.cwd());

try {
  // build.js резолвит видео от своего process.cwd() → запускаем с cwd пользователя
  execFileSync(process.execPath, [buildJs, ...forward], { stdio: 'inherit', cwd: process.cwd() });
} catch (e) {
  process.exit(e.status || 1);
}
