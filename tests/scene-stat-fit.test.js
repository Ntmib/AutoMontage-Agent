const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..');

function loadScenes() {
  const filename = path.join(ROOT, 'src/scenes/scenes.jsx');
  const output = buildSync({
    entryPoints: [filename],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'remotion', '@remotion/layout-utils'],
    logLevel: 'silent',
  }).outputFiles[0].text;
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(output, filename);
  return compiled.exports;
}

test('long money labels shrink enough to remain on one safe-zone line', () => {
  const { getStatFontSize } = loadScenes();

  assert.equal(typeof getStatFontSize, 'function');
  for (const text of ['20.000РУБ/МЕС', '240.000РУБ/ГОД']) {
    const size = getStatFontSize(text, 880, false);
    assert.ok(size >= 120);
    assert.ok(size * text.length * 0.44 <= 880);
  }
});
