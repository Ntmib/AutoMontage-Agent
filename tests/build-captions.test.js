const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildCaptions } = require('../scripts/captions/workflow');

test('caption builder reads and writes the paths supplied by one project', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-captions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'words.json');
  const outputPath = path.join(dir, 'captions.js');
  fs.writeFileSync(inputPath, JSON.stringify([{
    words: [
      { w: 'Один', s: 0, e: 0.2 },
      { w: 'ролик', s: 0.3, e: 0.7 },
    ],
  }]));

  const result = buildCaptions({ inputPath, outputPath });

  assert.equal(result.groups.length, 1);
  assert.equal(result.wordsCount, 2);
  assert.match(fs.readFileSync(outputPath, 'utf8'), /export const CAPTIONS/);
});
