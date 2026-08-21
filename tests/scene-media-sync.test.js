const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const {
  Internals, Sequence: InstalledSequence, interpolate: installedInterpolate,
} = require('remotion');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..');

function renderInstalledSequence({ frame, sequenceProps }) {
  const composition = {
    id: 'premount-test',
    durationInFrames: 600,
    fps: 25,
    width: 1080,
    height: 1920,
    defaultProps: {},
    component: () => null,
  };
  const manager = {
    compositions: [composition],
    folders: [],
    currentCompositionMetadata: null,
    canvasContent: { type: 'composition', compositionId: composition.id },
  };
  const timeline = {
    frame: { [composition.id]: frame },
    playing: false,
    imperativePlaying: { current: false },
    audioAndVideoTags: { current: [] },
  };
  const environment = {
    isStudio: false,
    isRendering: false,
    isPlayer: true,
    isReadOnlyStudio: false,
    isClientSideRendering: false,
  };
  let element = React.createElement(
    InstalledSequence,
    sequenceProps,
    React.createElement('span', { 'data-scene-mounted': 'yes' }, 'scene'),
  );
  element = React.createElement(Internals.RemotionEnvironmentContext.Provider, { value: environment }, element);
  element = React.createElement(Internals.TimelineContext.Provider, { value: timeline }, element);
  element = React.createElement(Internals.AbsoluteTimeContext.Provider, { value: timeline }, element);
  element = React.createElement(Internals.CanUseRemotionHooks.Provider, { value: true }, element);
  element = React.createElement(Internals.CompositionManager.Provider, { value: manager }, element);
  return renderToStaticMarkup(element);
}

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

  const runtimeProps = {
    from: sequence.props.from,
    durationInFrames: sequence.props.durationInFrames,
    premountFor: sequence.props.premountFor,
    layout: sequence.props.layout,
  };
  const beforeWindow = renderInstalledSequence({
    frame: timing.from - Math.round(fps) - 1,
    sequenceProps: runtimeProps,
  });
  const premounted = renderInstalledSequence({
    frame: timing.from - 1,
    sequenceProps: runtimeProps,
  });
  const visible = renderInstalledSequence({ frame: timing.from, sequenceProps: runtimeProps });
  const after = renderInstalledSequence({
    frame: timing.from + timing.durationInFrames,
    sequenceProps: runtimeProps,
  });

  assert.doesNotMatch(beforeWindow, /data-scene-mounted/);
  assert.match(premounted, /data-scene-mounted="yes"/);
  assert.match(premounted, /opacity:0/);
  assert.match(premounted, /pointer-events:none/);
  assert.match(visible, /data-scene-mounted="yes"/);
  assert.doesNotMatch(visible, /opacity:0/);
  assert.match(visible, /position:absolute/);
  assert.doesNotMatch(after, /data-scene-mounted/);
});

test('bundled scene layer stays fully opaque for short and normal scenes', () => {
  const fps = 25;
  let currentFrame = 0;
  const remotion = {
    AbsoluteFill: 'div',
    Sequence: 'Sequence',
    Audio: 'Audio',
    OffthreadVideo: 'OffthreadVideo',
    Img: 'Img',
    staticFile: (src) => `static://${src}`,
    useCurrentFrame: () => currentFrame,
    useVideoConfig: () => ({ fps, durationInFrames: 600 }),
    interpolate: installedInterpolate,
  };
  const { SceneDirector } = loadJsxModule('src/SceneDirector.jsx', remotion);

  for (const durationInFrames of [1, 5, 14, 15, 60]) {
    const director = SceneDirector({
      scenes: [{
        scene: 'text-only',
        start: 0,
        end: durationInFrames / fps,
        quoteCream: 'short',
        quoteOrange: 'scene',
      }],
    });
    const sequence = director.props.children.props.children.flat(Infinity).filter(Boolean)
      .find((child) => child.type === 'Sequence');
    const fade = sequence.props.children;
    const opacities = [];

    for (currentFrame = 0; currentFrame < durationInFrames; currentFrame += 1) {
      const rendered = fade.type(fade.props);
      const opacity = rendered.props.style.opacity;
      const html = renderToStaticMarkup(React.cloneElement(
        rendered,
        null,
        React.createElement('span', { 'data-fade-child': 'yes' }),
      ));
      assert.match(html, /data-fade-child="yes"/);
      assert.ok(Number.isFinite(opacity));
      assert.ok(opacity >= 0 && opacity <= 1);
      opacities.push(opacity);
    }
    assert.deepEqual(opacities, Array(durationInFrames).fill(1));
  }
});

test('director keeps the first visible frame opaque at a hard scene cut', () => {
  const fps = 25;
  let currentFrame = 0;
  const remotion = {
    AbsoluteFill: 'div',
    Sequence: 'Sequence',
    Audio: 'Audio',
    OffthreadVideo: 'OffthreadVideo',
    Img: 'Img',
    staticFile: (src) => `static://${src}`,
    useCurrentFrame: () => currentFrame,
    useVideoConfig: () => ({ fps, durationInFrames: 600 }),
    interpolate: installedInterpolate,
  };
  const { SceneDirector } = loadJsxModule('src/SceneDirector.jsx', remotion);
  const director = SceneDirector({
    scenes: [{
      scene: 'text-only',
      start: 1,
      end: 2,
      quoteCream: 'no',
      quoteOrange: 'flash',
    }],
  });
  const sequence = director.props.children.props.children.flat(Infinity).filter(Boolean)
    .find((child) => child.type === 'Sequence');
  const transition = sequence.props.children;

  currentFrame = 0;
  const firstVisibleFrame = transition.type(transition.props);

  assert.equal(firstVisibleFrame.props.style.opacity, 1);
});
