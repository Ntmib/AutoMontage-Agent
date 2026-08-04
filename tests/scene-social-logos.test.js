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

test('social logos enter in two groups after the background is ready', () => {
  const { getLogoEntrance } = loadScenes();

  assert.equal(typeof getLogoEntrance, 'function');
  const visibleAt = (frame) => [0, 1, 2, 3]
    .filter((index) => getLogoEntrance(frame, index, 25).opacity > 0.95);

  assert.deepEqual(visibleAt(0), []);
  assert.deepEqual(visibleAt(25), [0, 1]);
  assert.deepEqual(visibleAt(70), [0, 1, 2, 3]);
});
