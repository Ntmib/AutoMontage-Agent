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

test('split gradient moves while bullet events stay evenly staggered', () => {
  const { getSplitGradient, getSplitBulletDelay } = loadScenes();

  assert.equal(typeof getSplitGradient, 'function');
  assert.equal(typeof getSplitBulletDelay, 'function');
  assert.deepEqual(getSplitGradient(0, 25), { x: 20, y: 72, angle: 115 });
  assert.deepEqual(getSplitGradient(50, 25), { x: 35, y: 61, angle: 107.5 });
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => getSplitBulletDelay(index, 25, 'animated-gradient')),
    [11, 48, 84, 120],
  );
  assert.equal(getSplitBulletDelay(0, 25, undefined, 0.08), 2);
});
