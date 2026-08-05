const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..');

function loadJsxModule(relativePath) {
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
