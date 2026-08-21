const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..');

function loadBrollMedia(fps = 25) {
  const filename = path.join(ROOT, 'src/scenes/BrollMedia.jsx');
  const output = buildSync({
    entryPoints: [filename],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'remotion'],
    logLevel: 'silent',
  }).outputFiles[0].text;
  const remotion = {
    Img: 'Img',
    OffthreadVideo: 'OffthreadVideo',
    staticFile: (src) => `static://${src}`,
    useVideoConfig: () => ({ fps }),
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'remotion') return remotion;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const compiled = new Module(filename, module);
    compiled.filename = filename;
    compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(output, filename);
    return compiled.exports;
  } finally {
    Module._load = originalLoad;
  }
}

const closeTo = (actual, expected, tolerance = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

test('b-roll envelope follows the exact 120ms frame formula at supported fps values', () => {
  for (const fps of [24, 25, 29.97, 30]) {
    const { MIX_GAIN, fadeFramesForFps, brollEnvelope } = loadBrollMedia(fps);
    const fade = Math.max(1, Math.round(0.12 * fps));
    const durationInFrames = fade * 2 + 5;
    const expected = (localFrame) => Math.min(
      Math.min(1, Math.max(0, localFrame / fade)),
      Math.min(1, Math.max(0, (durationInFrames - 1 - localFrame) / fade)),
    );

    closeTo(MIX_GAIN, 10 ** (-18 / 20));
    assert.equal(fadeFramesForFps(fps), fade);
    for (const localFrame of [0, 1, fade, Math.floor(durationInFrames / 2), durationInFrames - 1 - fade, durationInFrames - 2, durationInFrames - 1]) {
      closeTo(brollEnvelope({ localFrame, durationInFrames, fps }), expected(localFrame));
    }
    assert.equal(brollEnvelope({ localFrame: 0, durationInFrames, fps }), 0);
    assert.equal(brollEnvelope({ localFrame: durationInFrames - 1, durationInFrames, fps }), 0);
  }
});

test('sub-240ms scenes form a bounded triangle without a midpoint jump', () => {
  for (const fps of [24, 25, 29.97, 30]) {
    const { brollEnvelope, fadeFramesForFps } = loadBrollMedia(fps);
    const durationInFrames = Math.max(2, Math.floor(0.2 * fps));
    const values = Array.from({ length: durationInFrames }, (_, localFrame) => (
      brollEnvelope({ localFrame, durationInFrames, fps })
    ));
    const fade = fadeFramesForFps(fps);

    assert.equal(values[0], 0);
    assert.equal(values.at(-1), 0);
    assert.ok(Math.max(...values) <= 1);
    for (let index = 1; index < values.length; index += 1) {
      assert.ok(Math.abs(values[index] - values[index - 1]) <= (1 / fade) + 1e-12);
    }
  }
});

test('mute, mix and replace use deterministic clip and source volumes', () => {
  const fps = 25;
  const durationInFrames = 25;
  const {
    MIX_GAIN, brollEnvelope, brollClipVolume, sourceVolumeForFrame,
  } = loadBrollMedia(fps);
  const localFrame = 3;
  const envelope = brollEnvelope({ localFrame, durationInFrames, fps });

  assert.equal(brollClipVolume({ mode: 'mute', localFrame, durationInFrames, fps }), 0);
  closeTo(brollClipVolume({ mode: 'mix', localFrame, durationInFrames, fps }), MIX_GAIN * envelope);
  closeTo(brollClipVolume({ mode: 'replace', localFrame, durationInFrames, fps }), envelope);

  for (const audioMode of ['mute', 'mix']) {
    assert.equal(sourceVolumeForFrame({
      frame: 13,
      scenes: [{ from: 10, durationInFrames, audioMode }],
      fps,
    }), 1);
  }
  closeTo(sourceVolumeForFrame({
    frame: 10 + localFrame,
    scenes: [{ from: 10, durationInFrames, audioMode: 'replace' }],
    fps,
  }), 1 - envelope);
});

test('adjacent replace scenes never combine envelopes at their boundary', () => {
  const fps = 30;
  const scenes = [
    { from: 10, durationInFrames: 12, audioMode: 'replace' },
    { from: 22, durationInFrames: 12, audioMode: 'replace' },
  ];
  const { brollEnvelope, sourceVolumeForFrame } = loadBrollMedia(fps);

  for (let frame = 9; frame <= 34; frame += 1) {
    const active = scenes.find((scene) => frame >= scene.from && frame < scene.from + scene.durationInFrames);
    const expected = active
      ? 1 - brollEnvelope({ localFrame: frame - active.from, durationInFrames: active.durationInFrames, fps })
      : 1;
    closeTo(sourceVolumeForFrame({ frame, scenes, fps }), expected);
  }
  assert.equal(sourceVolumeForFrame({ frame: 21, scenes, fps }), 1);
  assert.equal(sourceVolumeForFrame({ frame: 22, scenes, fps }), 1);
});

test('legacy and structured images render through Img and staticFile with exact fit', () => {
  const { BrollMedia } = loadBrollMedia(25);
  const legacy = BrollMedia({ legacySrc: 'broll/legacy.png', durationInFrames: 50 });
  const image = BrollMedia({
    media: { kind: 'image', src: 'render-assets/still.webp', fit: 'contain' },
    durationInFrames: 50,
  });

  assert.equal(legacy.type, 'Img');
  assert.equal(legacy.props.src, 'static://broll/legacy.png');
  assert.equal(legacy.props.style.objectFit, 'cover');
  assert.equal(image.type, 'Img');
  assert.equal(image.props.src, 'static://render-assets/still.webp');
  assert.equal(image.props.style.objectFit, 'contain');
});

test('video uses OffthreadVideo, frame trim, exact fit and deterministic audio callbacks', () => {
  const fps = 29.97;
  const durationInFrames = 90;
  const { BrollMedia, brollClipVolume } = loadBrollMedia(fps);
  const makeVideo = (audioMode, fit = 'cover') => BrollMedia({
    media: {
      kind: 'video', src: 'render-assets/clip.mp4', trimStartSec: 1.25, fit, audioMode,
    },
    durationInFrames,
  });

  const muted = makeVideo('mute', 'contain');
  assert.equal(muted.type, 'OffthreadVideo');
  assert.equal(muted.props.src, 'static://render-assets/clip.mp4');
  assert.equal(muted.props.trimBefore, Math.round(1.25 * fps));
  assert.equal(muted.props.style.objectFit, 'contain');
  assert.equal(muted.props.muted, true);
  assert.equal(muted.props.volume, undefined);

  for (const audioMode of ['mix', 'replace']) {
    const video = makeVideo(audioMode);
    assert.equal(video.props.style.objectFit, 'cover');
    assert.notEqual(video.props.muted, true);
    assert.equal(typeof video.props.volume, 'function');
    for (const localFrame of [0, 1, 12, durationInFrames - 1]) {
      closeTo(video.props.volume(localFrame), brollClipVolume({
        mode: audioMode, localFrame, durationInFrames, fps,
      }));
    }
  }
});
