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

  const audit = auditBriefTiming({ brief, words: [] });

  assert.equal(audit.errors.length, 0);
  assert.equal(audit.suggestions.length, 1);
  assert.deepEqual(audit.suggestions[0], {
    sceneIndex: 0,
    boundary: 'end',
    seconds: 1.013,
    frame: 25,
    suggestedSeconds: 1,
    reason: 'frame',
  });
  assert.deepEqual(brief, original);
});

test('suggests the off-frame final boundary of a single scene', () => {
  const audit = auditBriefTiming({
    brief: fixtureBrief({ fps: 25, scenes: [
      { scene: 'fullscreen', start: 0, end: 1.013, caption: 'A' },
    ] }),
    words: [],
  });

  assert.deepEqual(audit.suggestions, [{
    sceneIndex: 0,
    boundary: 'end',
    seconds: 1.013,
    frame: 25,
    suggestedSeconds: 1,
    reason: 'frame',
  }]);
});

test('does not suggest a boundary that already lands on a frame', () => {
  const audit = auditBriefTiming({
    brief: fixtureBrief({ fps: 25, scenes: [
      { scene: 'fullscreen', start: 0, end: 1, caption: 'A' },
      { scene: 'fullscreen', start: 1, end: 2, caption: 'B' },
    ] }),
    words: [],
  });

  assert.deepEqual(audit, { errors: [], warnings: [], suggestions: [] });
});

test('reports the nearest normalized word boundary with an explicit reason', () => {
  const brief = fixtureBrief({ fps: 25, scenes: [
    { scene: 'fullscreen', start: 0, end: 1.04, caption: 'A' },
    { scene: 'fullscreen', start: 1.04, end: 2, caption: 'B' },
  ] });
  const words = [
    { text: 'первая', start: 0.4, end: 0.9 },
    { text: 'вторая', start: 1.08, end: 1.5 },
  ];
  const originalBrief = structuredClone(brief);
  const originalWords = structuredClone(words);

  const audit = auditBriefTiming({ brief, words });

  assert.deepEqual(audit.suggestions, [{
    sceneIndex: 0,
    boundary: 'end',
    seconds: 1.04,
    suggestedSeconds: 1.08,
    reason: 'word',
  }]);
  assert.deepEqual(brief, originalBrief);
  assert.deepEqual(words, originalWords);
});

test('does not suggest an already word-aligned boundary and ignores malformed words', () => {
  const brief = fixtureBrief({ fps: 25, scenes: [
    { scene: 'fullscreen', start: 0, end: 1, caption: 'A' },
    { scene: 'fullscreen', start: 1, end: 2, caption: 'B' },
  ] });

  assert.deepEqual(auditBriefTiming({
    brief,
    words: [
      { text: 'первая', start: 0.5, end: 1 },
      { text: 'вторая', start: 1, end: 1.5 },
    ],
  }).suggestions, []);
  assert.deepEqual(auditBriefTiming({
    brief,
    words: [null, {}, { text: '', start: 0.9, end: 1.1 }, { text: 'bad', start: 'x', end: 1 }],
  }).suggestions, []);
  assert.deepEqual(auditBriefTiming({ brief, words: null }).suggestions, []);
});
