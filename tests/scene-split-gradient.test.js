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

test('fullscreen side overlay uses the negative space opposite the speaker', () => {
  const { getEndCenterProgress, getFullscreenOverlaySide, getSideOverlayStepDelay } = loadScenes();

  assert.equal(typeof getFullscreenOverlaySide, 'function');
  assert.equal(typeof getSideOverlayStepDelay, 'function');
  assert.equal(getFullscreenOverlaySide({ x: 0.68 }, 1920, 1080), 'left');
  assert.equal(getFullscreenOverlaySide({ x: 0.32 }, 1920, 1080), 'right');
  assert.equal(getFullscreenOverlaySide({ x: 0.68 }, 1080, 1920), 'bottom');
  assert.equal(getSideOverlayStepDelay(0, 25, [1.2, 4.6]), 30);
  assert.equal(getSideOverlayStepDelay(1, 25, [1.2, 4.6]), 115);
  assert.equal(getSideOverlayStepDelay(2, 25, [1.2, 4.6]), 40);
  assert.equal(getEndCenterProgress(74, 100, 25, true), 0);
  assert.equal(getEndCenterProgress(75, 100, 25, true), 0);
  assert.equal(getEndCenterProgress(87.5, 100, 25, true), 0.875);
  assert.equal(getEndCenterProgress(100, 100, 25, true), 1);
  assert.equal(getEndCenterProgress(100, 100, 25, false), 0);
});

test('b-roll speaker picture-in-picture can be disabled explicitly', () => {
  const { shouldShowBrollSpeakerPip } = loadScenes();

  assert.equal(typeof shouldShowBrollSpeakerPip, 'function');
  assert.equal(shouldShowBrollSpeakerPip('/video/source.mp4'), true);
  assert.equal(shouldShowBrollSpeakerPip('/video/source.mp4', false), false);
  assert.equal(shouldShowBrollSpeakerPip('', true), false);
});
