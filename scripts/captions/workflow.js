const fs = require('node:fs');
const path = require('node:path');

const MAX_WORDS = 4;
const MAX_DURATION = 1.6;
const MAX_GAP = 0.45;

function groupTranscript(segments) {
  const words = [];
  for (const segment of segments) {
    for (const word of segment.words || []) {
      const text = String(word.w || '').trim();
      if (text) words.push({ w: text, s: word.s, e: word.e });
    }
  }

  const groups = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    groups.push({
      start: +current[0].s.toFixed(2),
      end: +current[current.length - 1].e.toFixed(2),
      words: current.map((word) => ({
        w: word.w,
        s: +word.s.toFixed(2),
        e: +word.e.toFixed(2),
      })),
    });
    current = [];
  };

  for (const word of words) {
    if (current.length) {
      const duration = word.e - current[0].s;
      const gap = word.s - current[current.length - 1].e;
      if (current.length >= MAX_WORDS || duration > MAX_DURATION || gap > MAX_GAP) flush();
    }
    current.push(word);
  }
  flush();
  return { groups, wordsCount: words.length };
}

function renderCaptionsModule(groups) {
  return '// АВТОГЕНЕРАЦИЯ (scripts/build-captions.js). Субтитры-группы со словными таймкодами.\n'
    + `export const CAPTIONS = ${JSON.stringify(groups, null, 1)};\n`;
}

function buildCaptions({ inputPath, outputPath }) {
  const segments = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const result = groupTranscript(segments);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, renderCaptionsModule(result.groups));
  return result;
}

module.exports = {
  buildCaptions,
  groupTranscript,
  renderCaptionsModule,
};
