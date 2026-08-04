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

test('CTA keyword makes a gentle frame-driven bounce', () => {
  const { getKeywordMotion } = loadScenes();

  assert.equal(typeof getKeywordMotion, 'function');
  assert.deepEqual(getKeywordMotion(0, 25), { y: 0, scale: 1, rotate: -1 });
  assert.deepEqual(getKeywordMotion(15, 25), { y: -10, scale: 1.05, rotate: 1 });
  assert.deepEqual(getKeywordMotion(30, 25), { y: 0, scale: 1, rotate: -1 });
});
