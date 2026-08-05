const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('public demo does not depend on personal captured frames', () => {
  for (const relativePath of ['scripts/phone_frame.jpg', 'scripts/shot_frame.jpg']) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), false, `${relativePath} must not ship`);
  }

  for (const relativePath of ['scripts/iphone-mock.html', 'scripts/screenshot-mock.html']) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /(?:phone|shot)_frame\.jpg/);
    assert.doesNotMatch(source, /<img\b/i);
  }
});

test('generated captured frames stay ignored', () => {
  const gitignore = read('.gitignore');
  assert.match(gitignore, /^scripts\/\*_frame\.jpg$/m);
});

test('README describes the public demo as neutral and music-free', () => {
  const readme = read('README.md');
  const demoSection = readme.match(/## Демо\n([\s\S]*?)(?=\n## )/)?.[1] ?? '';
  const licenseSection = readme.match(/## Лицензия\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';

  assert.match(demoSection, /нейтральн/i);
  assert.match(demoSection, /без музыки/i);
  assert.doesNotMatch(demoSection, /говорящая голова|LiQWYD|NCS/i);
  assert.doesNotMatch(licenseSection, /Демо-ролик озвучен|LiQWYD|NCS/i);
});
