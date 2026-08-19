const test = require('node:test');
const assert = require('node:assert/strict');

const {
  frameRateFromFps,
  secondsToFrame,
  frameToSeconds,
} = require('../scripts/review/media-time');
const { auditBriefTiming } = require('../scripts/review/timing-audit');

function fixtureBrief({ fps, scenes }) {
  return {
    output: { fps },
    scenes,
  };
}

test('represents standard NTSC rates without float drift', () => {
  assert.deepEqual(frameRateFromFps(24000 / 1001), { numerator: 24000, denominator: 1001 });
  assert.deepEqual(frameRateFromFps(30000 / 1001), { numerator: 30000, denominator: 1001 });
  assert.deepEqual(frameRateFromFps(60000 / 1001), { numerator: 60000, denominator: 1001 });
  assert.equal(secondsToFrame(10.01, { numerator: 30000, denominator: 1001 }), 300);
  assert.equal(frameToSeconds(300, { numerator: 30000, denominator: 1001 }), 10.01);
});

test('represents an integral frame rate as a reduced ratio', () => {
  assert.deepEqual(frameRateFromFps(25), { numerator: 25, denominator: 1 });
});

test('converts seconds with the requested frame rounding mode', () => {
  const rate = { numerator: 25, denominator: 1 };
  assert.equal(secondsToFrame(1.013, rate, 'floor'), 25);
  assert.equal(secondsToFrame(1.013, rate, 'round'), 25);
  assert.equal(secondsToFrame(1.013, rate, 'ceil'), 26);
});

test('rejects non-finite or negative time values', () => {
  const rate = { numerator: 25, denominator: 1 };
  for (const seconds of [-0.001, NaN, Infinity, -Infinity]) {
    assert.throws(() => secondsToFrame(seconds, rate), /seconds/i);
  }
  for (const frame of [-1, NaN, Infinity, -Infinity]) {
    assert.throws(() => frameToSeconds(frame, rate), /frame/i);
  }
  for (const fps of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => frameRateFromFps(fps), /fps/i);
  }
});

test('rejects invalid frame-rate ratios and unknown rounding modes', () => {
  for (const rate of [
    null,
    {},
    { numerator: 0, denominator: 1 },
    { numerator: -25, denominator: 1 },
    { numerator: NaN, denominator: 1 },
    { numerator: 25, denominator: 0 },
    { numerator: 25, denominator: -1 },
    { numerator: 25, denominator: Infinity },
  ]) {
    assert.throws(() => secondsToFrame(1, rate), /rate/i);
    assert.throws(() => frameToSeconds(1, rate), /rate/i);
  }
  assert.throws(
    () => secondsToFrame(1, { numerator: 25, denominator: 1 }, 'nearest'),
    /rounding mode/i,
  );
});

test('reports but does not rewrite off-frame scene boundaries', () => {
  const brief = fixtureBrief({ fps: 25, scenes: [
    { scene: 'fullscreen', start: 0, end: 1.013, caption: 'A' },
    { scene: 'fullscreen', start: 1.013, end: 2, caption: 'B' },
  ] });
  const original = structuredClone(brief);

  const audit = auditBriefTiming({ brief, transcript: [] });

  assert.equal(audit.errors.length, 0);
  assert.equal(audit.suggestions.length, 1);
  assert.deepEqual(audit.suggestions[0], {
    sceneIndex: 0,
    boundary: 'end',
    seconds: 1.013,
    frame: 25,
    suggestedSeconds: 1,
  });
  assert.deepEqual(brief, original);
});

test('does not suggest a boundary that already lands on a frame', () => {
  const audit = auditBriefTiming({
    brief: fixtureBrief({ fps: 25, scenes: [
      { scene: 'fullscreen', start: 0, end: 1, caption: 'A' },
      { scene: 'fullscreen', start: 1, end: 2, caption: 'B' },
    ] }),
    transcript: [],
  });

  assert.deepEqual(audit, { errors: [], warnings: [], suggestions: [] });
});
