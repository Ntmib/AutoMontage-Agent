const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const { OFFICIAL_SCENES, validateLessonBrief } = require('../scripts/lesson/brief');

const ROOT = path.join(__dirname, '..');

function loadJsx(relativePath) {
  const filename = path.join(ROOT, relativePath);
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

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

test('horizontal and vertical golden drafts validate without an eighth automatic scene', () => {
  const horizontal = readJson('examples/lesson-horizontal-workflow-draft.json');
  const vertical = readJson('examples/lesson-vertical-workflow-draft.json');

  assert.deepEqual(validateLessonBrief(horizontal), { ok: true, errors: [] });
  assert.deepEqual(validateLessonBrief(vertical), { ok: true, errors: [] });
  assert.deepEqual(OFFICIAL_SCENES, [
    'fullscreen', 'split', 'bottom-diagram', 'blur-overlay', 'text-only', 'stat', 'broll',
  ]);
  assert.equal(horizontal.output.aspect, 'horizontal');
  assert.equal(vertical.output.aspect, 'vertical');
});

test('golden drafts exercise reusable negative-space timing b-roll and ending capabilities', () => {
  const drafts = [
    readJson('examples/lesson-horizontal-workflow-draft.json'),
    readJson('examples/lesson-vertical-workflow-draft.json'),
  ];
  const scenes = drafts.flatMap((draft) => draft.scenes);
  const overlay = scenes.find((scene) => scene.variant === 'side-overlay');
  const screencast = scenes.find((scene) => scene.brollMedia?.kind === 'video');
  const image = scenes.find((scene) => scene.brollMedia?.kind === 'image');
  const ending = scenes.find((scene) => scene.centerOnFade === true);

  assert.deepEqual(overlay.stepStartsSec, [0.8, 2.4, 4.4]);
  assert.equal(screencast.showSpeakerPip, false);
  assert.equal(screencast.brollMedia.audioMode, 'mute');
  assert.equal(screencast.brollMedia.trimStartSec, 1.2);
  assert.equal(screencast.brollMedia.fit, 'contain');
  assert.equal(image.brollMedia.fit, 'cover');
  assert.equal(ending.end - ending.start >= 1, true);
});

test('scene helpers consume every timing and media capability used by the golden drafts', () => {
  const scenes = loadJsx('src/scenes/scenes.jsx');
  const media = loadJsx('src/scenes/BrollMedia.jsx');

  assert.equal(scenes.getFullscreenOverlaySide({ x: 0.7 }, 1920, 1080), 'left');
  assert.equal(scenes.getSideOverlayStepDelay(1, 25, [0.8, 2.4, 4.4]), 60);
  assert.equal(scenes.getEndCenterProgress(100, 100, 25, true), 1);
  assert.equal(scenes.shouldShowBrollSpeakerPip('source.mp4', false), false);
  assert.deepEqual(media.brollMediaPresentation({
    kind: 'video', trimStartSec: 1.2, fit: 'contain', audioMode: 'mute',
  }, 25), {
    objectFit: 'contain',
    trimBefore: 30,
    muted: true,
  });
});

test('public scene catalog names the exact reusable properties exercised by fixtures', () => {
  const catalog = fs.readFileSync(path.join(ROOT, 'docs', 'SCENE-CATALOG.md'), 'utf8');
  for (const property of [
    'side-overlay', 'stepStartsSec', 'showSpeakerPip', 'centerOnFade',
    'brollMedia.fit', 'brollMedia.trimStartSec', 'brollMedia.audioMode',
  ]) {
    assert.match(catalog, new RegExp(property.replace('.', '\\.'), 'u'), property);
  }
});
