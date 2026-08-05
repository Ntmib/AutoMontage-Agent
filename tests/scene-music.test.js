const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..');

function loadDirector() {
  const filename = path.join(ROOT, 'src/SceneDirector.jsx');
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

test('music gain uses decibels with deterministic edge fades', () => {
  const { getMusicVolume } = loadDirector();
  const options = {
    durationInFrames: 100,
    fps: 25,
    gainDb: -17,
    fadeInSec: 0.4,
    fadeOutSec: 0.8,
  };

  assert.equal(typeof getMusicVolume, 'function');
  assert.equal(getMusicVolume(0, options), 0);
  assert.ok(Math.abs(getMusicVolume(10, options) - 0.14125375446227545) < 1e-12);
  assert.ok(Math.abs(getMusicVolume(79, options) - 0.14125375446227545) < 1e-12);
  assert.equal(getMusicVolume(99, options), 0);
});

test('music can start from its rhythmic section and play slightly faster', () => {
  const { getMusicPlaybackProps } = loadDirector();

  assert.deepEqual(getMusicPlaybackProps({
    fps: 25,
    trimBeforeFrames: 550,
    playbackRate: 1.06,
  }), {
    trimBefore: 550,
    playbackRate: 1.06,
  });
});
