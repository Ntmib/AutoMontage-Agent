// Конвертер: transcript.json (faster-whisper words) → captions.js
// Группировка: до 4 слов, до 1.6с, разрыв при паузе > 0.45с.
const path = require('path');
const { buildCaptions } = require('./captions/workflow');

const args = process.argv.slice(2);
const inputPath = path.resolve(
  process.cwd(),
  args[0] || path.join(__dirname, '../src/data/transcript.json'),
);
const outputPath = path.resolve(
  process.cwd(),
  args[1] || path.join(__dirname, '../src/data/captions.js'),
);

const result = buildCaptions({ inputPath, outputPath });
console.log(`групп: ${result.groups.length}, слов: ${result.wordsCount}`);
console.log('пример:', JSON.stringify(result.groups[0]));
