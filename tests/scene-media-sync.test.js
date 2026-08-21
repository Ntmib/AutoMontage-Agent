const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..');

function loadJsxModule(relativePath, remotionStub = null) {
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

test('scene timing keeps face video on the same global frame as audio', () => {
  const director = loadJsxModule('src/SceneDirector.jsx');

  assert.equal(typeof director.getSceneTiming, 'function');
  assert.deepEqual(director.getSceneTiming({ start: 10.12, end: 17 }, 25), {
    from: 253,
    durationInFrames: 172,
    sourceStartFrame: 253,
  });
});

test('face video trims to the global start frame of its scene', () => {
  const { FaceLayer } = loadJsxModule('src/scenes/parts.jsx');
  const layer = FaceLayer({
    faceSrc: 'source.mp4',
    facePos: { x: 0.5, y: 0.35 },
    sourceStartFrame: 253,
  });
  const video = layer.props.children;

  assert.equal(video.props.trimBefore, 253);
});

test('director premounts scenes without changing visible timing or global face trim', () => {
  const fps = 29.97;
  const remotion = {
    AbsoluteFill: 'AbsoluteFill',
    Sequence: 'Sequence',
    Audio: 'Audio',
    OffthreadVideo: 'OffthreadVideo',
    Img: 'Img',
    staticFile: (src) => `static://${src}`,
    useCurrentFrame: () => 0,
    useVideoConfig: () => ({ fps, durationInFrames: 600 }),
    interpolate: () => 1,
  };
  const { SceneDirector, getSceneTiming } = loadJsxModule('src/SceneDirector.jsx', remotion);
  const scene = { scene: 'fullscreen', start: 10.12, end: 17, caption: 'test' };
  const director = SceneDirector({ scenes: [scene], faceSrc: 'source.mp4' });
  const fill = director.props.children;
  const children = fill.props.children.flat(Infinity).filter(Boolean);
  const sequence = children.find((child) => child.type === 'Sequence');
  const timing = getSceneTiming(scene, fps);

  assert.equal(sequence.props.from, timing.from);
  assert.equal(sequence.props.durationInFrames, timing.durationInFrames);
  assert.equal(sequence.props.premountFor, Math.round(fps));
  const fade = sequence.props.children;
  const sceneElement = fade.props.children;
  assert.equal(sceneElement.props.sourceStartFrame, timing.sourceStartFrame);
  assert.equal(sceneElement.props.durationInFrames, timing.durationInFrames);
});
