const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_EQUIVALENCE_THRESHOLD,
  applyTextOnlyBenchmarkChange,
  benchmarkFixture,
  benchmarkRenderCycle,
  buildFrameComparisonArgs,
  parseSsimScore,
  verifyPreviewFinalEquivalence,
} = require('../scripts/benchmark-preview');

test('default image tolerance covers measured half-scale rasterization without hiding layout drift', () => {
  assert.equal(DEFAULT_EQUIVALENCE_THRESHOLD, 0.965);
  assert.equal(0.9680 >= DEFAULT_EQUIVALENCE_THRESHOLD, true);
  assert.equal(0.8450 >= DEFAULT_EQUIVALENCE_THRESHOLD, false);
});

test('preview/final frame comparison rescales preview and masks only documented watermark bounds', () => {
  const args = buildFrameComparisonArgs({
    previewPath: '/tmp/preview.mp4',
    finalPath: '/tmp/final.mp4',
    atSec: 12.5,
    width: 1920,
    height: 1080,
  });

  assert.deepEqual(args.slice(0, 8), [
    '-v', 'info', '-ss', '12.5', '-i', '/tmp/preview.mp4', '-ss', '12.5',
  ]);
  assert.match(args[args.indexOf('-filter_complex') + 1], /scale=1920:1080:flags=lanczos/);
  assert.match(args[args.indexOf('-filter_complex') + 1], /drawbox=x=1344:y=0:w=576:h=173/);
  assert.equal(args.at(-1), '-');
});

test('equivalence rejects a control frame whose layout score falls below tolerance', () => {
  const outputs = [
    { stderr: 'SSIM Y:0.999 U:0.999 V:0.999 All:0.9989 (29.6)' },
    { stderr: 'SSIM Y:0.820 U:0.910 V:0.900 All:0.8450 (8.1)' },
  ];
  assert.throws(() => verifyPreviewFinalEquivalence({
    previewPath: '/tmp/preview.mp4',
    finalPath: '/tmp/final.mp4',
    width: 1080,
    height: 1920,
    controlFramesSec: [2, 8],
    threshold: 0.97,
  }, {
    captureToolResultImpl: () => outputs.shift(),
  }), /0\.8450.*0\.9700/);
});

test('equivalence accepts all control frames above the documented image tolerance', () => {
  const result = verifyPreviewFinalEquivalence({
    previewPath: '/tmp/preview.mp4',
    finalPath: '/tmp/final.mp4',
    width: 1920,
    height: 1080,
    controlFramesSec: [1, 10, 20],
    threshold: 0.97,
  }, {
    captureToolResultImpl: () => ({ stderr: 'SSIM All:0.9823 (17.5)' }),
  });
  assert.deepEqual(result.scores, [0.9823, 0.9823, 0.9823]);
  assert.equal(result.minimumScore, 0.9823);
  assert.equal(parseSsimScore('SSIM All:0.991234 (20.4)'), 0.991234);
});

test('benchmark records cold, warm and final wall time with preview/final ratio', () => {
  let clock = 0;
  const phases = [];
  const result = benchmarkFixture({ fixture: 'horizontal-60s' }, {
    nowImpl: () => clock,
    renderImpl: (kind, cycle) => {
      phases.push([kind, cycle]);
      clock += kind === 'preview' ? (cycle === 'cold' ? 4200 : 3100) : 8200;
    },
  });

  assert.deepEqual(phases, [
    ['preview', 'cold'],
    ['preview', 'warm'],
    ['final', 'final'],
  ]);
  assert.deepEqual(result, {
    fixture: 'horizontal-60s',
    previewColdMs: 4200,
    previewWarmMs: 3100,
    finalMs: 8200,
    previewToFinalRatio: 0.378,
  });
});

test('warm benchmark changes only scene text and leaves media and timing untouched', () => {
  const original = {
    faceSrc: 'source.mp4',
    audioSrc: 'source.mp4',
    durationInFrames: 1500,
    scenes: [{
      scene: 'broll', start: 0, end: 60, headOrange: 'ДО',
      brollMedia: { kind: 'video', src: 'assets/demo.mp4', trimStartSec: 2, audioMode: 'mute' },
    }],
  };
  const changed = applyTextOnlyBenchmarkChange(original);

  assert.equal(changed.scenes[0].headOrange, 'ДО · ПРАВКА');
  assert.deepEqual(changed.scenes[0].brollMedia, original.scenes[0].brollMedia);
  assert.deepEqual(
    { ...changed, scenes: [{ ...changed.scenes[0], headOrange: 'ДО' }] },
    original,
  );
  assert.equal(original.scenes[0].headOrange, 'ДО');
});

test('benchmark cycle times Remotion while still finishing the compared artifact', () => {
  const calls = [];
  let clock = 0;
  const cycle = benchmarkRenderCycle({
    fixture: 'vertical-60s',
    kind: 'preview',
    cycle: 'warm',
    propsPath: '/tmp/preview.json',
    publicDirectory: '/tmp/public',
    workDirectory: '/tmp/work',
  }, {
    resolvedRemotion: { command: '/node', argsPrefix: ['/remotion.js'] },
    nowImpl: () => clock,
    runToolImpl: (command, args, options) => {
      calls.push(['render', command, args, options]);
      clock += 1200;
    },
    runNodeToolImpl: (script, args, options) => {
      calls.push(['finish', script, args, options]);
      clock += 5000;
    },
  });

  assert.deepEqual(cycle, { output: '/tmp/work/preview-warm.mp4', renderMs: 1200 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'render');
  assert.match(calls[0][2].find((value) => value.endsWith('.mp4')), /preview-warm\.raw\.mp4$/);
  assert.equal(calls[1][0], 'finish');
  assert.deepEqual(calls[1][2].slice(-4), ['--hdrfix', 'auto', '--audio-advance-ms', '42.5']);
  assert.equal(calls[1][2][1], cycle.output);
});
