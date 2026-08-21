const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..');

function loadDirector(remotionStub = null) {
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
  const originalLoad = Module._load;
  if (remotionStub) {
    Module._load = function load(request, parent, isMain) {
      if (request === 'remotion') return remotionStub;
      return originalLoad.call(this, request, parent, isMain);
    };
  }
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

test('one global source Audio stays at frame zero and ducks only for replace b-roll', () => {
  const fps = 25;
  const remotion = {
    AbsoluteFill: 'AbsoluteFill',
    Sequence: 'Sequence',
    Audio: 'Audio',
    OffthreadVideo: 'OffthreadVideo',
    Img: 'Img',
    staticFile: (src) => `static://${src}`,
    useCurrentFrame: () => 0,
    useVideoConfig: () => ({ fps, durationInFrames: 300 }),
    interpolate: () => 1,
  };
  const { SceneDirector } = loadDirector(remotion);
  const director = SceneDirector({
    audioSrc: 'source.wav',
    scenes: [{
      scene: 'broll',
      start: 1,
      end: 2,
      brollMedia: {
        kind: 'video', src: 'render-assets/clip.mp4', trimStartSec: 0,
        fit: 'cover', audioMode: 'replace',
      },
    }],
  });
  const children = director.props.children.props.children.flat(Infinity).filter(Boolean);
  const audio = children.filter((child) => child.type === 'Audio');

  assert.equal(audio.length, 1);
  assert.equal(audio[0].props.src, 'static://source.wav');
  assert.equal(typeof audio[0].props.volume, 'function');
  assert.equal(audio[0].props.volume(24), 1);
  assert.equal(audio[0].props.volume(25), 1);
  assert.equal(audio[0].props.volume(28), 0);
  assert.equal(audio[0].props.volume(49), 1);
  assert.equal(audio[0].props.volume(50), 1);
});
