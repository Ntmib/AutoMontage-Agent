const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

function loadDirector() {
  const filename = path.join(ROOT, 'src', 'SceneDirector.jsx');
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
  const remotion = {
    AbsoluteFill: 'div',
    Sequence: 'div',
    Audio: 'audio',
    OffthreadVideo: 'video',
    Img: 'img',
    staticFile: (value) => value,
    useCurrentFrame: () => 0,
    useVideoConfig: () => ({ fps: 25, durationInFrames: 250, width: 1920, height: 1080 }),
    interpolate: () => 0,
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
    return compiled.exports.SceneDirector;
  } finally {
    Module._load = originalLoad;
  }
}

test('draft preview watermark is deterministic and absent from final composition', () => {
  const SceneDirector = loadDirector();
  const draft = renderToStaticMarkup(React.createElement(SceneDirector, {
    draftPreview: true,
    scenes: [],
  }));
  const final = renderToStaticMarkup(React.createElement(SceneDirector, {
    draftPreview: false,
    scenes: [],
  }));

  assert.match(draft, /data-draft-preview-watermark="true"/);
  assert.match(draft, />ЧЕРНОВИК</);
  assert.match(draft, /font-family:Arial, sans-serif/);
  assert.doesNotMatch(final, /ЧЕРНОВИК|data-draft-preview-watermark/);
});
